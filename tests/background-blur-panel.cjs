'use strict';

// Live-import plumbing for 「保留背景模糊」: the Figma ship keeps the adjustment-layer requests,
// the panel forwards them to the host as their own temp JSON, and the pre-export probe (bridge
// route /background-blur) reports whether the running AE session loaded the plug-in, copying the
// packaged .aex when it did not.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {harness} = require('./client-import-queue.cjs');

const REQUEST = {
  sourceId: 'card', name: '卡片 背景模糊', container: 'card-layer-precomp', z: 4,
  size: [160, 90], position: [120, 75], rotation: 0, scale: [100, 100],
  mask: {kind: 'path', d: 'M0 0H160V90H0Z', windingRule: 'NONZERO'},
  mode: 'progressive', radius: 16, startRadius: 0, endRadius: 16,
  startOffset: [0.5, 0], endOffset: [0.5, 1]
};

function ship(h, extra = {}) {
  return h.callbacks.onSvg('<svg width="10" height="10"></svg>', {
    name: '背景模糊画框', nodes: [{id: 'card', fills: [], strokes: []}], texts: [], effects: [],
    imageCount: 0, backgroundBlurs: [REQUEST], ...extra
  });
}

async function check() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f2a-blur-panel-'));
  const plugins = path.join(base, 'Plug-ins');
  fs.mkdirSync(plugins, {recursive: true});
  const previous = process.env.F2A_AE_PLUGINS;
  process.env.F2A_AE_PLUGINS = plugins;
  try {
    // Probe OK: the bridge reports the running session can use the effect.
    const live = harness({probeResult: 'OK'});
    ship(live);
    assert.equal(live.native.length, 1, live.messages.join(' | '));
    const job = live.native[0].job;
    assert.ok(job.backgroundBlursPath, 'the job carries the adjustment-layer request file');
    assert.deepEqual(JSON.parse(fs.readFileSync(job.backgroundBlursPath, 'utf8')), [REQUEST]);
    let probe = null;
    live.callbacks.onBackgroundBlur((error, status) => { if (error) throw error; probe = status; });
    assert.deepEqual(probe, {available: true, copied: false});
    live.finish();

    // Probe miss on a supported host: the packaged .aex is copied for the next AE start and the
    // running session is told to fall back to the baked picture.
    fs.rmSync(path.join(plugins, 'F2A'), {recursive: true, force: true});
    const restart = harness({probeResult: 'NO:25.0x...'});
    let after = null;
    restart.callbacks.onBackgroundBlur((error, status) => { if (error) throw error; after = status; });
    assert.equal(after.available, false);
    assert.equal(after.copied, true);
    assert.ok(fs.existsSync(path.join(plugins, 'F2A', 'FigmaBackgroundBlur.aex')),
      'the panel copies the packaged FigmaBackgroundBlur.aex');
    assert.match(after.reason, /重启/);

    // An AE older than CC 2019 cannot load the plug-in; copying it would be misleading.
    fs.rmSync(path.join(plugins, 'F2A'), {recursive: true, force: true});
    const old = harness({probeResult: 'NO:15.0x...'});
    let unsupported = null;
    old.callbacks.onBackgroundBlur((error, status) => { if (error) throw error; unsupported = status; });
    assert.equal(unsupported.available, false);
    assert.equal(unsupported.copied, false);
    assert.match(unsupported.reason, /2019/);
    assert.ok(!fs.existsSync(path.join(plugins, 'F2A')), 'an unsupported AE gets no plug-in copy');

    // Without the option there is no request file at all, and the import is unchanged.
    const plain = harness({probeResult: 'OK'});
    ship(plain, {backgroundBlurs: null});
    assert.equal(plain.native.length, 1);
    assert.equal(plain.native[0].job.backgroundBlursPath, '');
    plain.finish();

    console.log('PASS: live import forwards background-blur requests and probes/copies FigmaBackgroundBlur.aex');
  } finally {
    if (previous === undefined) delete process.env.F2A_AE_PLUGINS;
    else process.env.F2A_AE_PLUGINS = previous;
    fs.rmSync(base, {recursive: true, force: true});
  }
}

if (require.main === module) check().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = {check};
