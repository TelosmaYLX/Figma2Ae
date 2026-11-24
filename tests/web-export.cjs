'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {pathToFileURL} = require('node:url');
const {node, group, harness} = require('./export-options.cjs');
const {exportWeb} = require('../scripts/export-web.cjs');
const {start: startServer} = require('../scripts/aep-server.cjs');

const root = path.resolve(__dirname, '..');
const EDGE_EXE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

// Minimal pure-Node PNG encoder so tests generate crisp real RGBA PNGs with zero dependencies
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const head = Buffer.from(type, 'ascii');
  const body = Buffer.concat([head, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function makePng(width, height, pixelAt) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      const o = rowStart + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Decode simple 8-bit RGBA/RGB PNG screenshots from Edge CDP for real pixel assertions
function decodePng(buf) {
  assert.equal(buf.toString('ascii', 1, 4), 'PNG');
  let offset = 8, width = 0, height = 0, colorType = 6;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)];
    const row = inflated.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let val = row[i];
      if (filter === 1) val = (val + a) & 255;
      else if (filter === 2) val = (val + b) & 255;
      else if (filter === 3) val = (val + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
        val = (val + pr) & 255;
      }
      cur[i] = val;
    }
    cur.copy(prev);
    for (let x = 0; x < width; x++) {
      const s = x * bpp, d = (y * width + x) * 4;
      out[d] = cur[s];
      out[d + 1] = cur[s + 1];
      out[d + 2] = cur[s + 2];
      out[d + 3] = bpp === 4 ? cur[s + 3] : 255;
    }
  }
  return {
    width, height,
    at(x, y) {
      const o = (Math.floor(y) * width + Math.floor(x)) * 4;
      return [out[o], out[o + 1], out[o + 2], out[o + 3]];
    },
  };
}

const solid = (r, g, b, opacity = 1) => [{type: 'SOLID', visible: true, color: {r, g, b}, opacity}];

function at(layer, x, y, w = layer.width, h = layer.height, render = null) {
  layer.width = w; layer.height = h;
  layer.absoluteBoundingBox = {x, y, width: w, height: h};
  layer.absoluteRenderBounds = render || {x, y, width: w, height: h};
  layer.absoluteTransform = [[1, 0, x], [0, 1, y]];
  return layer;
}

function rectNode(name, x, y, w, h, extra = {}) {
  return at(node('RECTANGLE', name, {
    cornerRadius: extra.cornerRadius || 0,
    fillGeometry: [{data: `M0 0H${w}V${h}H0Z`, windingRule: 'NONZERO'}],
    fills: solid(0.2, 0.5, 0.9),
    ...extra,
  }), x, y, w, h, extra.render);
}

function buildDemoScene() {
  // 640x420 showcase canvas positioned at Figma offset (100, 50)
  const ox = 100, oy = 50;

  // 1. Gradient pill CTA button with inside stroke
  const gradBtn = rectNode('主按钮', ox + 40, oy + 40, 180, 52, {
    cornerRadius: 26,
    fills: [{
      type: 'GRADIENT_LINEAR', visible: true, opacity: 1,
      gradientTransform: [[1, 0, 0], [0, 1, 0]],
      gradientStops: [
        {position: 0, color: {r: 0.45, g: 0.35, b: 0.98, a: 1}},
        {position: 1, color: {r: 0.92, g: 0.32, b: 0.65, a: 1}},
      ],
    }],
    strokes: solid(1, 1, 1, 0.65),
    strokeWeight: 2,
    strokeAlign: 'INSIDE',
  });

  // 2. Plain editable text on button + rich multi-segment text + gradient text
  const btnText = at(node('TEXT', '按钮文案', {
    characters: '立即体验',
    fontSize: 18,
    fontName: {family: 'Microsoft YaHei', style: 'Bold'},
    textAlignHorizontal: 'CENTER',
    fills: solid(1, 1, 1),
    lineHeight: {unit: 'PIXELS', value: 24},
  }), ox + 60, oy + 54, 140, 24);

  const richText = at(node('TEXT', '富文本标题', {
    characters: 'F2A Web',
    fontSize: 32,
    fontName: {family: 'Segoe UI', style: 'Bold'},
    fills: solid(1, 1, 1),
    getStyledTextSegments: () => [
      {characters: 'F2A ', fontName: {family: 'Segoe UI', style: 'Bold'}, fontSize: 32, fills: solid(0.65, 0.55, 1), textCase: 'ORIGINAL', letterSpacing: {unit: 'PIXELS', value: 1}, lineHeight: {unit: 'PIXELS', value: 40}},
      {characters: 'Web', fontName: {family: 'Segoe UI', style: 'Regular'}, fontSize: 32, fills: solid(0.95, 0.95, 0.98), textCase: 'ORIGINAL', letterSpacing: {unit: 'PIXELS', value: 0}, lineHeight: {unit: 'PIXELS', value: 40}},
    ],
  }), ox + 40, oy + 112, 200, 40);

  // 3. Clipped rounded card with overflowing bright red child (must be clipped at card edge!)
  const overflowChild = rectNode('溢出子块', ox + 320, oy + 60, 120, 60, {
    fills: solid(1, 0, 0),
  });
  const clipCard = at(node('FRAME', '裁剪卡片', {
    clipsContent: true,
    cornerRadius: 16,
    fills: solid(0.16, 0.18, 0.24),
    fillGeometry: [{data: 'M0 0H140V100H0Z', windingRule: 'NONZERO'}],
    strokes: solid(0.35, 0.4, 0.55),
    strokeWeight: 2,
    strokeAlign: 'OUTSIDE',
    children: [overflowChild],
  }), ox + 260, oy + 40, 140, 100);

  // 4. Vector ALPHA mask group (circle mask over green square)
  const alphaMaskShape = at(node('ELLIPSE', '圆形蒙版', {
    isMask: true,
    maskType: 'ALPHA',
    fillGeometry: [{data: 'M40 0C62.0914 0 80 17.9086 80 40C80 62.0914 62.0914 80 40 80C17.9086 80 0 62.0914 0 40C0 17.9086 17.9086 0 40 0Z', windingRule: 'NONZERO'}],
    fills: solid(1, 1, 1),
  }), ox + 440, oy + 40, 80, 80);
  const alphaMaskedArt = rectNode('蒙版内容', ox + 440, oy + 40, 80, 80, {
    fills: solid(0.1, 0.85, 0.45),
  });
  const maskGroup = at(node('GROUP', '蒙版组', {children: [alphaMaskShape, alphaMaskedArt]}), ox + 440, oy + 40, 80, 80);

  // 5. Vector LUMINANCE mask group (50% gray mask over pure white square -> dims to ~50% alpha)
  const lumaMaskShape = rectNode('亮度蒙版', ox + 540, oy + 40, 60, 60, {
    isMask: true,
    maskType: 'LUMINANCE',
    fills: solid(0.5, 0.5, 0.5),
  });
  const lumaMaskedArt = rectNode('亮度内容', ox + 540, oy + 40, 60, 60, {
    fills: solid(1, 1, 1),
  });
  const lumaGroup = at(node('GROUP', '亮度蒙版组', {children: [lumaMaskShape, lumaMaskedArt]}), ox + 540, oy + 40, 60, 60);

  // 6. Multiply blend inside PASS_THROUGH group over bright yellow backdrop
  const yellowBackdrop = rectNode('黄色底板', ox + 40, oy + 190, 100, 80, {
    fills: solid(1, 1, 0),
  });
  const cyanMultiply = rectNode('正片叠底块', ox + 60, oy + 210, 60, 40, {
    fills: solid(0, 1, 1),
    blendMode: 'MULTIPLY',
  });
  const blendGroup = at(node('GROUP', '混合分组', {blendMode: 'PASS_THROUGH', children: [cyanMultiply]}), ox + 60, oy + 210, 60, 40);

  // 7. Image fill with rounded matte + live Figma color grading (exposure +0.8)
  const gradedPhoto = rectNode('调色图片', ox + 170, oy + 190, 90, 90, {
    cornerRadius: 12,
    fills: [{
      type: 'IMAGE', visible: true, opacity: 1, scaleMode: 'FILL', imageHash: 'photo-hash',
      filters: {exposure: 0.8, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0},
    }],
  });

  // 8. Dashed Bezier curve + Outside stroke
  const bezierWave = at(node('VECTOR', '曲线波形', {
    fillGeometry: [],
    strokeGeometry: [],
    vectorPaths: [{data: 'M0 40 C30 0 70 80 100 40', windingRule: 'NONZERO'}],
    fills: [],
    strokes: solid(0.25, 0.85, 0.98),
    strokeWeight: 4,
    strokeCap: 'ROUND',
    dashPattern: [10, 6],
  }), ox + 290, oy + 195, 100, 80);

  // 9. Frosted glass card with native CSS BACKGROUND_BLUR & DROP_SHADOW over a sharp half-orange/half-blue backdrop
  const glassUnderLeft = rectNode('毛玻璃底色左', ox + 450, oy + 205, 60, 60, {
    fills: solid(1, 0.35, 0.1),
  });
  const glassUnderRight = rectNode('毛玻璃底色右', ox + 510, oy + 205, 60, 60, {
    fills: solid(0.1, 0.45, 1),
  });
  const glassCard = rectNode('毛玻璃卡片', ox + 420, oy + 190, 180, 90, {
    cornerRadius: 14,
    fills: solid(1, 1, 1, 0.16),
    strokes: solid(1, 1, 1, 0.3),
    strokeWeight: 1,
    strokeAlign: 'INSIDE',
    effects: [
      {type: 'BACKGROUND_BLUR', visible: true, radius: 16},
      {type: 'DROP_SHADOW', visible: true, color: {r: 0, g: 0, b: 0, a: 0.4}, offset: {x: 0, y: 8}, radius: 16, spread: 0},
    ],
  });

  // 10. Hidden interactive state badge (can be revealed by F2A.setState)
  const hiddenBadge = rectNode('隐藏提示', ox + 40, oy + 310, 140, 40, {
    visible: false,
    cornerRadius: 8,
    fills: solid(0.15, 0.8, 0.45),
  });

  // 11. Duplicate named pills to verify F2A.layers('圆点')
  const dot1 = at(node('ELLIPSE', '圆点', {
    fillGeometry: [{data: 'M10 0C15.5228 0 20 4.47715 20 10C20 15.5228 15.5228 20 10 20C4.47715 20 0 15.5228 0 10C0 4.47715 4.47715 0 10 0Z', windingRule: 'NONZERO'}],
    fills: solid(0.95, 0.75, 0.2),
  }), ox + 220, oy + 320, 20, 20);
  const dot2 = at(node('ELLIPSE', '圆点', {
    fillGeometry: [{data: 'M10 0C15.5228 0 20 4.47715 20 10C20 15.5228 15.5228 20 10 20C4.47715 20 0 15.5228 0 10C0 4.47715 4.47715 0 10 0Z', windingRule: 'NONZERO'}],
    fills: solid(0.95, 0.45, 0.35),
  }), ox + 252, oy + 320, 20, 20);

  const rootFrame = at(node('FRAME', '互动演示页', {
    clipsContent: true,
    fills: solid(0.08, 0.09, 0.13),
    fillGeometry: [{data: 'M0 0H640V420H0Z', windingRule: 'NONZERO'}],
    children: [
      gradBtn, btnText, richText, clipCard, maskGroup, lumaGroup,
      yellowBackdrop, blendGroup, gradedPhoto, bezierWave,
      glassUnderLeft, glassUnderRight, glassCard,
      hiddenBadge, dot1, dot2,
    ],
  }), ox, oy, 640, 420);

  return rootFrame;
}

function collectShipImages(messages) {
  const chunks = new Map();
  for (const m of messages) {
    if (m.type !== 'image-chunk') continue;
    if (m.seq === 0) chunks.set(m.index, {meta: m.meta, parts: []});
    chunks.get(m.index).parts.push(m.dataPart);
  }
  return [...chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => ({...v.meta, data: v.parts.join('')}));
}

async function testBrowserRendering(entryHtml, screenshotPath, options = {}) {
  const expectAnimations = options.animations !== false;
  if (!fs.existsSync(EDGE_EXE)) {
    console.log('SKIP browser check: msedge.exe not found');
    return;
  }
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'f2a-web-edge-'));
  const child = spawn(EDGE_EXE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', '--remote-allow-origins=*', '--user-data-dir=' + profile, 'about:blank',
  ], {windowsHide: true, stdio: 'ignore'});
  let socket;
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      try { port = (await fsp.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; }
      catch { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.ok(port, 'Headless Edge did not start');
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
    socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });

    let seq = 0;
    const pending = new Map();
    const events = new Map();
    const pageErrors = [];
    socket.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else {
        if (m.method === 'Runtime.exceptionThrown') pageErrors.push(JSON.stringify(m.params.exceptionDetails));
        if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') pageErrors.push(m.params.entry.text);
        if (events.has(m.method)) events.get(m.method)(m);
      }
    };
    const cmd = async (method, params = {}) => {
      const id = ++seq;
      const done = new Promise(r => pending.set(id, r));
      socket.send(JSON.stringify({id, method, params}));
      const res = await done;
      if (res.error) throw new Error(JSON.stringify(res.error));
      return res.result;
    };

    await cmd('Page.enable');
    await cmd('Runtime.enable');
    await cmd('Log.enable');
    // Render at exact 1:1 stage dimensions (640x420) so screen coordinates === canvas coordinates
    await cmd('Emulation.setDeviceMetricsOverride', {width: 640, height: 420, deviceScaleFactor: 1, mobile: false});
    const loaded = new Promise(r => events.set('Page.loadEventFired', r));
    await cmd('Page.navigate', {url: pathToFileURL(entryHtml).href});
    await loaded;

    const evalJs = async expr => {
      const r = await cmd('Runtime.evaluate', {expression: expr, awaitPromise: true, returnByValue: true});
      if (r.exceptionDetails) throw new Error('Page eval failed: ' + JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };

    const inspection = await evalJs(`(async function(){
      await document.fonts.ready;
      await window.F2A.ready;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      function rectOf(query) {
        const el = window.F2A.layer(query);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left, y: b.top, w: b.width, h: b.height, minimal: el.getAttribute('data-minimal') === 'true' };
      }
      const gradedImg = window.F2A.layer('调色图片').querySelector('img');
      const glassEl = window.F2A.layer('毛玻璃卡片').querySelector('[data-layer-kind="shape"]');
      return {
        scale: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--f2a-scale')),
        stage: { w: document.getElementById('f2a-stage').getBoundingClientRect().width, h: document.getElementById('f2a-stage').getBoundingClientRect().height },
        btn: rectOf('主按钮'),
        clipCard: rectOf('裁剪卡片'),
        dotsCount: window.F2A.layers('圆点').length,
        minimalCount: window.F2A.minimalLayers().length,
        hiddenDisplay: getComputedStyle(window.F2A.layer('隐藏提示')).display,
        gradedDone: gradedImg ? gradedImg.getAttribute('data-graded') === 'true' : false,
        glassBackdrop: glassEl ? getComputedStyle(glassEl).backdropFilter : '',
        hasRef: !!document.querySelector('.f2a-reference')
      };
    })()`);

    assert.equal(pageErrors.length, 0, 'Exported page must have zero runtime errors over file:///: ' + pageErrors.join('; '));
    assert.equal(inspection.scale, 1);
    assert.deepEqual(inspection.stage, {w: 640, h: 420});
    assert.ok(inspection.btn && inspection.btn.minimal);
    assert.ok(Math.abs(inspection.btn.x - 40) < 0.5 && Math.abs(inspection.btn.y - 40) < 0.5, JSON.stringify(inspection.btn));
    assert.ok(Math.abs(inspection.btn.w - 180) < 0.5 && Math.abs(inspection.btn.h - 52) < 0.5, JSON.stringify(inspection.btn));
    assert.equal(inspection.dotsCount, 2, 'Duplicate-named layers are both queryable');
    assert.ok(inspection.minimalCount >= 10, 'Every standalone layer is wrapped as a minimal layer');
    assert.equal(inspection.hiddenDisplay, 'none', 'Hidden layer stays hidden by default');
    assert.equal(inspection.gradedDone, true, 'Live Figma image grading must succeed over file:///');
    assert.match(inspection.glassBackdrop, /blur\(8px\)/, 'BACKGROUND_BLUR radius 16 maps to CSS backdrop-filter: blur(8px)');
    assert.equal(inspection.hasRef, true);

    // Capture 1:1 rendered PNG and verify REAL PIXEL COLORS!
    const shot = await cmd('Page.captureScreenshot', {format: 'png'});
    const pngBuf = Buffer.from(shot.data, 'base64');
    if (screenshotPath) {
      await fsp.mkdir(path.dirname(screenshotPath), {recursive: true});
      await fsp.writeFile(screenshotPath, pngBuf);
    }
    const img = decodePng(pngBuf);

    // 1. Frame background pixel at (10, 10): rgb(20, 23, 33)
    const bgPx = img.at(10, 10);
    assert.ok(Math.abs(bgPx[0] - 20) <= 2 && Math.abs(bgPx[1] - 23) <= 2 && Math.abs(bgPx[2] - 33) <= 2, 'Background pixel: ' + bgPx);

    // 2. Gradient button shifts from purple-blue on left (x=55, y=66) to pink-magenta on right (x=205, y=66)
    const btnL = img.at(55, 66), btnR = img.at(205, 66);
    assert.ok(btnL[2] > btnL[0] + 40, 'Left of gradient button is bluish-purple: ' + btnL);
    assert.ok(btnR[0] > btnR[2] + 30, 'Right of gradient button is pinkish-magenta: ' + btnR);

    // 3. Clipped card: outside stroke visible at (259, 90); inside card (360, 90) is red child; outside card right edge (415, 90) is clipped to background!
    const clipStroke = img.at(259, 90);
    const clipInside = img.at(360, 90);
    const clipOutside = img.at(415, 90);
    assert.ok(clipStroke[2] > 110 && clipStroke[0] > 70, 'Clipped frame preserves its own OUTSIDE stroke: ' + clipStroke);
    assert.ok(clipInside[0] > 230 && clipInside[1] < 20, 'Child visible inside clipped card: ' + clipInside);
    assert.ok(Math.abs(clipOutside[0] - bgPx[0]) <= 3 && Math.abs(clipOutside[1] - bgPx[1]) <= 3, 'Overflowing child clipped outside card: ' + clipOutside);

    // 4. Vector ALPHA circle mask at (440..520, 40..120): center (480, 80) is green, top-left corner (443, 43) outside circle is background!
    const maskCenter = img.at(480, 80);
    const maskCorner = img.at(443, 43);
    assert.ok(maskCenter[1] > 190 && maskCenter[0] < 50, 'Inside alpha circle mask is green: ' + maskCenter);
    assert.ok(Math.abs(maskCorner[0] - bgPx[0]) <= 3 && Math.abs(maskCorner[1] - bgPx[1]) <= 3, 'Outside alpha circle mask is clipped: ' + maskCorner);

    // 5. Vector LUMINANCE 50% gray mask over white square at (540..600, 40..100): blended ~50% white over dark bg (~135..145)
    const lumaPx = img.at(570, 70);
    assert.ok(lumaPx[0] > 110 && lumaPx[0] < 170 && Math.abs(lumaPx[0] - lumaPx[1]) <= 12, 'Luminance mask halves alpha: ' + lumaPx);

    // 6. MULTIPLY blend pass-through: cyan (0,255,255) multiplied over yellow (255,255,0) => pure GREEN (0,255,0)!
    const mulPx = img.at(90, 230);
    assert.ok(mulPx[0] < 10 && mulPx[1] > 240 && mulPx[2] < 10, 'MULTIPLY through PASS_THROUGH group yields green: ' + mulPx);

    // 7. Live Figma image grading (exposure +0.8 on mid-gray 128,128,128 -> significantly brighter!)
    const gradePx = img.at(215, 235);
    assert.ok(gradePx[0] > 200 && gradePx[1] > 200 && gradePx[2] > 200, 'Live exposure +0.8 brightens mid-gray photo: ' + gradePx);

    // 7b. Frosted glass card truly blurs the sharp orange/blue seam at x=510 (pixel right at seam mixes BOTH red & blue!)
    const seamPx = img.at(510, 235);
    assert.ok(seamPx[0] > 110 && seamPx[2] > 110, 'backdrop-filter blurs sharp orange/blue seam behind frosted glass: ' + seamPx);

    // 8. Verify runtime APIs & Inspector HUD in live browser!
    if (expectAnimations) {
      const runtimeTest = await evalJs(`(async function(){
        let clicks = 0;
        const off = window.F2A.on('主按钮', 'click', () => { clicks++; });
        window.F2A.layer('主按钮').click();
        off();
        window.F2A.layer('主按钮').click();

        // Reveal hidden layer and move it via F2A.setState
        window.F2A.setState('隐藏提示', { visible: true, x: 20, y: -10, scale: 1.1 });
        await new Promise(r => requestAnimationFrame(r));
        const badgeEl = window.F2A.layer('隐藏提示');
        const badgeVisible = getComputedStyle(badgeEl).display !== 'none';
        const badgeTransform = getComputedStyle(badgeEl).transform;

        // Run declarative timeline with WAAPI
        const tl = window.F2A.timeline([
          { target: '主按钮', preset: 'popIn', at: 0, duration: 40 },
          { target: '圆点', preset: 'fadeIn', at: 10, duration: 40, stagger: 10 },
        ]);
        await tl.finished;

        // Toggle inspector via Shift+I
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'I', shiftKey: true }));
        const inspectorOpen = !document.querySelector('.f2a-inspector').hidden;
        const hasDemoBtn = Array.from(document.querySelectorAll('.f2a-inspector button')).some(b => b.textContent === '演示入场');
        return { clicks, badgeVisible, badgeTransform, animCount: tl.animations.length, inspectorOpen, hasDemoBtn };
      })()`);

      assert.equal(runtimeTest.clicks, 1, 'F2A.on fires and unsubscribe removes listener');
      assert.equal(runtimeTest.badgeVisible, true, 'F2A.setState can reveal hidden layers');
      assert.ok(runtimeTest.badgeTransform && runtimeTest.badgeTransform !== 'none', 'F2A.setState applies CSS transform');
      assert.equal(runtimeTest.animCount, 3, 'Timeline animated 主按钮 + 2 圆点');
      assert.equal(runtimeTest.inspectorOpen, true, 'Shift+I toggles built-in Inspector HUD');
      assert.equal(runtimeTest.hasDemoBtn, true, 'Animations mode includes 演示入场 inspector button');
    } else {
      const staticTest = await evalJs(`(async function(){
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'I', shiftKey: true }));
        const inspectorOpen = !document.querySelector('.f2a-inspector').hidden;
        const hasDemoBtn = Array.from(document.querySelectorAll('.f2a-inspector button')).some(b => b.textContent === '演示入场');
        return {
          hasAnimate: typeof window.F2A.animate === 'function',
          hasTimeline: typeof window.F2A.timeline === 'function',
          inspectorOpen,
          hasDemoBtn,
        };
      })()`);
      assert.equal(staticTest.hasAnimate, false, 'Default static export omits F2A.animate');
      assert.equal(staticTest.hasTimeline, false, 'Default static export omits F2A.timeline');
      assert.equal(staticTest.inspectorOpen, true, 'Static export keeps Inspector HUD');
      assert.equal(staticTest.hasDemoBtn, false, 'Static export omits 演示入场 inspector button');
    }

    // Capture a second screenshot with Inspector HUD + Layer Outlines active!
    if (screenshotPath) {
      await evalJs(`(async function(){
        document.querySelectorAll('.f2a-inspector button').forEach(b => { if (b.textContent === '图层框') b.click(); });
        await new Promise(r => requestAnimationFrame(r));
      })()`);
      const hudShot = await cmd('Page.captureScreenshot', {format: 'png'});
      await fsp.writeFile(screenshotPath.replace(/\.png$/, '-inspector.png'), Buffer.from(hudShot.data, 'base64'));
    }

    assert.equal(pageErrors.length, 0, 'No page errors after interactions: ' + pageErrors.join('; '));
  } finally {
    socket?.close();
    child.kill();
    for (let i = 0; i < 20; i++) {
      try { await fsp.rm(profile, {recursive: true, force: true}); break; }
      catch { await new Promise(r => setTimeout(r, 150)); }
    }
  }
}

async function testServerAndUi(packet) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'f2a-web-srv-'));
  const openedDirs = [];
  const openedPreviews = [];
  const choices = [path.join(tempRoot, '导出网页'), path.join(tempRoot, '导出动效网页'), null];
  const server = startServer({
    port: 0,
    quiet: true,
    tempRoot,
    chooseWebDestination: async () => choices.shift(),
    openDirectory: async dir => { openedDirs.push(dir); },
    openPreview: async file => { openedPreviews.push(file); },
  });
  await once(server, 'listening');
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const health = await (await fetch(base + '/health')).json();
    assert.equal(health.webExport, true);

    // Default export: static HTML without animations.js
    const exported = await (await fetch(base + '/export-web', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({packet}),
    })).json();
    assert.ok(exported.exportId && exported.entry.endsWith('index.html'));
    assert.equal(exported.animations, false);
    assert.equal(fs.existsSync(exported.entry), true);
    assert.equal(fs.existsSync(path.join(exported.directory, 'style.css')), true);
    assert.equal(fs.existsSync(path.join(exported.directory, 'main.js')), true);
    assert.equal(fs.existsSync(path.join(exported.directory, 'animations.js')), false);
    assert.equal(fs.existsSync(path.join(exported.directory, 'layers.json')), true);

    // Opt-in animations export: includes animations.js
    const animated = await (await fetch(base + '/export-web', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({packet: {...packet, webAnimations: true}}),
    })).json();
    assert.equal(animated.animations, true);
    assert.equal(fs.existsSync(path.join(animated.directory, 'animations.js')), true);

    const openDirRes = await fetch(base + '/open-directory', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({exportId: exported.exportId}),
    });
    assert.equal(openDirRes.status, 200);
    assert.deepEqual(openedDirs, [exported.directory]);

    const openPreviewRes = await fetch(base + '/open-preview', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({exportId: exported.exportId}),
    });
    assert.equal(openPreviewRes.status, 200);
    assert.deepEqual(openedPreviews, [exported.entry]);

    const cancelled = await (await fetch(base + '/export-web', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({packet}),
    })).json();
    assert.equal(cancelled.cancelled, true);

    // Exercise actual figma-plugin/ui.html #export-web + #open-web-preview flow
    const html = fs.readFileSync(path.join(root, 'figma-plugin/ui.html'), 'utf8');
    const runUi = async (hasWebExport, enableAnimations = false) => {
      const elements = {}, posts = [], requests = [];
      for (const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
        elements[m[1]] = {checked: /\bchecked\b/.test(m[0]), disabled: /\bdisabled\b/.test(m[0]), hidden: /\bhidden\b/.test(m[0])};
      }
      assert.equal(elements['web-animations'].checked, false, 'HTML animations option defaults to unchecked');
      elements['web-animations'].checked = enableAnimations;
      elements['raster-scale'].value = '1';
      elements['native-image-masks'].value = 'separate';
      elements['text-mode'].value = 'vector';
      elements['aep-version'].value = '26.0';
      elements['aep-duration'].value = '10';
      elements['aep-fps'].value = '30';
      const window = {};
      const ctx = vm.createContext({
        window,
        document: {getElementById: id => elements[id]},
        Date, setTimeout() {},
        WebSocket: function () { this.readyState = 0; this.send = () => {}; },
        fetch: async (url, options) => {
          requests.push({url, options});
          if (url.endsWith('/health')) {
            return {ok: true, json: async () => ({service: 'f2a-aep', version: 3, aeVersions: ['26.0'], preserveImageFilters: true, singleLayerLabel: true, webExport: hasWebExport})};
          }
          if (url.endsWith('/export-web')) {
            return {ok: true, json: async () => ({directory: 'D:\\WebOut', entry: 'D:\\WebOut\\index.html', exportId: 'web-1', warnings: []})};
          }
          if (url.endsWith('/open-preview')) {
            return {ok: true, json: async () => ({ok: true})};
          }
          throw new Error('Unexpected fetch: ' + url);
        },
        parent: {
          postMessage({pluginMessage: message}) {
            posts.push(message);
            if (message.type !== 'ship-selection') return;
            assert.equal(message.target, 'web');
            window.onmessage({data: {pluginMessage: {...packet, type: 'ship', imageCount: 0}}});
            window.onmessage({data: {pluginMessage: {type: 'export-state', busy: false}}});
          },
        },
      });
      vm.runInContext(html.match(/<script>([\s\S]*)<\/script>/)[1], ctx);
      window.onmessage({data: {pluginMessage: {type: 'selection', count: 1, workspacePlugin: true}}});
      assert.equal(elements['export-web'].disabled, false);
      elements['export-web'].onclick();
      for (let i = 0; i < 200 && ctx.aepBusy; i++) await new Promise(setImmediate);
      return {elements, posts, requests, ctx};
    };

    const stale = await runUi(false);
    assert.equal(stale.posts.filter(m => m.type === 'ship-selection').length, 0);
    assert.match(stale.elements.msg.textContent, /导出 HTML 网页需要更新.*--workspace/);

    const ok = await runUi(true, false);
    const exportReq = ok.requests.find(r => r.url.endsWith('/export-web'));
    assert.ok(exportReq);
    assert.equal(JSON.parse(exportReq.options.body).packet.webAnimations, false);
    assert.equal(ok.elements['open-aep-folder'].hidden, false);
    assert.equal(ok.elements['open-web-preview'].hidden, false);
    assert.match(ok.elements.msg.textContent, /已导出网页到 D:\\WebOut/);
    ok.elements['open-web-preview'].onclick();
    for (let i = 0; i < 40 && ok.ctx.openingPreview; i++) await new Promise(setImmediate);
    assert.ok(ok.requests.some(r => r.url.endsWith('/open-preview')));

    const okAnim = await runUi(true, true);
    const animReq = okAnim.requests.find(r => r.url.endsWith('/export-web'));
    assert.ok(animReq);
    assert.equal(JSON.parse(animReq.options.body).packet.webAnimations, true);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fsp.rm(tempRoot, {recursive: true, force: true});
  }
}

async function testFidelitySuite() {
  const rectPath = (w, h2) => `M 0 0 L ${w} 0 L ${w} ${h2} L 0 ${h2} Z`;

  // 1. Elliptical radial gradient centered at (0.5, 0.5): bright yellow center -> dark blue edge
  const radialRect = rectNode('径向渐变', 20, 20, 120, 80, {
    fills: [{
      type: 'GRADIENT_RADIAL', visible: true, opacity: 1,
      gradientTransform: [[1, 0, 0], [0, 1, 0]],
      gradientStops: [
        {position: 0, color: {r: 1, g: 0.95, b: 0.1, a: 1}},
        {position: 1, color: {r: 0.05, g: 0.1, b: 0.7, a: 1}},
      ],
    }],
  });

  // 2. Gradient rectangle with SVG INNER_SHADOW (top dark inset glow)
  const innerShadowRect = rectNode('内阴影渐变', 160, 20, 100, 80, {
    fills: [{
      type: 'GRADIENT_LINEAR', visible: true, opacity: 1,
      gradientTransform: [[1, 0, 0], [0, 1, 0]],
      gradientStops: [
        {position: 0, color: {r: 0.95, g: 0.95, b: 0.98, a: 1}},
        {position: 1, color: {r: 0.85, g: 0.88, b: 0.95, a: 1}},
      ],
    }],
    effects: [{type: 'INNER_SHADOW', visible: true, color: {r: 0, g: 0, b: 0, a: 0.9}, offset: {x: 0, y: 12}, radius: 4, spread: 0}],
  });

  // 3. Mixed 4-corner radii clipped frame
  const mixedClip = at(node('FRAME', '异形圆角框', {
    clipsContent: true,
    topLeftRadius: 24, topRightRadius: 2, bottomRightRadius: 24, bottomLeftRadius: 2,
    fills: solid(0.25, 0.3, 0.45),
    fillGeometry: [{data: rectPath(110, 80), windingRule: 'NONZERO'}],
    children: [],
  }), 280, 20, 110, 80);

  // 4. Vertically centered + underlined + auto line-height editable text (box height 60, single line 16px)
  const vCenterText = at(node('TEXT', '居中文字', {
    characters: 'Centered Label', fontSize: 16, fontName: {family: 'Segoe UI', style: 'SemiBold'},
    textAlignHorizontal: 'CENTER', textAlignVertical: 'CENTER', textAutoResize: 'NONE',
    textDecoration: 'UNDERLINE', lineHeight: {unit: 'AUTO'},
    fills: solid(1, 1, 1),
  }), 20, 120, 160, 60);

  // 5. Rotated editable text (30 deg) — AABB is much larger than unrotated lw=120, lh=24!
  const rad = 30 * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const rotText = at(node('TEXT', '旋转文字', {
    characters: 'Rotated 30', fontSize: 16, fontName: {family: 'Segoe UI', style: 'Bold'},
    textAlignHorizontal: 'LEFT', textAlignVertical: 'CENTER', textAutoResize: 'WIDTH_AND_HEIGHT',
    lineHeight: {unit: 'PIXELS', value: 24},
    fills: solid(0.9, 0.85, 0.3),
  }), 200, 130, 120, 24);
  rotText.absoluteTransform = [[cos, -sin, 210], [sin, cos, 140]];
  rotText.absoluteBoundingBox = {x: 198, y: 140, width: 116, height: 81};
  rotText.absoluteRenderBounds = {x: 198, y: 140, width: 116, height: 81};

  // 6. Gradient text with OUTSIDE stroke (must emit layered .f2a-text-stack / .f2a-text-stroke!)
  const gradStrokeText = at(node('TEXT', '渐变描边字', {
    characters: 'GOLD TITLE', fontSize: 24, fontName: {family: 'Segoe UI', style: 'Heavy'},
    textAlignHorizontal: 'LEFT', textAlignVertical: 'BOTTOM', textAutoResize: 'NONE',
    textTruncation: 'ENDING', maxLines: 1, lineHeight: {unit: 'PIXELS', value: 28},
    fills: [{
      type: 'GRADIENT_LINEAR', visible: true, opacity: 1,
      gradientTransform: [[0, 1, 0], [-1, 0, 1]],
      gradientStops: [
        {position: 0, color: {r: 1, g: 0.95, b: 0.5, a: 1}},
        {position: 1, color: {r: 0.9, g: 0.5, b: 0.1, a: 1}},
      ],
    }],
    strokes: solid(0.2, 0.1, 0),
    strokeWeight: 2, strokeAlign: 'OUTSIDE',
  }), 20, 210, 180, 36);

  // 7. Mixed NONZERO + EVENODD multi-path vector shape
  const mixedWinding = at(node('VECTOR', '混合绕向', {
    fills: solid(0.2, 0.9, 0.6),
    fillGeometry: [
      {data: 'M 0 0 L 25 0 L 25 25 L 0 25 Z', windingRule: 'NONZERO'},
      {data: 'M 30 0 L 60 0 L 60 30 L 30 30 Z M 38 8 L 52 8 L 52 22 L 38 22 Z', windingRule: 'EVENODD'},
    ],
  }), 230, 220, 60, 60);

  // 8. Photo rectangle with INSIDE bright-red stroke — stroke must render ABOVE the photo!
  const borderedPhoto = rectNode('带边框照片', 310, 220, 60, 60, {
    fills: [{type: 'IMAGE', visible: true, opacity: 1, scaleMode: 'FILL', imageHash: 'blue-card'}],
    strokes: solid(1, 0.1, 0.1),
    strokeWeight: 4, strokeAlign: 'INSIDE',
  });

  // 9. Multi-region vector with overlapping oppositely-wound NONZERO regions (mirrored flattened chevron) at 50% fill opacity:
  //    Must NOT cancel out to punch a hole at the intersection, and must NOT double-blend alpha at the overlap!
  const mirroredChevron = at(node('VECTOR', '镜像重叠矢量', {
    fills: solid(1, 1, 1, 0.5),
    fillGeometry: [
      {data: 'M 0 0 L 40 0 L 40 30 L 0 30 Z', windingRule: 'NONZERO'},      // CW: x in [0, 40]
      {data: 'M 60 0 L 60 30 L 20 30 L 20 0 Z', windingRule: 'NONZERO'},    // CCW (mirrored!): x in [20, 60], overlaps [20, 40]!
    ],
  }), 20, 265, 60, 30);

  // 10. Wide button with a diagonal gradient defined in Figma's NORMALISED box: t = 0.7071 u + 0.7071 v.
  //     Bands are tilted by the box aspect, NOT perpendicular to the handle line in pixels.
  const skewGradBtn = rectNode('斜向渐变按钮', 110, 292, 200, 24, {
    fills: [{
      type: 'GRADIENT_LINEAR', visible: true, opacity: 1,
      gradientTransform: [[0.7071, 0.7071, 0], [-0.7071, 0.7071, 0.5]],
      gradientStops: [
        {position: 0, color: {r: 0, g: 0, b: 0, a: 1}},
        {position: 1, color: {r: 1, g: 1, b: 1, a: 1}},
      ],
    }],
  });

  // 11. Sub-pixel dot (13.333px at x=395.333): must keep fractional edge coverage, not snap to a 14px CSS disc
  const fracDot = at(node('ELLIPSE', '亚像素圆点', {
    fills: solid(0, 0.64, 1),
    fillGeometry: [{data: 'M13.3333 6.66667C13.3333 10.3486 10.3486 13.3333 6.66667 13.3333C2.98477 13.3333 0 10.3486 0 6.66667C0 2.98477 2.98477 0 6.66667 0C10.3486 0 13.3333 2.98477 13.3333 6.66667Z', windingRule: 'NONZERO'}],
  }), 395.3333, 296.3333, 13.3333, 13.3333);

  // Simulate offset reference bounds (e.g. outer bleed shadow) to verify exact .f2a-reference placement
  const frame = at(node('FRAME', 'Fidelity', {
    clipsContent: true,
    fills: solid(0.1, 0.12, 0.16),
    fillGeometry: [{data: rectPath(420, 320), windingRule: 'NONZERO'}],
    children: [radialRect, innerShadowRect, mixedClip, vCenterText, rotText, gradStrokeText, mixedWinding, borderedPhoto, mirroredChevron, skewGradBtn, fracDot],
  }), 0, 0, 420, 320, {x: -12, y: -8, width: 444, height: 336});

  const h = harness(frame);
  mixedClip.cornerRadius = h.figma.mixed;
  const bluePhotoPng = makePng(60, 60, () => [20, 40, 220, 255]);
  h.figma.getImageByHash = hash => {
    assert.equal(hash, 'blue-card');
    return {getBytesAsync: async () => bluePhotoPng, getSizeAsync: async () => ({width: 60, height: 60})};
  };
  const refPng = makePng(444, 336, () => [20, 20, 20, 255]);
  frame.exportAsync = async opts => opts?.format === 'SVG' ? Buffer.from('<svg width="420" height="320" viewBox="0 0 420 320"></svg>') : refPng;
  h.figma.createText = () => {
    const t = node('TEXT', 'probe', {width: 12, height: 22});
    t.remove = () => {};
    return t;
  };
  h.figma.loadFontAsync = async () => {};

  h.messages.length = 0;
  await h.context.exportSelectionSVG(true, true, false, true, true, false, {
    target: 'web', precompLayers: true, outlineTexts: false,
    rasterize: {effects: false, paints: true, imageCrops: true, masks: true, booleans: true},
  });
  const err = h.messages.find(m => m.type === 'error');
  assert.equal(err, undefined, err?.message);
  const ship = h.messages.find(m => m.type === 'ship');
  assert.ok(ship);
  const packet = {...ship, images: collectShipImages(h.messages)};
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'f2a-web-fidelity-'));
  try {
    const res = await exportWeb(packet, outDir);
    const css = await fsp.readFile(path.join(outDir, 'style.css'), 'utf8');
    const html = await fsp.readFile(res.entry, 'utf8');

    // Static checks on CSS/HTML precision upgrades
    assert.match(css, /\.f2a-stage\s*\{[^}]*will-change:\s*transform;/, 'Stage composites at 1:1 before downscaling to avoid odd-coordinate half-pixel snapping');
    assert.match(css, /\.f2a-reference-img\s*\{[^}]*left:\s*-12px;[^}]*top:\s*-8px;[^}]*width:\s*444px;[^}]*height:\s*336px;/, 'Reference uses exact render bounds, not stretched 0,0,W,H');
    assert.match(css, /\.f2a-reference\s*\{[^}]*background:\s*var\(--f2a-backdrop\);/, 'Reference overlay flattens transparent Figma renders on the page backdrop');
    assert.match(html, /<div class="f2a-reference" hidden><img class="f2a-reference-img"/);
    // Exact linear axis: start at t=0 handle (110, 304), end = start + g/|g|^2 with g = (0.7071/200, 0.7071/24)
    {
      const gx = 0.7071 / 200, gy = 0.7071 / 24, l2 = gx * gx + gy * gy;
      const m = html.match(/data-layer-name="斜向渐变按钮"[\s\S]*?<linearGradient[^>]*x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/);
      assert.ok(m, 'Skewed gradient button emits a linearGradient');
      const [x1, y1, x2, y2] = m.slice(1).map(Number);
      // t=0 handle is inv(0, 0.5); the end point is the exact pixel-space equivalent of Figma's ramp
      assert.ok(Math.abs((x2 - x1) - gx / l2) < 0.05 && Math.abs((y2 - y1) - gy / l2) < 0.05,
        `Linear gradient end follows Figma's normalised-box ramp: ${m.slice(1)}`);
      assert.ok(Math.abs(0.7071 * (x1 - 110) / 200 + 0.7071 * (y1 - 292) / 24) < 1e-3, 'Start sits on t=0');
    }
    assert.match(html, /<svg [^>]*data-layer-name="亚像素圆点"[^>]*class="f2a-svg"[^>]*>.*?<ellipse /, 'Fractional primitive renders through SVG for sub-pixel coverage');
    assert.match(css, /@font-face\s*\{[^}]*local\("Segoe UI SemiBold"\)/, 'Emits local() weight alias for non-Regular font styles');
    assert.match(css, /border-radius:\s*24px 2px 24px 2px;/, 'Mixed 4-corner radii preserved on clipped frame');
    assert.match(css, /text-decoration:\s*underline;/, 'textDecoration UNDERLINE preserved');
    assert.match(css, /text-overflow:\s*ellipsis;/, 'textTruncation ENDING preserved');
    assert.match(css, /line-height:\s*22px;/, 'AUTO line-height measured from Figma probe');
    assert.match(html, /class="f2a-text-stack"/, 'Gradient text + OUTSIDE stroke uses layered back-stroke');
    assert.match(html, /<radialGradient[^>]*gradientTransform="matrix\(/, 'Elliptical radial gradient uses affine gradientTransform');
    assert.match(html, /<filter id="f2a-fx-[^"]*".*feComposite[^>]*operator="out"/, 'SVG shape INNER_SHADOW uses native SVG filter');
    assert.match(html, /<path d="M230 220[^"]*"[^>]*\/><path d="M260 220[^"]*" fill-rule="evenodd"[^>]*\/>/, 'Per-path mixed NONZERO + EVENODD winding preserved');
    assert.match(html, /<g opacity="0\.5"><path d="M20 265[^"]*" fill="#ffffff"\/><path d="M80 265[^"]*" fill="#ffffff"\/><\/g>/, 'Separate fillGeometry regions emit separate <path>s with isolated group opacity');

    // Real Edge browser pixel & DOM geometry verification!
    if (fs.existsSync(EDGE_EXE)) {
      const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'f2a-web-fid-edge-'));
      const child = spawn(EDGE_EXE, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=0', '--remote-allow-origins=*', '--user-data-dir=' + profile, 'about:blank',
      ], {windowsHide: true, stdio: 'ignore'});
      let socket;
      try {
        let port;
        for (let i = 0; i < 100; i++) {
          try { port = (await fsp.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; }
          catch { await new Promise(r => setTimeout(r, 100)); }
        }
        const targets = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
        socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
        await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
        let seq = 0;
        const pending = new Map(), events = new Map();
        socket.onmessage = e => {
          const m = JSON.parse(e.data);
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
          else if (events.has(m.method)) events.get(m.method)(m);
        };
        const cmd = async (method, params = {}) => {
          const id = ++seq;
          const done = new Promise(r => pending.set(id, r));
          socket.send(JSON.stringify({id, method, params}));
          const r = await done;
          if (r.error) throw new Error(JSON.stringify(r.error));
          return r.result;
        };
        await cmd('Page.enable');
        await cmd('Emulation.setDeviceMetricsOverride', {width: 420, height: 320, deviceScaleFactor: 1, mobile: false});
        const loaded = new Promise(r => events.set('Page.loadEventFired', r));
        await cmd('Page.navigate', {url: pathToFileURL(res.entry).href});
        await loaded;

        const domCheck = (await cmd('Runtime.evaluate', {
          expression: `(async function(){
            await document.fonts.ready;
            await new Promise(r => requestAnimationFrame(r));
            const box = window.F2A.layer('居中文字').querySelector('.f2a-text');
            const content = box.querySelector('.f2a-text-content');
            const br = box.getBoundingClientRect(), cr = content.getBoundingClientRect();
            const rotEl = window.F2A.layer('旋转文字').querySelector('.f2a-text');
            return {
              boxMidY: (br.top + br.bottom) / 2,
              contentMidY: (cr.top + cr.bottom) / 2,
              boxMidX: (br.left + br.right) / 2,
              contentMidX: (cr.left + cr.right) / 2,
              rotW: parseFloat(getComputedStyle(rotEl).width),
              rotH: parseFloat(getComputedStyle(rotEl).height),
            };
          })()`,
          awaitPromise: true, returnByValue: true,
        })).result.value;

        assert.ok(Math.abs(domCheck.boxMidY - domCheck.contentMidY) < 1.5, 'textAlignVertical CENTER truly centers glyphs vertically: ' + JSON.stringify(domCheck));
        assert.ok(Math.abs(domCheck.boxMidX - domCheck.contentMidX) < 1.5, 'textAlignHorizontal CENTER truly centers glyphs horizontally: ' + JSON.stringify(domCheck));
        assert.equal(domCheck.rotW, 120, 'Rotated text keeps unrotated width lw=120, not rotated AABB');
        assert.equal(domCheck.rotH, 24, 'Rotated text keeps unrotated height lh=24, not rotated AABB');

        const shot = await cmd('Page.captureScreenshot', {format: 'png'});
        const img = decodePng(Buffer.from(shot.data, 'base64'));
        // Radial gradient center (80, 60) is bright yellow; left edge (23, 60) is dark blue!
        const radCenter = img.at(80, 60), radEdge = img.at(23, 60);
        assert.ok(radCenter[0] > 230 && radCenter[1] > 220 && radCenter[2] < 80, 'Radial gradient center at (0.5,0.5) is yellow: ' + radCenter);
        assert.ok(radEdge[2] > 140 && radEdge[0] < 60, 'Radial gradient left edge is blue: ' + radEdge);

        // SVG INNER_SHADOW on top of gradient rect (210, 24) is significantly darker than center (210, 65)!
        const isTop = img.at(210, 24), isMid = img.at(210, 65);
        assert.ok(isMid[0] - isTop[0] > 90, `SVG INNER_SHADOW darkens top edge (${isTop}) vs bright interior (${isMid})`);

        // Mixed winding EVENODD hole at (275, 235) shows dark frame background instead of green!
        const holePx = img.at(275, 235), ringPx = img.at(264, 235);

        // Skewed linear gradient follows Figma's normalised ramp t = 0.7071 (u + v):
        // top-right (306, 294) -> t 0.752, bottom-left (114, 314) -> t 0.662 (old handle-perpendicular axis gave ~0.99 / ~0.03)
        const skewTR = img.at(306, 294), skewBL = img.at(114, 314);
        assert.ok(Math.abs(skewTR[0] - 192) <= 10, 'Skewed gradient top-right matches Figma ramp: ' + skewTR);
        assert.ok(Math.abs(skewBL[0] - 169) <= 10, 'Skewed gradient bottom-left matches Figma ramp: ' + skewBL);
        // Sub-pixel dot left column (395, 303) is only ~2/3 covered, not a snapped solid pixel
        const dotEdge = img.at(395, 303), dotCore = img.at(402, 303);
        assert.ok(dotCore[2] > 245, 'Sub-pixel dot core is solid: ' + dotCore);
        assert.ok(dotEdge[2] > 60 && dotEdge[2] < 235, 'Sub-pixel dot keeps fractional edge coverage: ' + dotEdge);
        assert.ok(ringPx[1] > 190, 'EVENODD ring is green: ' + ringPx);
        assert.ok(holePx[1] < 60, 'EVENODD inner hole remains transparent: ' + holePx);

        // Photo with INSIDE red border: border edge (312, 250) is bright red ABOVE blue photo interior (340, 250)!
        const borderPx = img.at(312, 250), photoPx = img.at(340, 250);
        assert.ok(borderPx[0] > 220 && borderPx[2] < 60, 'Photo INSIDE stroke paints ABOVE image: ' + borderPx);
        assert.ok(photoPx[2] > 180 && photoPx[0] < 60, 'Photo interior remains blue: ' + photoPx);

        // Overlapping oppositely-wound regions at 50% fillOpacity: overlap (50, 280) has NO hole and matches single-region leg (30, 280) with zero double-blending!
        const legPx = img.at(30, 280), overlapPx = img.at(50, 280);
        assert.ok(overlapPx[0] > 120, 'Overlapping opposite-winding regions do not cancel into a hole: ' + overlapPx);
        assert.ok(Math.abs(overlapPx[0] - legPx[0]) <= 3, `Isolated group opacity avoids double-blending overlap (${overlapPx}) vs leg (${legPx})`);

        // Verify Inspector 差值比对 clears 图层框 & inline range opacity, and keeps 1:1 compositing at 0.5x fit scale
        await cmd('Emulation.setDeviceMetricsOverride', {width: 210, height: 160, deviceScaleFactor: 1, mobile: false});
        const diffState = (await cmd('Runtime.evaluate', {
          expression: `(async function(){
            window.dispatchEvent(new Event('resize'));
            const btns = Array.from(document.querySelectorAll('.f2a-inspector button'));
            const byText = t => btns.find(b => b.textContent === t);
            byText('图层框').click();
            byText('原图对照').click();
            const slider = document.querySelector('.f2a-inspector input[type="range"]');
            slider.value = '40'; slider.dispatchEvent(new Event('input'));
            byText('差值比对').click();
            await new Promise(r => requestAnimationFrame(r));
            const ref = document.querySelector('.f2a-reference');
            return {
              outlines: document.documentElement.getAttribute('data-outlines'),
              outlinesPressed: byText('图层框').getAttribute('aria-pressed'),
              diffAttr: ref.getAttribute('data-diff'),
              inlineOpacity: ref.style.opacity,
              computedOpacity: getComputedStyle(ref).opacity,
              willChange: getComputedStyle(document.getElementById('f2a-stage')).willChange,
            };
          })()`,
          awaitPromise: true, returnByValue: true,
        })).result.value;
        assert.equal(diffState.outlines, null, '差值比对 clears debug outlines so they do not invert into fake diffs');
        assert.equal(diffState.outlinesPressed, 'false');
        assert.equal(diffState.diffAttr, 'true');
        assert.equal(diffState.inlineOpacity, '');
        assert.equal(diffState.computedOpacity, '1');
        assert.equal(diffState.willChange, 'transform');
      } finally {
        socket?.close();
        child.kill();
        for (let i = 0; i < 20; i++) {
          try { await fsp.rm(profile, {recursive: true, force: true}); break; }
          catch { await new Promise(r => setTimeout(r, 150)); }
        }
      }
    }
  } finally {
    await fsp.rm(outDir, {recursive: true, force: true});
  }
}

async function check() {
  const scene = buildDemoScene();
  const h = harness(scene);
  const midGrayPng = makePng(90, 90, () => [128, 128, 128, 255]);
  const refPng = makePng(640, 420, () => [20, 23, 33, 255]);
  h.figma.getImageByHash = hash => {
    assert.equal(hash, 'photo-hash');
    return {
      getBytesAsync: async () => midGrayPng,
      getSizeAsync: async () => ({width: 90, height: 90}),
    };
  };
  scene.exportAsync = async opts => opts?.format === 'SVG' ? Buffer.from('<svg width="640" height="420" viewBox="0 0 640 420"></svg>') : refPng;

  // Export through actual figma-plugin/code.js with target: 'web', precompLayers: true, preserveImageFilters: true, rasterize.effects: false (native CSS blur/shadow)
  h.messages.length = 0;
  await h.context.exportSelectionSVG(true, true, false, true, true, false, {
    target: 'web',
    precompLayers: true,
    preserveImageFilters: true,
    mergeBlends: false,
    nativeImageMasks: true,
    rasterize: {effects: false, paints: true, imageCrops: true, masks: true, booleans: true},
  });
  const err = h.messages.find(m => m.type === 'error');
  assert.equal(err, undefined, err?.message);
  const ship = h.messages.find(m => m.type === 'ship');
  assert.ok(ship, 'code.js emitted ship message');
  const images = collectShipImages(h.messages);
  const packet = {...ship, images};

  // 1. Default export (animations OFF): clean static HTML + CSS + lean main.js, no animations.js
  const staticDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'f2a-web-static-'));
  try {
    const staticRes = await exportWeb(packet, staticDir);
    assert.equal(staticRes.animations, false);
    assert.equal(fs.existsSync(path.join(staticDir, 'animations.js')), false);
    const staticHtml = await fsp.readFile(staticRes.entry, 'utf8');
    assert.doesNotMatch(staticHtml, /animations\.js/);
    await testBrowserRendering(staticRes.entry, null, {animations: false});
  } finally {
    await fsp.rm(staticDir, {recursive: true, force: true});
  }

  // 2. Opt-in animations export: write a browsable demo bundle into artifacts/web-export-demo
  const demoDir = path.join(root, 'artifacts/web-export-demo');
  await fsp.rm(demoDir, {recursive: true, force: true});
  const result = await exportWeb(packet, demoDir, {animations: true});
  assert.equal(result.animations, true);
  assert.equal(fs.existsSync(path.join(demoDir, 'animations.js')), true);
  assert.ok(result.counts.containers >= 12);
  assert.ok(result.counts.minimal >= 10);
  assert.ok(result.counts.masks >= 2);
  assert.ok(result.counts.texts >= 2);
  assert.ok(result.counts.images >= 1);

  // Verify real Edge browser rendering, exact pixel colors, masks, blends, live grading, and JS animation APIs!
  await testBrowserRendering(result.entry, path.join(demoDir, 'preview.png'), {animations: true});

  // Also test flat mode (organize=false, precompLayers=true)
  h.messages.length = 0;
  await h.context.exportSelectionSVG(true, false, true, true, true, false, {
    target: 'web', precompLayers: true, preserveImageFilters: true, mergeBlends: false, nativeImageMasks: true,
    rasterize: {effects: false, paints: true, imageCrops: true, masks: true, booleans: true},
  });
  const flatErr = h.messages.find(m => m.type === 'error');
  assert.equal(flatErr, undefined, flatErr?.message);
  const flatShip = h.messages.find(m => m.type === 'ship');
  const flatImages = collectShipImages(h.messages);
  const flatDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'f2a-web-flat-'));
  try {
    const flatRes = await exportWeb({...flatShip, images: flatImages}, flatDir);
    assert.equal(flatRes.counts.containers, flatRes.counts.minimal, 'Flat mode wraps every layer in a minimal layer');
  } finally {
    await fsp.rm(flatDir, {recursive: true, force: true});
  }

  // Also verify native image mask + rotated imageMatrix crop fixture exports cleanly to HTML+CSS+JS
  const {fixture: nativeMaskFixture} = require('./native-image-masks.cjs');
  const maskBundle = await nativeMaskFixture();
  const maskDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'f2a-web-imgmask-'));
  try {
    const maskRes = await exportWeb(maskBundle.packet, maskDir);
    assert.ok(maskRes.counts.masks >= 1 && maskRes.counts.images >= 1);
    const maskHtml = await fsp.readFile(maskRes.entry, 'utf8');
    assert.match(maskHtml, /<mask id="f2a-mask-/);
    assert.match(maskHtml, /<image href="data:image\//);
  } finally {
    await fsp.rm(maskDir, {recursive: true, force: true});
  }

  // Test precision fidelity features (vertical text alignment, rotated text, auto line-height,
  // underline/ellipsis, gradient+stroke back-layer, elliptical radial gradient, SVG inner shadow,
  // mixed 4-corner radii, mixed evenodd/nonzero vector paths, and offset reference bounds) in real Edge!
  await testFidelitySuite();

  // Test HTTP server routes (/export-web, /open-directory, /open-preview) + UI panel button flow
  await testServerAndUi(packet);

  // Verify Windows PowerShell & Python destination pickers initialize TopMost promoters cleanly and preserve Unicode + leading-dash names
  if (process.platform === 'win32') {
    const {execFileSync} = require('node:child_process');
    const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const picker = path.join(root, 'scripts/web/choose-web-destination.ps1');
    const legacyOut = execFileSync(powershell, [
      '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', picker, '-InitialName', '涂装选择', '-DryRun',
    ], {encoding: 'utf8', windowsHide: true});
    const legacyParsed = JSON.parse(legacyOut.trim());
    assert.equal(legacyParsed.directory, '涂装选择');
    assert.equal(legacyParsed.title, '保存 HTML 前端页面文件夹');
    assert.equal(legacyParsed.filter, 'HTML 页面文件夹|*');
    assert.equal(legacyParsed.cancelled, null);
    assert.equal(legacyParsed.topmostReady, true);

    const envOut = execFileSync(powershell, [
      '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', picker, '-DryRun',
    ], {encoding: 'utf8', windowsHide: true, env: {...process.env, F2A_WEB_INITIAL_NAME: '-涂装选择 🎨'}});
    const envParsed = JSON.parse(envOut.trim());
    assert.equal(envParsed.directory, '-涂装选择 🎨');
    assert.equal(envParsed.topmostReady, true);

    const aepPython = path.join(root, '.venv-aep/Scripts/python.exe');
    if (fs.existsSync(aepPython)) {
      const pyOut = execFileSync(aepPython, [
        path.join(root, 'scripts/aep/choose-destination.py'), '涂装选择', '--dry-run',
      ], {encoding: 'utf8', windowsHide: true, env: {...process.env, PYTHONUTF8: '1'}});
      const pyParsed = JSON.parse(pyOut.trim());
      assert.equal(pyParsed.directory, '涂装选择');
      assert.equal(pyParsed.topmostReady, true);
    }
  }

  console.log('PASS: Form A web export (code.js -> HTML+CSS+JS, real Edge pixel/mask/blend/grading verification, WAAPI runtime, Inspector HUD, HTTP routes, PowerShell picker & UI panel)');
}

check().catch(error => { console.error(error); process.exitCode = 1; });
