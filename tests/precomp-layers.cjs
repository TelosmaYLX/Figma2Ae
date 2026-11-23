'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {node, group, harness} = require('./export-options.cjs');
const {png} = require('./direct-aep.cjs');
const {exportAep} = require('../scripts/export-aep.cjs');

const run = promisify(execFile);
const root = path.resolve(__dirname, '..');
const python = process.env.F2A_PYTHON || path.join(root, '.venv-aep',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

const solid = (r, g, b) => [{type: 'SOLID', color: {r, g, b}}];

function at(n, x, y, w = 100, h = 60, render = null) {
  Object.assign(n, {
    width: w, height: h,
    absoluteBoundingBox: {x, y, width: w, height: h},
    absoluteRenderBounds: render || {x, y, width: w, height: h},
    absoluteTransform: [[1, 0, x], [0, 1, y]]
  });
  return n;
}

function rect(name, x, y, w, h, extra = {}) {
  const n = node('RECTANGLE', name, {
    cornerRadius: 0,
    fills: solid(0.2, 0.5, 0.9),
    fillGeometry: [{data: `M0 0H${w}V${h}H0Z`, windingRule: 'NONZERO'}],
    ...extra
  });
  return at(n, x, y, w, h, extra.absoluteRenderBounds || null);
}

function collectImages(messages) {
  return messages.filter(m => m.type === 'image-chunk' && m.seq === 0).map(m => ({
    ...m.meta,
    data: messages.filter(c => c.type === 'image-chunk' && c.index === m.index).map(c => c.dataPart).join('')
  }));
}

function buildScene() {
  const textA = at(node('TEXT', '文字A', {
    characters: 'Hello', fills: solid(1, 1, 1), opacity: 0.6, blendMode: 'MULTIPLY'
  }), 120.25, 130.5, 84, 24);
  const shapeB1 = rect('形状B', 140.5, 180.25, 90, 40, {
    strokes: solid(1, 0.3, 0.1), strokeWeight: 4, strokeAlign: 'OUTSIDE',
    absoluteRenderBounds: {x: 136.5, y: 176.25, width: 98, height: 48}
  });
  const shapeB2 = rect('形状B', 260, 180, 50, 30);
  const innerGroup = at(group('分组', [textA, shapeB1]), 120.25, 130.5, 114.25, 93.75);

  const emptyBox = at(node('FRAME', '空色块', {
    fills: solid(0.9, 0.2, 0.2),
    fillGeometry: [{data: 'M0 0H60V40H0Z', windingRule: 'NONZERO'}],
    children: []
  }), 340, 130, 60, 40);

  const photo = rect('背景图', 120, 260, 120, 80, {
    fills: [{type: 'IMAGE', imageHash: 'photo', scaleMode: 'FIT', opacity: 0.8}]
  });

  const maskShape = rect('矢量遮罩', 280, 260, 70, 50, {isMask: true, maskType: 'ALPHA', fills: solid(1, 1, 1)});
  const maskedArt = rect('遮罩图形', 270, 250, 100, 70);
  const maskGroup = at(group('遮罩组', [maskShape, maskedArt]), 270, 250, 100, 70);

  const cursor = at(node('VECTOR', '光标', {
    fills: solid(0, 0, 0),
    fillGeometry: [
      {data: 'M0 0H20V20H0Z', windingRule: 'NONZERO'},
      {data: 'M4 4H16V16H4Z', windingRule: 'NONZERO'}
    ],
    vectorNetwork: {
      regions: [
        {fills: solid(1, 1, 1)},
        {fills: solid(0, 0, 0)}
      ]
    }
  }), 410, 250, 20, 20);

  const hiddenLayer = rect('隐藏层', 420, 130, 40, 40, {visible: false});
  const sticker = at(group('*贴纸组', [rect('贴纸底', 420, 300, 50, 50)]), 420, 300, 50, 50);

  const shadowText = at(node('TEXT', '投影文字', {
    characters: 'Shadow', fills: solid(1, 1, 1), opacity: 0.5,
    effects: [{type: 'DROP_SHADOW', visible: true, color: {r: 0, g: 0, b: 0, a: 0.5}, offset: {x: 4, y: 6}, radius: 8, spread: 0}]
  }), 120, 360, 90, 24, {x: 116, y: 358, width: 106, height: 42});

  const page = at(node('FRAME', '页面', {
    fills: solid(0.1, 0.1, 0.1),
    fillGeometry: [{data: 'M0 0H400V320H0Z', windingRule: 'NONZERO'}],
    children: [innerGroup, shapeB2, emptyBox, photo, maskGroup, cursor, hiddenLayer, sticker, shadowText]
  }), 100.25, 100.5, 400, 320);

  return page;
}

function attachMockRenders(scene, h) {
  const photoBytes = png(120, 80);
  h.figma.getImageByHash = () => ({
    getBytesAsync: async () => photoBytes,
    getSizeAsync: async () => ({width: 120, height: 80})
  });
  (function walk(n) {
    n.exportAsync = async function (options) {
      const scale = options?.constraint?.value || 1;
      const b = this.absoluteRenderBounds || this.absoluteBoundingBox || {width: 10, height: 10};
      return png(Math.max(1, Math.round(b.width * scale)), Math.max(1, Math.round(b.height * scale)));
    };
    if (n.children) n.children.forEach(walk);
  })(scene);
}

const inspectAep = `
import json, sys, py_aep
from py_aep.enums import BlendingMode, TrackMatteType

app = py_aep.parse(sys.argv[1])
mode = sys.argv[2]

def comps(folder):
    for item in folder.items:
        if hasattr(item, 'layers'):
            yield item
        elif hasattr(item, 'items'):
            yield from comps(item)

all_comps = list(comps(app.project.root_folder))
main = next(c for c in all_comps if c.name == '页面' and c.parent_folder.name == '页面')
assert main.layers[0].guide_layer and not main.layers[0].enabled, 'Reference guide layer stays on top, hidden and unwrapped'

def by_name(comp, name):
    return [l for l in comp.layers if l.name == name]

if mode == 'organized':
    # Main comp has guide + root precomp 页面
    assert len(main.layers) == 2
    root_layer = main.layers[1]
    assert root_layer.name == '页面' and hasattr(root_layer.source, 'layers')
    root_comp = root_layer.source

    # Frame background is NOT double-wrapped; 空色块 is NOT double-wrapped
    bg_layers = by_name(root_comp, '页面')
    assert len(bg_layers) == 1 and not hasattr(bg_layers[0].source, 'layers'), 'Container fill must not be double-wrapped'
    empty_layers = by_name(root_comp, '空色块')
    assert len(empty_layers) == 1 and hasattr(empty_layers[0].source, 'layers')
    assert len(empty_layers[0].source.layers) == 1 and not hasattr(empty_layers[0].source.layers[0].source, 'layers'), 'Empty painted frame must not be double-wrapped'

    # 分组 precomp has collapse_transformation=True because 文字A inside has MULTIPLY
    group_layer, = by_name(root_comp, '分组')
    assert group_layer.collapse_transformation is True
    group_comp = group_layer.source

    text_a_layer, = by_name(group_comp, '文字A')
    assert hasattr(text_a_layer.source, 'layers')
    assert text_a_layer.collapse_transformation is False
    assert text_a_layer.blending_mode == BlendingMode.MULTIPLY
    assert abs(text_a_layer.transform.opacity.value - 60.0) < 0.01
    # Tight bounds: x=120.25-100.25=20, w=84; y=130.5-100.5=30, h=24
    assert (text_a_layer.source.width, text_a_layer.source.height) == (84, 24)
    assert list(text_a_layer.transform.anchor_point.value[:2]) == [42.0, 12.0]
    inner_text, = text_a_layer.source.layers
    assert inner_text.name == '文字A' and inner_text.blending_mode == BlendingMode.NORMAL
    assert abs(inner_text.transform.opacity.value - 100.0) < 0.01

    shape_b1_layer, = by_name(group_comp, '形状B')
    assert hasattr(shape_b1_layer.source, 'layers')
    # Outside stroke render bounds: 136.5-100.25=36.25 -> floor 36, right 136.5+98-100.25=134.25 -> ceil 135 -> w=99
    # y: 176.25-100.5=75.75 -> floor 75, bottom 75.75+48=123.75 -> ceil 124 -> h=49
    assert (shape_b1_layer.source.width, shape_b1_layer.source.height) == (99, 49)
    assert shape_b1_layer.source.layers[0].name == '形状B'

    # Duplicate named 形状B at root level has its own distinct precomp
    shape_b2_layer, = by_name(root_comp, '形状B')
    assert hasattr(shape_b2_layer.source, 'layers')
    assert shape_b2_layer.source.id != shape_b1_layer.source.id
    assert shape_b2_layer.source.layers[0].name == '形状B'

    # Image 背景图 keeps Chinese precomp name and single precomp with lifted opacity 80%
    photo_layer, = by_name(root_comp, '背景图')
    assert hasattr(photo_layer.source, 'layers')
    assert abs(photo_layer.transform.opacity.value - 80.0) < 0.01
    assert any(l.source and not hasattr(l.source, 'layers') for l in photo_layer.source.layers)

    # Masked shape 遮罩图形 carries track matte on outer precomp
    mask_group_layer, = by_name(root_comp, '遮罩组')
    masked_layer, = by_name(mask_group_layer.source, '遮罩图形')
    assert hasattr(masked_layer.source, 'layers')
    assert masked_layer.track_matte_layer is not None
    assert masked_layer.track_matte_type == TrackMatteType.ALPHA
    assert masked_layer.source.layers[0].track_matte_layer is None

    # Multi-region vector 光标 is wrapped once with both region layers inside
    cursor_layer, = by_name(root_comp, '光标')
    assert hasattr(cursor_layer.source, 'layers')
    assert len(cursor_layer.source.layers) == 2

    # Hidden layer 隐藏层 has disabled outer precomp and enabled inner shape
    hidden_layer, = by_name(root_comp, '隐藏层')
    assert hasattr(hidden_layer.source, 'layers')
    assert hidden_layer.enabled is False
    assert hidden_layer.source.layers[0].enabled is True

    # Marked raster group *贴纸组 becomes a single-layer precomp
    sticker_layer, = by_name(root_comp, '*贴纸组')
    assert hasattr(sticker_layer.source, 'layers')
    assert len(sticker_layer.source.layers) == 1

    # Shadow text 投影文字 groups text + shadow image together without double opacity
    shadow_layer, = by_name(root_comp, '投影文字')
    assert hasattr(shadow_layer.source, 'layers')
    assert abs(shadow_layer.transform.opacity.value - 100.0) < 0.01
    assert len(shadow_layer.source.layers) == 2
    assert shadow_layer.source.width >= 106 and shadow_layer.source.height >= 42
    print('PASS_PY_ORGANIZED')
elif mode == 'flat':
    # organize=False + precompLayers=True: no group precomps, every artwork layer (including 页面 bg) wrapped at main comp level
    mattes = {l.track_matte_layer.index for l in main.layers if l.track_matte_layer is not None}
    artwork = [l for l in main.layers if not getattr(l, 'guide_layer', False) and l.index not in mattes]
    names = [l.name for l in artwork]
    assert '分组' not in names and '遮罩组' not in names
    assert all(hasattr(l.source, 'layers') for l in artwork), 'Every flat artwork layer is wrapped in a precomp'
    assert names.count('形状B') == 2
    for expected in ['页面', '文字A', '空色块', '背景图', '遮罩图形', '光标', '隐藏层', '*贴纸组', '投影文字']:
        assert expected in names, (expected, names)
    masked_flat, = by_name(main, '遮罩图形')
    assert masked_flat.track_matte_layer is not None and masked_flat.track_matte_type == TrackMatteType.ALPHA
    print('PASS_PY_FLAT')
`;

function testAeBuilderOrganize() {
  class FootageItem { constructor(file) { this.width = 100; this.height = 60; this.mainSource = {file}; } }
  class Shape {}
  let nextCompId = 1;
  class CompItem {
    constructor(name = 'Main', w = 400, h = 320) {
      this.id = nextCompId++; this.name = name; this.width = w; this.height = h; this.time = 0; this.duration = 10;
      this.items = [];
      this.layers = {
        add: item => { const l = new Layer(this, item); this.items.unshift(l); return l; },
        addShape: () => { const l = new Layer(this, null, 'shape'); this.items.unshift(l); return l; },
        addText: text => { const l = new Layer(this, null, 'text', text); this.items.unshift(l); return l; },
        precompose: (indices, pcName) => {
          const sorted = Array.from(indices).sort((a, b) => a - b);
          const pc = new CompItem(pcName, this.width, this.height);
          const picked = sorted.map(idx => this.items[idx - 1]);
          const firstPos = sorted[0] - 1;
          for (let i = sorted.length - 1; i >= 0; i--) this.items.splice(sorted[i] - 1, 1);
          for (const old of picked) {
            const copy = new Layer(pc, old.source, old.kind, old.text);
            copy.name = old.name; copy.enabled = old.enabled; copy.blendingMode = old.blendingMode;
            copy.collapseTransformation = old.collapseTransformation;
            copy.values = JSON.parse(JSON.stringify(old.values));
            pc.items.push(copy);
          }
          const pcLayer = new Layer(this, pc, 'precomp');
          pcLayer.name = pcName;
          this.items.splice(firstPos, 0, pcLayer);
          return pc;
        }
      };
    }
    get numLayers() { return this.items.length; }
    layer(i) { return this.items[i - 1]; }
  }
  function makeGroup(store) {
    const props = [];
    const groupObj = {
      get numProperties() { return props.length; },
      property(key) {
        if (typeof key === 'number') return props[key - 1];
        if (key === 'ADBE Transform Group' || key === 'ADBE Vector Transform Group') {
          return {
            property(k) {
              return {
                get value() { return store[k] || [0, 0, 0]; },
                setValue(v) { store[k] = Array.isArray(v) ? v.slice() : v; }
              };
            }
          };
        }
        if (key === 'ADBE Mask Parade' || key === 'ADBE Root Vectors Group' || key === 'ADBE Vectors Group') return makeGroup(store);
        return { setValue(v) { store[key] = v; }, get value() { return store[key]; }, property: () => ({ setValue() {} }) };
      },
      addProperty(mn) {
        const child = makeGroup(store);
        child.matchName = mn;
        child.moveTo = () => {};
        props.push(child);
        return child;
      }
    };
    return groupObj;
  }
  class Layer {
    constructor(comp, source, kind = 'layer', text = '') {
      this.containingComp = comp; this.source = source; this.kind = kind; this.text = text;
      this.name = ''; this.enabled = true; this.values = {'ADBE Position': [0, 0, 0], 'ADBE Anchor Point': [0, 0, 0], 'ADBE Opacity': 100};
      this.trackMatte = null; this.trackMatteType = null; this.blendingMode = 'NORMAL'; this.collapseTransformation = false;
    }
    get index() {
      const idx = this.containingComp.items.indexOf(this);
      if (idx < 0) throw new Error('Object is invalid');
      return idx + 1;
    }
    property(key) { return makeGroup(this.values).property(key); }
    moveToBeginning() { const l = this.containingComp.items; l.splice(l.indexOf(this), 1); l.unshift(this); }
    moveBefore(other) { const l = this.containingComp.items; l.splice(l.indexOf(this), 1); l.splice(l.indexOf(other), 0, this); }
    moveAfter(other) { const l = this.containingComp.items; l.splice(l.indexOf(this), 1); l.splice(l.indexOf(other) + 1, 0, this); }
    setTrackMatte(mt, type) { this.trackMatte = mt; this.trackMatteType = type; }
    remove() { const l = this.containingComp.items; const i = l.indexOf(this); if (i >= 0) l.splice(i, 1); }
  }
  function File(name) { this.exists = true; this.fsName = name; }
  File.encode = encodeURI;
  function ImportOptions(file) { this.file = file; }
  const comp = new CompItem('Main', 400, 320);
  const app = {project: {activeItem: comp, numItems: 0, importFile: o => new FootageItem(o.file)}, beginUndoGroup() {}, endUndoGroup() {}};
  const BlendingMode = {MULTIPLY: 'MULTIPLY', NORMAL: 'NORMAL'};
  const TrackMatteType = {ALPHA: 'ALPHA', LUMA: 'LUMA'};
  const ctx = vm.createContext({app, CompItem, FootageItem, File, ImportOptions, Shape, BlendingMode, TrackMatteType});
  vm.runInContext(fs.readFileSync(path.join(root, 'host/figma/aeShapeBuilder.jsx'), 'utf8'), ctx);
  const builder = ctx.AEShapeBuilder;

  const model = {
    shapes: [
      {name: 'Mask', maskSource: 'm1', maskType: 'ALPHA', subpaths: [{verts: [[10, 10], [60, 10], [60, 50], [10, 50]], inT: [[0,0],[0,0],[0,0],[0,0]], outT: [[0,0],[0,0],[0,0],[0,0]], closed: true}], fill: [1, 1, 1], opacity: 1},
      {name: '形状B', path: ['grp', 'wrapB'], z: 2, subpaths: [{verts: [[10, 10], [90, 10], [90, 50], [10, 50]], inT: [[0,0],[0,0],[0,0],[0,0]], outT: [[0,0],[0,0],[0,0],[0,0]], closed: true}], fill: [0.2, 0.4, 0.8], opacity: 1}
    ]
  };
  builder.build(model, {comp});
  builder.buildImages(comp, [{file: 'ref.png', name: '原图对照', natW: 400, natH: 320, cx: 200, cy: 160, cw: 400, ch: 320, w: 400, h: 320, scaleMode: 'FIT', z: 0, reference: true}], 'assets');
  const containers = [
    {id: 'grp', name: '分组', path: [], z: 1, x: 10, y: 10, w: 80, h: 40, cb: {x: 10, y: 10, w: 80, h: 40}, opacity: 1, blend: 'PASS_THROUGH', collapseForBlends: true},
    {id: 'wrapB', name: '形状B', path: ['grp'], z: 2, x: 10, y: 10, w: 80, h: 40, cb: {x: 10, y: 10, w: 80, h: 40}, opacity: 0.7, blend: 'MULTIPLY', maskId: 'm1', collapseForBlends: false}
  ];
  const made = builder.organize(comp, containers);
  assert.equal(made, 2);
  assert.equal(comp.layer(1).name, '原图对照');
  assert.equal(comp.layer(1).enabled, false);
  const grpLayer = comp.layer(2);
  assert.equal(grpLayer.name, '分组');
  assert.equal(grpLayer.collapseTransformation, true);
  assert.equal(grpLayer.source.numLayers, 2, 'Outer group holds single-layer precomp + its track matte');
  const matteLayer = grpLayer.source.layer(1), wrapLayer = grpLayer.source.layer(2);
  assert.equal(wrapLayer.name, '形状B');
  assert.equal(wrapLayer.blendingMode, 'MULTIPLY');
  assert.equal(wrapLayer.values['ADBE Opacity'], 70);
  assert.equal(wrapLayer.trackMatte, matteLayer, 'Container track matte must stay linked after parent group collapse');
  assert.equal(matteLayer.enabled, false);
  assert.equal(wrapLayer.source.width, 80);
  assert.equal(wrapLayer.source.height, 40);
  assert.deepEqual(Array.from(wrapLayer.source.layer(1).values['ADBE Position']), [-10, -10, 0]);
  assert.deepEqual(Array.from(wrapLayer.values['ADBE Anchor Point']), [40, 20, 0]);
  assert.deepEqual(Array.from(wrapLayer.values['ADBE Position']), [40, 20, 0]);
}

async function testUiBridgeFlow() {
  let request;
  const imports = [];
  const bridgeCtx = vm.createContext({
    module: {exports: {}}, Buffer,
    require(name) {
      if (name !== 'http') return require(name);
      return {createServer(handler) { request = handler; return {on() {}, listen() {}}; }};
    },
    setTimeout() { return 1; }, clearTimeout() {}
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'client/mkBridgeServer.js'), 'utf8'), bridgeCtx);
  bridgeCtx.module.exports.start({onSvg(svg, meta) { imports.push({svg, meta}); }, onImages() {}, onAbort() {}});
  function send(message) {
    const req = new EventEmitter(); req.method = 'POST';
    let response;
    request(req, {writeHead() {}, end(body) { response = JSON.parse(body); }});
    req.emit('data', JSON.stringify(message)); req.emit('end');
    assert.ok(response.ok, response.error);
  }
  const scene = at(node('FRAME', '发送测试', {
    children: [
      at(node('TEXT', '文字A', {characters: 'Hi', fills: solid(1, 1, 1)}), 20, 30, 50, 20),
      rect('形状B', 80, 30, 40, 40)
    ]
  }), 10, 20, 200, 120);
  const main = harness(scene);
  attachMockRenders(scene, main);
  const html = fs.readFileSync(path.join(root, 'figma-plugin/ui.html'), 'utf8'), elements = {};
  for (const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) elements[m[1]] = {checked: /\bchecked\b/.test(m[0]), disabled: /\bdisabled\b/.test(m[0])};
  elements['raster-scale'].value = '1';
  elements['text-mode'].value = 'editable';
  elements['native-image-masks'].value = 'separate';
  elements['aep-duration'].value = '10';
  elements['aep-fps'].value = '30';
  let socket;
  function WebSocket(url) { if (url.endsWith('/plugin')) return; socket = this; this.readyState = 1; this.send = text => send(JSON.parse(text)); }
  const window = {};
  vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], {
    window, WebSocket, document: {getElementById: id => elements[id]},
    fetch: async () => ({ok: true, json: async () => ({directory: 'D:/Figma Assets'})}),
    parent: {postMessage(m) { main.figma.ui.onmessage(m.pluginMessage); }}, setTimeout() {}
  });
  main.figma.ui.postMessage = m => window.onmessage({data: {pluginMessage: m}});
  socket.onopen();
  main.context.reportSelection();
  assert.equal(elements['precomp-layers'].checked, false);
  elements.organize.checked = false;
  elements['precomp-layers'].checked = true;
  const origPost = main.figma.ui.postMessage;
  const done = new Promise(resolve => {
    main.figma.ui.postMessage = m => { origPost(m); if (m.type === 'export-state' && !m.busy) resolve(); };
  });
  elements.ship.onclick();
  await done;
  assert.equal(imports.length, 1);
  assert.equal(imports[0].meta.organize, true, 'Flat + precompLayers must enable containers on the bridge');
  assert.deepEqual(Array.from(imports[0].meta.containers, c => c.name).sort(), ['形状B', '文字A']);
  assert.ok(imports[0].meta.containers.every(c => c.path.length === 0));
}

async function check() {
  const scene = buildScene();
  const h = harness(scene);
  attachMockRenders(scene, h);

  // 1. organize=true, precompLayers=true, ignoreHidden=false, target='aep'
  const orgResult = await (async () => {
    h.messages.length = 0;
    await h.context.exportSelectionSVG(true, true, false, true, true, false, {target: 'aep', precompLayers: true, mergeBlends: false, nativeImageMasks: true});
    const error = h.messages.find(m => m.type === 'error');
    assert.equal(error, undefined, error?.message);
    return {ship: h.messages.find(m => m.type === 'ship'), images: collectImages(h.messages)};
  })();

  // Ensure no internal tagging leaks
  for (const list of [orgResult.ship.nodes, orgResult.ship.texts, orgResult.ship.containers, orgResult.images]) {
    for (const item of list) {
      assert.equal(Object.hasOwn(item, '_ownerId'), false);
      assert.equal(Object.hasOwn(item, '_layerName'), false);
    }
  }
  // Prepare shadow images (strip shadowBase as UI does before AEP write)
  for (const im of orgResult.images) if (im.shadowBase) im.shadowBase = null;

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'f2a-precomp-layers-'));
  try {
    const orgAep = await exportAep({...orgResult.ship, images: orgResult.images}, path.join(tempDir, 'organized'));
    const orgCheck = await run(python, ['-c', inspectAep, orgAep.project, 'organized'], {windowsHide: true, env: {...process.env, PYTHONUTF8: '1'}});
    assert.equal(orgCheck.stdout.trim(), 'PASS_PY_ORGANIZED');

    // 2. organize=false, precompLayers=true, ignoreHidden=false, target='aep'
    h.messages.length = 0;
    await h.context.exportSelectionSVG(true, false, false, true, true, false, {target: 'aep', precompLayers: true, mergeBlends: false, nativeImageMasks: true});
    const flatErr = h.messages.find(m => m.type === 'error');
    assert.equal(flatErr, undefined, flatErr?.message);
    const flatShip = h.messages.find(m => m.type === 'ship');
    const flatImages = collectImages(h.messages);
    for (const im of flatImages) if (im.shadowBase) im.shadowBase = null;
    assert.equal(flatShip.organize, true);
    const flatAep = await exportAep({...flatShip, images: flatImages}, path.join(tempDir, 'flat'));
    const flatCheck = await run(python, ['-c', inspectAep, flatAep.project, 'flat'], {windowsHide: true, env: {...process.env, PYTHONUTF8: '1'}});
    assert.equal(flatCheck.stdout.trim(), 'PASS_PY_FLAT');

    // 3. Turning precompLayers off restores normal behavior
    h.messages.length = 0;
    await h.context.exportSelectionSVG(true, true, true, true, true, false, {target: 'aep', precompLayers: false, mergeBlends: false, nativeImageMasks: true});
    const offShip = h.messages.find(m => m.type === 'ship');
    assert.equal(offShip.containers.some(c => c.singleLayer), false);
    assert.equal(offShip.containers.some(c => c.name === '文字A' || c.name === '形状B'), false);

    // 4. Vectorized text (outlineTexts=true) & PNG text inside clipping root (rasterTexts=true)
    const clippedText = at(node('TEXT', '溢出文字', {characters: 'Overflow', fills: solid(1, 1, 1)}), 20, 30, 100, 20);
    const clipRoot = at(node('FRAME', '裁剪画框', {clipsContent: true, children: [clippedText]}), 20, 30, 60, 40);
    Object.defineProperty(clippedText, 'absoluteRenderBounds', {
      get() { return {x: 30, y: 35, width: this.parent.clipsContent ? 10 : 50, height: 20}; }
    });
    const ch = harness(clipRoot);
    attachMockRenders(clipRoot, ch);
    const pngClip = await ch.run(true, false, true, true, {precompLayers: true});
    const overflowWrap = pngClip.ship.containers.find(c => c.name === '溢出文字');
    assert.ok(overflowWrap, 'Clipped PNG text gets its own precomp');
    assert.deepEqual([overflowWrap.x, overflowWrap.y, overflowWrap.w, overflowWrap.h], [10, 5, 50, 20],
      'Single-layer precomp uses unclipped render bounds so root clipping does not crop the inner PNG');

    // Vectorized text mode
    const vecText = at(node('TEXT', '矢量文字A', {
      characters: 'Vec', fills: solid(1, 1, 1),
      fillGeometry: [{data: 'M0 0H40V20H0Z', windingRule: 'NONZERO'}]
    }), 50, 60, 40, 20);
    const vecRoot = at(node('FRAME', '矢量画框', {children: [vecText]}), 10, 10, 200, 100);
    const vh = harness(vecRoot);
    vh.figma.flatten = nodes => {
      const out = at(node('VECTOR', nodes[0].name, {
        fills: nodes[0].fills, fillGeometry: [{data: 'M0 0H40V20H0Z', windingRule: 'NONZERO'}]
      }), 50, 60, 40, 20);
      out.remove = () => { out.removed = true; };
      return out;
    };
    const vecRes = await vh.run(true, false, true, false, {outlineTexts: true, precompLayers: true});
    assert.equal(vecRes.ship.texts.length, 0);
    assert.equal(vecRes.ship.nodes.length, 1);
    const vecWrap = vecRes.ship.containers.find(c => c.name === '矢量文字A');
    assert.ok(vecWrap && vecRes.ship.nodes[0].path.at(-1) === vecWrap.id);

    // 5. Direct selection of a single leaf node
    const singleText = at(node('TEXT', '单独文字', {characters: 'Only', fills: solid(1, 1, 1)}), 30, 40, 60, 20);
    const sh = harness(singleText);
    const singleRes = await sh.run(true, false, true, false, {precompLayers: true});
    assert.equal(singleRes.ship.organize, true);
    assert.equal(singleRes.ship.containers.length, 1);
    assert.equal(singleRes.ship.containers[0].name, '单独文字');
    assert.deepEqual(singleRes.ship.texts[0].path, [singleRes.ship.containers[0].id]);

    // 6. Simulated AE builder organize + UI bridge end-to-end
    testAeBuilderOrganize();
    await testUiBridgeFlow();

    console.log('PASS: single-layer precomps (organized + flat, real AEP inspection, vector/editable/png text, masks, blends, shadows, duplicates, AE builder organize, UI bridge)');
  } finally {
    await fsp.rm(tempDir, {recursive: true, force: true});
  }
}

check().catch(error => { console.error(error); process.exitCode = 1; });
