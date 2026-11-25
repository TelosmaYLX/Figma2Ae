'use strict';

// 「保留背景模糊」 offline AEP path: a Figma BACKGROUND_BLUR with a safe,
// single-contour silhouette becomes an AE adjustment layer carrying the
// F2A Figma Background Blur plug-in effect, masked by the source fill path and
// parented to the source precomp layer. The geometry contract lives in
// scripts/aep/background-blur-export.md; this test writes a real AEP through
// scripts/export-aep.cjs and inspects it with py_aep.

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {exportAep} = require('../scripts/export-aep.cjs');
const {normalize} = require('../scripts/aep/packet.cjs');

const root = path.resolve(__dirname, '..');
const python = process.env.F2A_PYTHON || path.join(root, '.venv-aep',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const run = promisify(execFile);
const CONTROLS = ['模式', '背景模糊半径 (px)', '开始半径 (px)', '结束半径 (px)',
  '渐变起点 X (%)', '渐变起点 Y (%)', '渐变终点 X (%)', '渐变终点 Y (%)', '柔化边缘 (AA)', 'Alpha源'];

// Two editable nodes, each wrapped in the same-named minimal precomp that
// 「单图层嵌套预合成」 produces (container id "<nodeId>-layer-precomp").
// Both containers start at the frame origin, so the source precomp layers sit
// in the main comp with an identity transform: parenting the adjustment layer
// then keeps the requested local transform values untouched.
function scene() {
  const node = (sourceId, name, container, width, height, color) => ({
    sourceId, name, path: [container],
    paths: [{d: 'M0 0H' + width + 'V' + height + 'H0Z', evenOdd: false}],
    matrix: [1, 0, 0, 1, 0, 0], prim: {k: 'rect', w: width, h: height, r: 0},
    fills: [{kind: 'solid', color, opacity: 1}], strokes: [],
  });
  const container = (id, name, width, height) => ({
    id, name, type: 'FRAME', root: false, path: [], z: 0,
    x: 0, y: 0, w: width, h: height, cb: {x: 0, y: 0, w: width, h: height},
    opacity: 1, blend: 'PASS_THROUGH', maskId: null, clip: false, r: 0,
    hidden: false, blur: 0, fx: [],
  });
  const nodes = [
    node('505:1207', '卡片', 'card-wrapper', 400, 200, [1, 0.5, 0.1]),
    node('505:1300', '徽章', 'badge-wrapper', 280, 120, [0.2, 0.6, 0.9]),
  ];
  const containers = [
    {...container('card-wrapper', '卡片', 400, 200), z: 0},
    {...container('badge-wrapper', '徽章', 280, 120), z: 1},
  ];
  return {nodes, containers};
}

// Round + arc silhouette: one closed contour, so it is a legal mask.
const BADGE_MASK = 'M20 0H260A20 20 0 0 1 280 20V100A20 20 0 0 1 260 120H20' +
  'A20 20 0 0 1 0 100V20A20 20 0 0 1 20 0Z';

function requests() {
  return [
    {sourceId: '505:1207', name: '卡片 背景模糊', container: 'card-wrapper', z: 2,
      size: [400, 200], position: [200, 100], rotation: 0, scale: [100, 100],
      mask: {kind: 'path', d: 'M0 0H400V200H0Z', windingRule: 'NONZERO'},
      mode: 'uniform', radius: 40, startRadius: 0, endRadius: 0,
      startOffset: [0.5, 0], endOffset: [0.5, 1]},
    {sourceId: '505:1300', name: '徽章 背景模糊', container: 'badge-wrapper', z: 3,
      size: [280, 120], position: [400, 250], rotation: 15, scale: [80, 120],
      mask: {kind: 'path', d: BADGE_MASK, windingRule: 'NONZERO'},
      mode: 'progressive', radius: 0, startRadius: 4, endRadius: 22,
      startOffset: [0.5, 0], endOffset: [0.5, 1]},
  ];
}

function packet(withBlurs) {
  const {nodes, containers} = scene();
  return {
    name: '模糊测试', svg: '<svg width="640" height="360"></svg>',
    frame: {width: 640, height: 360}, duration: 2, frameRate: 24,
    nodes, containers, organize: true,
    backgroundBlurs: withBlurs ? requests() : [],
  };
}

// Structural contract from scripts/aep/background-blur-export.md, checked from the AEP
// itself (no After Effects). `expected.json` is the normalized packet model.
const inspect = `
import json, sys
import py_aep
from py_aep.enums import MaskMode

project = py_aep.parse(sys.argv[1]).project
expected = json.loads(open(sys.argv[2], encoding='utf-8').read())
requests = expected['backgroundBlurs']
assert len(requests) == 2, 'expected two retained background blurs'
main = next(item for item in project.items.values()
            if hasattr(item, 'layers') and item.name == expected['name'])
layers = main.layers
labels = ${JSON.stringify(CONTROLS)}

def named(name):
    matches = [layer for layer in layers if layer.name == name]
    assert len(matches) == 1, (name, [layer.name for layer in layers])
    return matches[0]

for request in requests:
    size = request['size']
    width, height = max(1, round(size[0])), max(1, round(size[1]))
    adjustment = named(request['name'])
    assert adjustment.adjustment_layer is True, request['name']
    assert type(adjustment.source).__name__ == 'FootageItem'
    assert (adjustment.source.width, adjustment.source.height) == (width, height)
    # Transform (2D, request values; identity source layer keeps them uncompensated).
    anchor = adjustment.transform.anchor_point.value
    assert abs(anchor[0] - size[0] / 2) < 1e-4 and abs(anchor[1] - size[1] / 2) < 1e-4
    assert anchor[2] == 0
    position = adjustment.transform.position.value
    assert abs(position[0] - request['position'][0]) < 1e-4, position
    assert abs(position[1] - request['position'][1]) < 1e-4, position
    assert abs(adjustment.transform.rotation.value - request['rotation']) < 1e-3
    scale = adjustment.transform.scale.value
    assert abs(scale[0] - request['scale'][0]) < 1e-4 and abs(scale[1] - request['scale'][1]) < 1e-4
    assert abs(scale[2] - 100) < 1e-6
    # Exactly one ADD mask atom, hard edged, with the fill path's bounds.
    masks = list(adjustment['ADBE Mask Parade'])
    assert len(masks) == 1, 'one mask atom per adjustment layer'
    mask = masks[0]
    assert mask.mask_mode == MaskMode.ADD, mask.mask_mode
    feather = [float(value) for value in mask['ADBE Mask Feather'].value]
    assert feather == [0.0, 0.0], feather
    shape = mask['ADBE Mask Shape'].value
    sub = request['mask']['subpaths'][0]
    assert shape.closed == bool(sub['closed'])
    assert len(shape.vertices) == len(sub['verts'])
    for axis in (0, 1):
        assert abs(min(v[axis] for v in shape.vertices) - min(v[axis] for v in sub['verts'])) < 1e-3
        assert abs(max(v[axis] for v in shape.vertices) - max(v[axis] for v in sub['verts'])) < 1e-3
    # The plug-in effect with Figma's values, mask mode (Alpha源 left at 0).
    effects = [effect for effect in adjustment['ADBE Effect Parade']
               if effect.match_name == 'F2A Figma Background Blur']
    assert len(effects) == 1
    effect = effects[0]
    assert effect.name == 'Figma 背景模糊', effect.name
    params = [prop for prop in effect.properties
              if prop.match_name and prop.match_name.startswith('F2A Figma Background Blur-')]
    assert len(params) == 10, [prop.name for prop in params]
    assert [prop.name for prop in params] == labels, [prop.name for prop in params]
    start, end = request['startOffset'], request['endOffset']
    wanted = [1 if request['mode'] == 'uniform' else 2, request['radius'],
              request['startRadius'], request['endRadius'],
              start[0] * 100, start[1] * 100, end[0] * 100, end[1] * 100, 0, 0]
    got = [float(prop.value) for prop in params]
    assert got == wanted, (got, wanted)
    # Directly below the source layer, parented to it so transforms follow.
    container = next(value for value in expected['containers']
                     if value['id'] == request['container'])
    source = named(container['name'])
    assert adjustment.parent is not None and adjustment.parent.id == source.id
    assert layers.index(adjustment) == layers.index(source) + 1, (
        'adjustment layer must sit immediately below its source', layers.index(adjustment), layers.index(source))
print('PASS: ' + str(len(requests)) + ' adjustment layers with mask, effect, transform, parenting and stack order')
`;

const inspectPlain = `
import sys
import py_aep
project = py_aep.parse(sys.argv[1]).project
main = next(item for item in project.items.values()
            if hasattr(item, 'layers') and item.name == sys.argv[2])
for comp in project.compositions:
    assert not any(layer.adjustment_layer for layer in comp.layers), comp.name
print('PASS: packet without backgroundBlurs has no adjustment layers')
`;

async function check() {
  const fixtures = path.join(root, 'artifacts', 'aep-background-blur');
  await fs.mkdir(fixtures, {recursive: true});
  const directory = await fs.mkdtemp(path.join(fixtures, 'run-'));
  const env = {...process.env, PYTHONUTF8: '1'};
  try {
    // Validation: the writer only understands one mask contour, and a bad
    // request must be rejected with the source node id before AEP writing.
    const twoContours = {...requests()[0],
      mask: {kind: 'path', d: 'M0 0H100V100H0Z M200 200H300V300H200Z', windingRule: 'NONZERO'}};
    assert.throws(() => normalize({...packet(false), backgroundBlurs: [twoContours]}),
      error => error.nodeId === '505:1207' && /一条子路径/.test(error.message));
    assert.throws(() => normalize({...packet(false), backgroundBlurs: [{...requests()[0], radius: '40'}]}),
      /模糊半径/);
    assert.throws(() => normalize({...packet(false), backgroundBlurs: [{...requests()[0], mode: 'linear'}]}),
      /模糊模式/);

    // A request whose source layer was never created fails loudly (no silent skip).
    await assert.rejects(
      exportAep({...packet(true), backgroundBlurs: [{...requests()[0], container: 'missing-wrapper'}]},
        path.join(directory, 'missing')),
      error => /找不到背景模糊的源图层/.test(error.message) && error.nodeId === '505:1207');

    // Uniform + progressive requests: check the parsed model and the real AEP.
    const blurred = packet(true);
    await fs.writeFile(path.join(fixtures, 'packet.json'), JSON.stringify(blurred));
    const expected = normalize(blurred);
    assert.equal(expected.backgroundBlurs.length, 2);
    const [uniform, progressive] = expected.backgroundBlurs;
    assert.deepEqual(uniform.mask.subpaths[0].verts, [[0, 0], [400, 0], [400, 200], [0, 200]]);
    assert.equal(uniform.mask.subpaths[0].closed, true);
    assert.equal(progressive.mask.subpaths.length, 1);
    assert.equal(progressive.mask.subpaths[0].verts.length, 8, 'the rounded path keeps its arc vertices');
    await fs.writeFile(path.join(fixtures, 'expected.json'), JSON.stringify(expected));

    const result = await exportAep(blurred, path.join(directory, 'effect'));
    assert.equal(result.backgroundBlur, 'effect');
    assert.equal(result.backgroundBlurs, 2);
    assert.equal(result.counts.backgroundBlurs, 2);
    assert.equal(result.counts.precomps, 2);
    assert.equal(result.warnings.length, 0, JSON.stringify(result.warnings));
    await run(python, ['-c', inspect, result.project, path.join(fixtures, 'expected.json')],
      {windowsHide: true, env});

    // A plain packet keeps the previous behaviour: no adjustment layers, but a
    // valid project that reports the option as unused.
    const plain = packet(false);
    await fs.writeFile(path.join(fixtures, 'packet-plain.json'), JSON.stringify(plain));
    assert.deepEqual(normalize(plain).backgroundBlurs, []);
    const plainResult = await exportAep(plain, path.join(directory, 'plain'));
    assert.equal(plainResult.backgroundBlur, null);
    assert.equal(plainResult.backgroundBlurs, 0);
    assert.equal(plainResult.counts.backgroundBlurs, 0);
    assert.equal(plainResult.warnings.length, 0, JSON.stringify(plainResult.warnings));
    await run(python, ['-c', inspectPlain, plainResult.project, plain.name], {windowsHide: true, env});
    console.log('PASS: 保留背景模糊 offline AEP path; adjustment layers, fill-path masks, plug-in values, parenting; unsupported masks fail with nodeId');
  } finally {
    await fs.rm(directory, {recursive: true, force: true});
  }
}

if (require.main === module) check().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = {packet, requests, inspect, BADGE_MASK};
