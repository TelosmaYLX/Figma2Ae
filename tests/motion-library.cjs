'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const preview = require('../client/motionPreview.js');
const scanner = require('../client/templateScanner.js');
const { files: distFiles, privacyIssues } = require('../scripts/package-dist.cjs');
const { start: startRelay } = require('../mcp/relay.cjs');
const catalog = require('../mcp/vendor/surehand/catalog.json');
const mcpDirectory = path.join(root, 'mcp');
const mcpRequire = createRequire(path.join(mcpDirectory, 'package.json'));
const { Client } = mcpRequire('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = mcpRequire('@modelcontextprotocol/sdk/client/stdio.js');

// Minimal ZIP builder (method 8 deflate) for self-contained MOGRT fixture tests
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, dataBuf] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(dataBuf);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, comp);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(dataBuf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length + comp.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

async function check() {
  const identifiers = [path.basename(os.homedir()), os.hostname()];

  // 1. Built-in motion library schema, hash, preview & privacy validation
  const builtinPath = path.join(root, 'motion-library/builtin.json');
  const builtinRaw = fs.readFileSync(builtinPath);
  assert.deepEqual(privacyIssues(builtinRaw, identifiers), [], 'builtin.json has no privacy leaks');
  const builtin = JSON.parse(builtinRaw.toString('utf8'));
  assert.equal(builtin.schemaVersion, 1);
  assert.ok(Array.isArray(builtin.presets) && builtin.presets.length >= 18, 'expected >= 18 procedural presets');
  assert.ok(Array.isArray(builtin.clips) && builtin.clips.length >= 40, 'expected >= 40 curated clips');

  const seenIds = new Set();
  for (const item of builtin.clips) {
    assert.equal(item.schemaVersion, 1);
    assert.match(item.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.ok(!seenIds.has(item.id), 'duplicate clip ID: ' + item.id);
    seenIds.add(item.id);
    const computed = createHash('sha256').update(JSON.stringify(item.clip), 'utf8').digest('hex');
    assert.equal(item.contentHash, computed, 'contentHash mismatch on ' + item.slug);
    assert.ok(item.clip.duration > 0);
    for (const layer of item.clip.layers) {
      for (const tr of layer.tracks) {
        for (let i = 0; i < tr.keys.length; i++) {
          const k = tr.keys[i];
          assert.ok(k.time >= 0 && k.time <= item.clip.duration + 1e-6);
          if (i > 0) assert.ok(k.time > tr.keys[i - 1].time, 'keys strictly ordered in ' + item.slug);
        }
        // House keyframe economy (motion-adaptation-rules §1.2): a single-direction move is 2 keys,
        // an overshoot or two-speed move 3. Only the intentional electronic flicker keeps more.
        const maxKeys = item.slug === 'curated-opacity-glitch-in' ? 8 : 3;
        assert.ok(tr.keys.length <= maxKeys, `${item.slug} ${tr.path[1][0]} has extra keyframes`);
        assert.equal(tr.keys[0].time, 0, `${item.slug} ${tr.path[1][0]} must start at 0s`);
        // A non-linear track is eased at both ends: no linear first key (it starts at full speed in
        // AE) and no linear landing key on an entrance/emphasis settle.
        const eased = tr.keys.some(k => k.inInterp === 'bezier' || k.outInterp === 'bezier');
        if (eased) {
          const first = tr.keys[0];
          assert.equal(first.inInterp, 'bezier', `${item.slug} ${tr.path[1][0]} first key in is not eased`);
          assert.equal(first.outInterp, 'bezier', `${item.slug} ${tr.path[1][0]} first key out is not eased`);
          assert.ok(first.inEase && first.inEase.length && first.outEase && first.outEase.length,
            `${item.slug} ${tr.path[1][0]} first key lacks temporal ease`);
        }
        if (item.phase === 'in' || item.phase === 'emphasis') {
          const last = tr.keys[tr.keys.length - 1];
          assert.equal(last.inInterp, 'bezier', `${item.slug} ${tr.path[1][0]} settle key in is not eased`);
          assert.ok(last.inEase && last.inEase.length, `${item.slug} ${tr.path[1][0]} settle key lacks inEase`);
        }
        for (const k of tr.keys) {
          for (const side of ['in', 'out']) {
            if (k[side + 'Interp'] !== 'bezier') continue;
            // The AE applier writes temporal ease only when both sides carry one.
            assert.ok(k.inEase && k.inEase.length && k.outEase && k.outEase.length,
              `${item.slug} ${tr.path[1][0]} bezier key needs inEase and outEase`);
          }
        }
        if (item.phase === 'out' && tr.path[1][0] === 'ADBE Position') {
          // Slide exits accelerate into the cut: their landing key keeps a linear incoming side.
          assert.equal(tr.keys[tr.keys.length - 1].inInterp, 'linear', `${item.slug} slide exit landing is not linear`);
        }
        if (item.slug.startsWith('curated-overshoot')) {
          // The overshoot key must pass the resting value along the travel direction.
          const start = tr.keys[0].value, last = tr.keys[tr.keys.length - 1].value;
          const travel = [last[0] - start[0], last[1] - start[1]];
          const length = Math.hypot(travel[0], travel[1]);
          const middle = tr.keys[1].value;
          const past = ((middle[0] - last[0]) * travel[0] + (middle[1] - last[1]) * travel[1]) / length;
          assert.ok(past > 0.01 * length, `${item.slug} overshoot never crosses its resting value`);
        }
      }
    }
    // Exercise preview evaluator across start / mid / end and curve sparkline
    const meta = preview.analyzeClip(item.clip, item.defaultAnchor);
    for (const frac of [0, 0.35, 0.7, 1]) {
      const st = preview.evaluateClipAt(item.clip, item.clip.duration * frac, item.defaultAnchor, meta);
      for (const field of ['dx', 'dy', 'scaleX', 'scaleY', 'rotate', 'opacity']) {
        assert.ok(Number.isFinite(st[field]), `${item.slug} ${field} is finite at ${frac}`);
      }
    }
    const svgPath = preview.buildCurveSvg(item);
    assert.match(svgPath, /^M[\d.-]+,[\d.-]+/, 'valid curve sparkline for ' + item.slug);
  }

  // Preview interpolation must mirror AE exactly for segments with one linear side: AE shapes the
  // segment with one cubic bezier whose linear-side handle sits at 1/6 (out) or 5/6 (in) with slope
  // 1. The expected samples below were measured in After Effects 26.0 (opacity 0 -> 100, 1 s).
  const mixedClip = (k0, k1) => ({ origin: 0, duration: 1, layers: [{ name: 'mixed', tracks: [{
    path: [['ADBE Transform Group', 1], ['ADBE Opacity', 1]], type: 'OneD', keys: [k0, k1] }] }] });
  const linearOut = mixedClip(
    { time: 0, value: 0, inInterp: 'linear', outInterp: 'linear' },
    { time: 1, value: 100, inInterp: 'bezier', outInterp: 'bezier', inEase: [{ speed: 0, influence: 85 }], outEase: [{ speed: 0, influence: 33.33 }] });
  const linearIn = mixedClip(
    { time: 0, value: 0, inInterp: 'bezier', outInterp: 'bezier', inEase: [{ speed: 0, influence: 33.33 }], outEase: [{ speed: 0, influence: 85 }] },
    { time: 1, value: 100, inInterp: 'linear', outInterp: 'linear' });
  const samples = [[0.1, 20.63], [0.25, 57.4], [0.5, 86.13], [0.75, 97.19], [0.9, 99.59]];
  for (const [clip, expected, label] of [[linearOut, samples, 'linear-out'], [linearIn, [[0.1, 0.41], [0.25, 2.81], [0.5, 13.87], [0.75, 42.6], [0.9, 79.37]], 'linear-in']]) {
    const meta = preview.analyzeClip(clip, 'end');
    for (const [u, want] of expected) {
      const got = preview.evaluateClipAt(clip, u, 'end', meta).opacity * 100;
      assert.ok(Math.abs(got - want) < 0.6, `${label} preview/AE parity at ${u}: got ${got}, want ${want}`);
    }
  }

  for (const preset of builtin.presets) {
    for (const u of [0, 0.5, 1]) {
      const res = preview.evaluatePresetAt(preset, { direction: 'left', style: 'spring' }, u);
      assert.ok(res && res.kind);
    }
    assert.match(preview.buildCurveSvg(preset), /^M[\d.-]+,[\d.-]+/);
  }

  // React Bits pack: text effects distilled from reactbits.dev plus synthesized content clips.
  const rbPresets = builtin.presets.filter(item => item.id.startsWith('preset-rb-'));
  assert.ok(rbPresets.length >= 11, 'expected the React Bits text preset pack');
  const rbTextStyles = new Set(['rise', 'fade', 'pop', 'blur', 'skewIn', 'riseBlur', 'focus', 'zoomIn', 'wave', 'float']);
  const rbTextEases = new Set(['power2Out', 'power3Out', 'power2InOut', 'expoOut', 'backOut', 'backInOut', 'wave']);
  for (const preset of rbPresets) {
    assert.equal(preset.command, 'text_reveal', preset.id + ' must be a text reveal');
    assert.ok(rbTextStyles.has(preset.defaults.style), preset.id + ' has an unknown text style');
    assert.ok(rbTextEases.has(preset.defaults.ease), preset.id + ' has an unknown text ease');
    assert.ok(!(preset.supports && preset.supports.style), preset.id + ' must lock its React Bits curve');
    assert.ok(preset.tags.includes('ReactBits'), preset.id + ' must be tagged ReactBits');
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const res = preview.evaluatePresetAt(preset, {}, u);
      assert.equal(res.kind, 'text', preset.id + ' previews as text');
      for (const ch of res.chars) {
        for (const field of ['dx', 'dy', 'scale', 'opacity']) {
          assert.ok(Number.isFinite(ch[field]), `${preset.id} ${field} is finite at ${u}`);
        }
      }
    }
  }
  // back.out overshoot: the pop preset starts collapsed and finishes at full scale.
  const rbPop = rbPresets.find(item => item.id === 'preset-rb-split-pop');
  for (const ch of preview.evaluatePresetAt(rbPop, {}, 0).chars) assert.ok(ch.scale < 0.05, 'pop starts at zero scale');
  for (const ch of preview.evaluatePresetAt(rbPop, {}, 1).chars) assert.ok(ch.opacity > 0.95, 'pop finishes opaque');
  const rbClips = ['rb-content-rise', 'rb-content-glide', 'rb-content-fade', 'rb-content-zoom', 'rb-content-focus', 'rb-back-pop', 'rb-exit-sink'];
  for (const slug of rbClips) {
    const clip = builtin.clips.find(item => item.slug === slug);
    assert.ok(clip, 'missing React Bits clip ' + slug);
    assert.equal(clip.sourceStyle, 'ReactBits');
  }
  // Verify Adobe CEP --mixed-context (both window AND module.exports exist in <script> tags)
  const cepWindow = {};
  const cepModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'client/motionPreview.js'), 'utf8'), {
    window: cepWindow, globalThis: cepWindow, module: cepModule, exports: cepModule.exports, Math, Array, Object, Number, String,
  });
  assert.equal(typeof cepWindow.F2AMotionPreview?.evaluateClipAt, 'function', 'CEP mixed-context must expose window.F2AMotionPreview');
  assert.equal(typeof cepModule.exports?.evaluateClipAt, 'function', 'CommonJS module.exports must also stay populated');
  console.log(`PASS: ${builtin.clips.length} curated clips + ${builtin.presets.length} procedural presets validated (hashes, preview, CEP mixed-context, privacy)`);

  // 2. ExtendScript ES3 safety & JSON polyfill check
  const engineSrc = fs.readFileSync(path.join(root, 'host/motion/motionEngine.jsx'), 'utf8');
  assert.doesNotMatch(engineSrc, /\b(?:const|let)\s+\w|=>/, 'motionEngine.jsx stays pure ES3 for AE ExtendScript');
  const sandbox = { JSON: undefined, Array, Object, String, Number, Math, RegExp, isFinite, Error };
  vm.runInNewContext(engineSrc, sandbox);
  assert.equal(typeof sandbox.JSON.stringify, 'function');
  assert.equal(typeof sandbox.JSON.parse, 'function');
  const sampleObj = { ok: true, name: '急停上滑 "测试"\n换行', nums: [0, 1.5, -20], empty: null };
  const serialized = sandbox.JSON.stringify(sampleObj);
  assert.deepEqual(JSON.parse(serialized), sampleObj);
  assert.deepEqual(JSON.parse(sandbox.JSON.stringify(sandbox.JSON.parse(serialized))), sampleObj);
  console.log('PASS: host/motion/motionEngine.jsx is ES3-clean and its JSON polyfill round-trips Unicode');

  // 3. Template pack scanner + MOGRT nested ZIP extractor + User clip CRUD
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'f2a-motion-test-'));
  try {
    // Build synthetic Titles Factory pack
    const tfProj = path.join(tmp, 'DemoPack', 'project');
    await fsp.mkdir(path.join(tfProj, 'Package', 'Bigtypo'), { recursive: true });
    await fsp.mkdir(path.join(tfProj, 'Images', 'Bigtypo'), { recursive: true });
    await fsp.mkdir(path.join(tfProj, 'Videos', 'Bigtypo'), { recursive: true });
    await fsp.mkdir(path.join(tfProj, 'ffx'), { recursive: true });
    await fsp.writeFile(path.join(tfProj, 'Package', 'Bigtypo', 'Demo-01.aep'), 'RIFXmock');
    await fsp.writeFile(path.join(tfProj, 'Images', 'Bigtypo', 'Demo-01.png'), 'PNGmock');
    await fsp.writeFile(path.join(tfProj, 'Videos', 'Bigtypo', 'Demo-01-A1-in.mp4'), 'MP4A1');
    await fsp.writeFile(path.join(tfProj, 'Videos', 'Bigtypo', 'Demo-01-A2-in.mp4'), 'MP4A2');
    await fsp.writeFile(path.join(tfProj, 'ffx', 'Glow.ffx'), 'RIFXffx');

    // Build synthetic MOGRT (nested ZIP: project.aegraphic -> inner .aep + thumb.png + thumb.mp4)
    const mogrtDir = path.join(tmp, 'UIPack', 'Elements');
    await fsp.mkdir(mogrtDir, { recursive: true });
    const innerAegraphic = makeZip([['Element 01.aep', Buffer.from('RIFXinnerAepData')]]);
    const mogrtZip = makeZip([
      ['thumb.png', Buffer.from('PNG_THUMB_DATA')],
      ['thumb.mp4', Buffer.from('MP4_VIDEO_DATA')],
      ['project.aegraphic', innerAegraphic],
    ]);
    const mogrtFile = path.join(mogrtDir, 'Element 01.mogrt');
    await fsp.writeFile(mogrtFile, mogrtZip);

    // Build synthetic standalone AEP with duplicate legacy copy
    const stDir = path.join(tmp, 'SpecialPack');
    await fsp.mkdir(stDir, { recursive: true });
    await fsp.writeFile(path.join(stDir, 'Special Titles.aep'), 'RIFXmain');
    await fsp.writeFile(path.join(stDir, 'Special Titles copy 17.x.aep'), 'RIFXdup');
    await fsp.writeFile(path.join(stDir, 'preview.mp4'), 'MP4prev');

    const scanned = scanner.scanTemplateDirectory(tmp);
    assert.equal(scanned.length, 4, 'Titles Factory aep + ffx + mogrt + main standalone aep (legacy copy skipped)');
    const tfItem = scanned.find(x => x.name === 'Demo-01');
    assert.ok(tfItem && tfItem.thumb && tfItem.variants.length === 2);
    const ffxItem = scanned.find(x => x.kind === 'ffx');
    assert.equal(ffxItem.name, 'Glow');
    const stItem = scanned.find(x => x.name === 'Special Titles');
    assert.ok(stItem && stItem.video && stItem.video.endsWith('preview.mp4'));

    const cacheDir = path.join(tmp, 'cache');
    const mPrev = scanner.ensureMogrtPreview(mogrtFile, cacheDir);
    assert.equal(fs.readFileSync(mPrev.thumb, 'utf8'), 'PNG_THUMB_DATA');
    assert.equal(fs.readFileSync(mPrev.video, 'utf8'), 'MP4_VIDEO_DATA');
    const extractedAep = scanner.extractMogrtAep(mogrtFile, cacheDir);
    assert.equal(fs.readFileSync(extractedAep, 'utf8'), 'RIFXinnerAepData');

    // Test user clip save, list, import, delete, and snapshot diffing
    const userLib = path.join(tmp, 'user-lib');
    const beforeSnap = {
      comp: 1, name: 'Main',
      layers: [{ id: 10, name: 'Card', omitted: [], tracks: [
        { path: [['ADBE Transform Group', 1], ['ADBE Opacity', 1]], type: 'OneD', keys: [], value: 100 },
      ] }],
    };
    const afterSnap = {
      comp: 1, name: 'Main',
      layers: [{ id: 10, name: 'Card', omitted: [], tracks: [
        {
          path: [['ADBE Transform Group', 1], ['ADBE Opacity', 1]], type: 'OneD',
          keys: [
            { time: 1.0, value: 0, inInterp: 'bezier', outInterp: 'bezier', inEase: [{ speed: 0, influence: 33.3 }], outEase: [{ speed: 0, influence: 33.3 }] },
            { time: 1.5, value: 100, inInterp: 'bezier', outInterp: 'bezier', inEase: [{ speed: 0, influence: 75 }], outEase: [{ speed: 0, influence: 33.3 }] },
          ],
        },
      ] }],
    };
    const built = scanner.makeClipFromSnapshots(afterSnap, beforeSnap);
    assert.equal(built.clip.duration, 0.5);
    const saved = scanner.saveUserClip('自定义卡片淡入', ['UI', '卡片'], built.clip, userLib);
    assert.equal(scanner.listUserClips(userLib).length, 1);

    // 4. Verify live MCP server sees BOTH user clip AND built-in curated clips
    const relay = startRelay({ port: 0, idleTimeout: 60000 });
    let capturedApplyJsx = '';
    const bridge = http.createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/health') {
        res.end(JSON.stringify({ name: 'aemcp-bridge', version: catalog.version, host: { appVersion: '26.0' } }));
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      capturedApplyJsx = JSON.parse(Buffer.concat(chunks).toString('utf8')).script;
      res.end(JSON.stringify({ ok: true, result: JSON.stringify({ ok: true, result: { steps: [{ ok: true, result: { tracks: 1 } }], failed: -1 }, logs: [] }) }));
    }).listen(0, '127.0.0.1');
    const client = new Client({ name: 'F2A Motion Lib Test', version: '1' });
    const firstText = r => r.content.find(v => v.type === 'text')?.text || '';

    try {
      await Promise.all([once(relay.server, 'listening'), once(bridge, 'listening')]);
      const cfg = path.join(tmp, 'surehand-cfg.json');
      await fsp.writeFile(cfg, JSON.stringify({ bridgePort: bridge.address().port, token: 'test' }));
      await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [path.join(mcpDirectory, 'server.cjs')],
        cwd: root,
        env: {
          F2A_MCP_PORT: String(relay.server.address().port),
          SUREHAND_AE_CONFIG: cfg,
          SUREHAND_AE_NO_AUTOSETUP: '1',
          SUREHAND_AE_NO_ACTIVITY_LOG: '1',
          F2A_MOTION_LIBRARY: userLib,
          NODE_PATH: '',
        },
      }));

      const listed = JSON.parse(firstText(await client.callTool({ name: 'ae_motion_list', arguments: {} })));
      assert.equal(listed.clips[0].id, saved.id, 'user clip listed first');
      assert.equal(listed.clips[0].source, 'user');
      const builtinListed = listed.clips.filter(c => c.source === 'builtin');
      assert.equal(builtinListed.length, builtin.clips.length, 'all built-in clips exposed via MCP ae_motion_list');

      const filtered = JSON.parse(firstText(await client.callTool({ name: 'ae_motion_list', arguments: { query: '过冲' } })));
      assert.ok(filtered.clips.length >= 4, 'query filters curated overshoot clips');

      // Apply an exit clip without passing position_anchor -> should auto-default to "start"
      const exitClip = builtin.clips.find(c => c.defaultAnchor === 'start');
      assert.ok(exitClip);
      const applyRes = await client.callTool({ name: 'ae_motion_apply', arguments: { clip_id: exitClip.id, comp_id: 1, layer_ids: [10] } });
      assert.equal(!!applyRes.isError, false, firstText(applyRes));
      assert.ok(capturedApplyJsx.includes('"position_anchor":"start"'), 'exit clip defaults anchor to start');
    } finally {
      await client.close();
      relay.server.closeAllConnections();
      bridge.closeAllConnections();
      await Promise.all([new Promise(r => relay.server.close(r)), new Promise(r => bridge.close(r))]);
    }

    scanner.deleteUserClip(saved.id, userLib);
    assert.equal(scanner.listUserClips(userLib).length, 0);
    console.log('PASS: template scanner, MOGRT ZIP extraction, user CRUD, and MCP builtin library sync');
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }

  // 5. Verify package-dist ships all new motion runtime files cleanly without privacy issues
  for (const required of [
    'client/motionPanel.js',
    'client/motionPreview.js',
    'client/templateScanner.js',
    'host/motion/motionEngine.jsx',
    'host/motion/aeMotionPresets.jsx',
    'motion-library/builtin.json',
  ]) {
    assert.ok(distFiles.includes(required), 'package-dist missing ' + required);
    const buf = fs.readFileSync(path.join(root, required));
    assert.deepEqual(privacyIssues(buf, identifiers), [], 'privacy leak in ' + required);
  }
  console.log('PASS: all new motion library files included in package-dist and privacy-clean');
}

check().catch(err => { console.error(err); process.exitCode = 1; });
