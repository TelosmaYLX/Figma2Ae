const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {node, group, harness} = require('./export-options.cjs');
const {png} = require('./direct-aep.cjs');
const {normalize} = require('../scripts/aep/packet.cjs');
const {exportAep} = require('../scripts/export-aep.cjs');

function at(n, x, y, width, height) {
  return Object.assign(n, {width, height, absoluteBoundingBox: {x, y, width, height},
    absoluteRenderBounds: {x, y, width, height}, absoluteTransform: [[1, 0, x], [0, 1, y]]});
}
function rect(name, x, y, width, height, color) {
  return at(node('RECTANGLE', name, {cornerRadius: 0, fills: [{type: 'SOLID', color}],
    fillGeometry: [{data: `M0 0H${width}V${height}H0Z`, windingRule: 'NONZERO'}]}), x, y, width, height);
}

async function check() {
  const blue = {r: .05, g: .6, b: .95}, orange = {r: 1, g: .4, b: .1};
  const button = at(node('FRAME', 'Fractional button', {children: [
    rect('Button artwork', 626.625, 280.625, 91.25, 35.5, blue)]}), 626.625, 280.625, 91.25, 35.5);
  const buttons = at(group('Button group', [button,
    rect('Bottom button', 570.375, 331.625, 203, 46, orange)]), 570.375, 280.625, 203, 97);
  const overflow = at(node('FRAME', 'Unclipped frame', {children: [
    rect('Visible overflow', 510.125, 390.375, 103, 63, blue)]}), 520.125, 400.375, 83, 43);
  const clip = at(node('FRAME', 'Clipped frame', {clipsContent: true, children: [
    rect('Clipped artwork', 890.125, 390.375, 121, 81, orange)]}), 900.125, 400.375, 101, 61);
  const faded = at(node('FRAME', 'Faded frame', {opacity: .5, children: [
    rect('Faded red', 510.125, 210.375, 70, 60, orange),
    rect('Faded blue', 540.125, 230.375, 73, 63, blue)]}), 520.125, 220.375, 83, 43);
  const root = at(node('FRAME', 'Composition bounds', {children: [buttons, overflow, clip, faded]}), 500.125, 200.375, 641, 361);
  const h = harness(root);
  (function render(n) {n.exportAsync = async () => png(); if(n.children)n.children.forEach(render);})(root);
  const {ship} = await h.run(true, true, true);
  const packet = {...ship, images: [], imageCount: 0};
  // The old content-union metadata deliberately exceeds this frame. Both exporters must
  // use the original box while retaining the overflow in the parent composition.
  assert.ok(packet.containers.find(c => c.name === 'Unclipped frame').cb.w > 83);
  const model = normalize(packet);
  assert.equal(model.containers.length, 6);
  const directory = await fs.mkdtemp(path.resolve(__dirname, '../artifacts/comp-bounds-'));
  const result = await exportAep(packet, directory);
  await fs.writeFile(path.resolve(__dirname, '../artifacts/comp-bounds-native.json'), JSON.stringify({
    project: result.project, directory, model
  }));
  const python = process.env.F2A_PYTHON || path.resolve(__dirname, '../.venv-aep/Scripts/python.exe');
  const checked = await promisify(execFile)(python, [path.join(__dirname, 'check-comp-bounds.py'),
    path.resolve(__dirname, '../artifacts/comp-bounds-native.json')], {windowsHide: true, env: {...process.env, PYTHONUTF8: '1'}});
  console.log(checked.stdout.trim());
  console.log('PASS: exported nested groups, odd/fractional dimensions, non-clipping overflow and clipping frame');
  console.log(directory);
}
check().catch(error => {console.error(error); process.exitCode = 1;});
