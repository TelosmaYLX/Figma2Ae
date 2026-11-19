const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../figma-plugin/code.js'), 'utf8');
let id = 0;
const identity = () => [[1, 0, 0], [0, 1, 0]];
function compose(a, b) {
  return [0, 1].map(row => [
    a[row][0] * b[0][0] + a[row][1] * b[1][0],
    a[row][0] * b[0][1] + a[row][1] * b[1][1],
    a[row][0] * b[0][2] + a[row][1] * b[1][2] + a[row][2]
  ]);
}
class Layer {
  constructor(type, name, children = [], extra = {}) {
    Object.assign(this, {id: String(++id), type, name, children: [], parent: null, visible: true, locked: false, opacity: 1,
      blendMode: 'PASS_THROUGH', fills: [], strokes: [], effects: [], clipsContent: false, layoutMode: 'NONE', width: 100, height: 60, relativeTransform: identity()}, extra);
    children.forEach(c => this.appendChild(c));
  }
  get absoluteTransform() { return compose(this.parent ? this.parent.absoluteTransform : identity(), this.relativeTransform); }
  resize(w, h) { this.width = w; this.height = h; }
  appendChild(child) { this.insertChild(this.children.length, child); }
  insertChild(index, child) {
    const previousParent = child.parent;
    if (previousParent) previousParent.children.splice(previousParent.children.indexOf(child), 1);
    this.children.splice(index, 0, child); child.parent = this;
    // Figma removes a GROUP as soon as its last child is reparented.
    if (previousParent?.type === 'GROUP' && previousParent.children.length === 0) previousParent.remove();
  }
  get locked() {
    if (this.removed) throw new Error(`The node with id '${this.id}' does not exist`);
    return this._locked;
  }
  set locked(value) { this._locked = value; }
  remove() {
    if (this.parent?.type === 'INSTANCE') throw new Error('Cannot remove instance children');
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.removed = true; this.parent = null;
  }
  detachInstance() {
    assert.equal(this.type, 'INSTANCE');
    const frame = new Layer('FRAME', this.name, [], {relativeTransform: this.relativeTransform, opacity: this.opacity});
    this.parent.insertChild(this.parent.children.indexOf(this), frame);
    this.children.slice().forEach(c => frame.appendChild(c)); this.remove(); return frame;
  }
}
function harness(nodes, selection = nodes) {
  const page = new Layer('PAGE', 'Page', nodes); page.selection = selection;
  const messages = []; let undos = 0;
  const figma = {mixed: Symbol(), currentPage: page, showUI() {}, on() {}, ui: {postMessage(m) { messages.push(m); }},
    createFrame() { const n = new Layer('FRAME', 'Frame', [], {fills: [{type: 'SOLID', color: {r: 1, g: 1, b: 1}}]}); page.appendChild(n); return n; },
    commitUndo() { undos++; }};
  const context = vm.createContext({figma, __html__: ''}); vm.runInContext(source, context);
  const html = fs.readFileSync(path.join(__dirname, '../figma-plugin/ui.html'), 'utf8'), elements = {}, window = {};
  for (const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) elements[m[1]] = {checked: /\bchecked\b/.test(m[0]), disabled: /\bdisabled\b/.test(m[0])};
  elements['raster-scale'].value='1';
  elements['native-image-masks'].value='separate';
  vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], {
    window, document: {getElementById: id => elements[id]}, WebSocket: function () {},
    parent: {postMessage(m) { figma.ui.onmessage(m.pluginMessage); }}, setTimeout() {}
  });
  figma.ui.postMessage = m => { messages.push(m); window.onmessage({data: {pluginMessage: m}}); };
  context.reportSelection();
  const buttons = {detach: 'detach-instances', 'group-to-frame': 'convert-groups', 'delete-hidden': 'delete-hidden', expand: 'expand-groups'};
  return {page, figma, messages, get undos() { return undos; }, run(action) {
    messages.length = 0; assert.equal(elements[buttons[action]].disabled, false); elements[buttons[action]].onclick();
    assert.equal(messages.find(m => m.type === 'error'), undefined);
    assert.equal(context._exporting, false);
    assert.equal(elements[buttons[action]].disabled, false);
  }};
}
function sameTransform(actual, expected) {
  for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) assert.ok(Math.abs(actual[i][j] - expected[i][j]) < 1e-8, JSON.stringify({actual, expected}));
}
const child = new Layer('RECTANGLE', 'Mirrored child', [], {relativeTransform: [[-1, 0.2, 5], [0, 1, 9]]});
const group = new Layer('GROUP', 'Rotated group', [child], {relativeTransform: [[0.866, -0.5, 12], [0.5, 0.866, 18]], opacity: 0.6, blendMode: 'SOFT_LIGHT', effects: [{type: 'LAYER_BLUR', radius: 2}]});
const before = new Layer('RECTANGLE', 'Before'), after = new Layer('RECTANGLE', 'After');
const parent = new Layer('FRAME', 'Scaled parent', [before, group, after], {relativeTransform: [[0, -2, 100], [2, 0, 50]]});
const conversion = harness([parent], [group]), childPose = child.absoluteTransform, groupPose = group.absoluteTransform;
conversion.run('group-to-frame');
const frame = conversion.page.selection[0];
assert.equal(frame.type, 'FRAME'); assert.equal(frame.name, 'Rotated group'); assert.equal(frame.opacity, 0.6); assert.equal(frame.blendMode, 'SOFT_LIGHT');
assert.equal(frame.effects[0].radius, 2); assert.equal(frame.fills.length, 0); assert.equal(frame.clipsContent, false);
assert.equal(group.removed, true, 'The source GROUP is automatically removed after its last child leaves');
assert.deepEqual(parent.children.map(n => n.name), ['Before', 'Rotated group', 'After']);
sameTransform(child.absoluteTransform, childPose); sameTransform(frame.absoluteTransform, groupPose); assert.equal(conversion.undos, 1);

// Model a Figma GROUP changing its local origin after a structural edit while preserving
// existing child poses. Reusing relative matrices captured before that edit would drift.
function shiftingParent(parent) {
  function shift() {
    const m = parent.relativeTransform;
    parent.relativeTransform = [[m[0][0], m[0][1], m[0][2] + 7], [m[1][0], m[1][1], m[1][2]]];
    parent.children.forEach(c => {
      const t = c.relativeTransform;
      c.relativeTransform = [[t[0][0], t[0][1], t[0][2] - 7], [t[1][0], t[1][1], t[1][2]]];
    });
  }
  const insert = parent.insertChild.bind(parent);
  parent.insertChild = (i, n) => { insert(i, n); shift(); };
  for (const c of parent.children) {
    const remove = c.remove.bind(c);
    c.remove = () => { remove(); shift(); };
  }
  return parent;
}
const movingChild = new Layer('RECTANGLE', 'Moving child', [], {relativeTransform: [[-1, 0.2, 5], [0, 1, 9]]});
const movingGroup = new Layer('GROUP', 'Converted', [movingChild], {relativeTransform: [[1, 0, 30], [0, 1, 20]], locked: true});
const shifting = shiftingParent(new Layer('GROUP', 'Dynamic parent', [movingGroup]));
const shiftingConversion = harness([shifting], [movingGroup]), savedMovingPose = movingChild.absoluteTransform, savedMovingGroupPose = movingGroup.absoluteTransform;
shiftingConversion.run('group-to-frame'); sameTransform(movingChild.absoluteTransform, savedMovingPose);
const shiftedFrame = shiftingConversion.page.selection[0];
sameTransform(shiftedFrame.absoluteTransform, savedMovingGroupPose);
assert.equal(shiftedFrame.locked, true, 'Cache locked before the source GROUP disappears');
assert.equal(movingGroup.removed, true);

const expandChild = new Layer('RECTANGLE', 'Expanded child', [], {relativeTransform: [[-1, 0.2, 5], [0, 1, 9]]});
const expandGroup = new Layer('GROUP', 'Expanded group', [expandChild], {relativeTransform: [[1, 0, 30], [0, 1, 20]]});
const shiftingExpandRoot = shiftingParent(new Layer('GROUP', 'Dynamic expand root', [expandGroup]));
const shiftingExpansion = harness([shiftingExpandRoot]), savedExpandPose = expandChild.absoluteTransform;
shiftingExpansion.run('expand'); sameTransform(expandChild.absoluteTransform, savedExpandPose);
const maskGroup = new Layer('GROUP', 'Mask group', [new Layer('RECTANGLE', 'Mask shape')], {isMask: true});
const maskConversion = harness([maskGroup]); maskConversion.run('group-to-frame');
assert.equal(maskGroup.type, 'GROUP'); assert.equal(maskGroup.removed, undefined);
assert.equal(maskConversion.undos, 0, 'Keep vector mask group semantics intact');

const nested = new Layer('INSTANCE', 'Nested', [new Layer('TEXT', 'Title')]);
const selected = new Layer('INSTANCE', 'Selected', [nested]), untouched = new Layer('INSTANCE', 'Outside');
const detachment = harness([selected, untouched], [selected]); detachment.run('detach');
assert.equal(detachment.page.selection[0].type, 'FRAME'); assert.equal(detachment.page.selection[0].children[0].type, 'FRAME');
assert.equal(untouched.type, 'INSTANCE'); assert.equal(untouched.parent, detachment.page); assert.equal(detachment.undos, 1);

const hidden = new Layer('GROUP', 'Hidden subtree', [new Layer('TEXT', 'Hidden descendant')], {visible: false});
const innerHidden = new Layer('TEXT', 'Hidden leaf', [], {visible: false});
const protectedHidden = new Layer('TEXT', 'Inside instance', [], {visible: false});
const cleanRoot = new Layer('FRAME', 'Clean root', [hidden, new Layer('GROUP', 'Visible', [innerHidden]), new Layer('INSTANCE', 'Keep instance', [protectedHidden])]);
const cleanup = harness([cleanRoot], [cleanRoot, hidden]); cleanup.run('delete-hidden');
assert.equal(hidden.removed, true); assert.equal(innerHidden.removed, true); assert.equal(protectedHidden.removed, undefined); assert.equal(cleanRoot.removed, undefined);
assert.match(cleanup.messages.find(m => m.type === 'tool-result').message, /2/); assert.equal(cleanup.undos, 1);

const leaf = new Layer('RECTANGLE', 'Leaf', [], {relativeTransform: [[-1, 0, 8], [0, 1, 5]]});
const empty = new Layer('GROUP', 'Empty', [new Layer('GROUP', 'Nested empty', [leaf])], {relativeTransform: [[0, -1, 30], [1, 0, 10]]});
const painted = new Layer('FRAME', 'Painted', [], {fills: [{type: 'SOLID'}]});
const clipped = new Layer('FRAME', 'Clip', [], {clipsContent: true});
const faded = new Layer('GROUP', 'Faded', [], {opacity: 0.5});
const masked = new Layer('GROUP', 'Mask scope', [new Layer('RECTANGLE', 'Mask', [], {isMask: true}), new Layer('GROUP', 'Masked group')]);
const expandRoot = new Layer('FRAME', 'Root', [empty, painted, clipped, faded, masked]);
const expansion = harness([expandRoot]), leafPose = leaf.absoluteTransform; expansion.run('expand');
assert.deepEqual(expandRoot.children.map(n => n.name), ['Leaf', 'Painted', 'Clip', 'Faded', 'Mask scope']);
sameTransform(leaf.absoluteTransform, leafPose); assert.equal(masked.children.length, 2);
assert.match(expansion.messages.find(m => m.type === 'tool-result').message, /2/);
console.log('PASS: scoped tools, nested detach, transform/style/order preservation, hidden cleanup, undo, protected paint/clipping/masks');
