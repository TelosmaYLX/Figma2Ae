const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {node, group, harness} = require('./export-options.cjs');
const root = path.join(__dirname, '..');
const before = execFileSync('git', ['-c', 'safe.directory=' + root.replaceAll('\\', '/'), 'show', 'HEAD:figma-plugin/code.js'], {cwd: root, encoding: 'utf8'});
function measure(code) {
  let effectReads = 0, boundsReads = 0;
  const nodes = [];
  function instrument(n) {
    nodes.push(n);
    const effects = n.effects, bounds = n.absoluteBoundingBox;
    Object.defineProperty(n, 'effects', {get() { effectReads++; return effects; }});
    Object.defineProperty(n, 'absoluteBoundingBox', {get() { boundsReads++; return bounds; }});
    return n;
  }
  let tree = instrument(group('底层', [instrument(node('TEXT', '文字')), instrument(node('VECTOR', '光效', {effects: [{type: 'LAYER_BLUR', radius: 8}]}))]));
  for (let i = 0; i < 48; i++) tree = instrument(group('组 ' + i, [tree]));
  const h = harness(tree, code); effectReads = 0; boundsReads = 0;
  h.context._collectRasterCandidates(tree);
  const flagReads = effectReads;
  h.context._contentBoundsByNode = {};
  for (const n of [...nodes].reverse()) h.context._contentBounds(n);
  return {nodes: nodes.length, flagReads, boundsReads};
}
(async () => {
  const old = measure(before), current = measure(undefined);
  assert.ok(current.flagReads < old.flagReads / 10);
  assert.ok(current.boundsReads < old.boundsReads / 10);
  const makeScene = () => group('画框', [node('TEXT', '文字')]);
  const oldExport = harness(makeScene(), before), newExport = harness(makeScene());
  await oldExport.run(); await newExport.run();
  assert.equal(oldExport.calls.svg, 1); assert.equal(newExport.calls.svg, 0);
  assert.equal(oldExport.calls.fonts, 1); assert.equal(newExport.calls.fonts, 0);
  const sample = fs.statSync(path.join(root, 'SampleProject/pinball_game_container.svg')).size;
  const message = newExport.messages.find(m => m.type === 'ship');
  const report = {baseline: 'HEAD before this optimization; synthetic 49-level tree', before: old, after: current,
    editableExport: {before: oldExport.calls, after: newExport.calls}, sampleSvgBytes: sample, headerBytes: Buffer.byteLength(message.svg),
    note: 'Counts and payload sizes; not an end-to-end Figma/AE timing measurement'};
  fs.mkdirSync(path.join(root, 'artifacts/export-speed'), {recursive: true});
  fs.writeFileSync(path.join(root, 'artifacts/export-speed/report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
