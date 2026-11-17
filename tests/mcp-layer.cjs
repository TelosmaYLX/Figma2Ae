'use strict';

// Layer commands are F2A's own additions to the embedded MCP block (mcp/src/layer-commands.js),
// dispatched ahead of the upstream handleCommand. This check runs the real figma-plugin/code.js in
// a VM against a fake Figma document, so it exercises the generated bundle rather than the source
// file: grouping requires one shared parent, ungrouping promotes children in place, reparenting
// keeps absolute positions, z-order lands where the index says, and a batch stops on the failing op
// while reporting what already applied.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../figma-plugin/code.js'), 'utf8');
let sequence = 0;
let autoNames = 0;

const identity = () => [[1, 0, 0], [0, 1, 0]];

// Results and children arrays are created inside the plugin's realm, so deepEqual (which compares
// prototypes) needs a copy made in this realm first.
const hostIds = list => Array.from(list, item => (typeof item === 'string' ? item : item && item.id));

class FakeNode {
  constructor(type, name, extra = {}) {
    this.id = 'n' + (++sequence);
    this.type = type;
    this.name = name || type;
    this.children = [];
    this.parent = null;
    this.visible = true;
    this.locked = false;
    this.x = 0;
    this.y = 0;
    this.width = 100;
    this.height = 60;
    this.relativeTransform = identity();
    if (type === 'FRAME' || type === 'COMPONENT' || type === 'INSTANCE') this.clipsContent = true;
    Object.assign(this, extra);
  }
  // No scaling in this fake: an absolute position is the sum of the relative offsets of every
  // ancestor, which is exactly the arithmetic reparent_nodes has to preserve.
  get absoluteTransform() {
    let x = this.x || 0;
    let y = this.y || 0;
    let parent = this.parent;
    while (parent && parent.type !== 'PAGE') {
      x += parent.x || 0;
      y += parent.y || 0;
      parent = parent.parent;
    }
    return [[1, 0, x], [0, 1, y]];
  }
  resize(width, height) {
    this.width = width;
    this.height = height;
  }
  insertChild(index, child) {
    if (child.parent) {
      const siblings = child.parent.children;
      const current = siblings.indexOf(child);
      if (current >= 0) siblings.splice(current, 1);
    }
    const at = Math.max(0, Math.min(index, this.children.length));
    this.children.splice(at, 0, child);
    child.parent = this;
  }
  appendChild(child) {
    this.insertChild(this.children.length, child);
  }
  remove() {
    if (this.parent) {
      const siblings = this.parent.children;
      siblings.splice(siblings.indexOf(this), 1);
    }
    this.parent = null;
    this.removed = true;
  }
}

class FakePage extends FakeNode {
  constructor(name) {
    super('PAGE', name, {selection: []});
  }
}

function harness() {
  const page = new FakePage('Layer page');
  const nodes = new Map([[page.id, page]]);
  const track = node => {
    nodes.set(node.id, node);
    return node;
  };
  page.appendChild = function (child) {
    FakeNode.prototype.appendChild.call(this, child);
    track(child);
  };
  const figma = {
    root: {name: 'F2A layer test', children: [page]},
    fileKey: 'layer-test-key',
    currentPage: page,
    mixed: Symbol('mixed'),
    showUI() {},
    on() {},
    notify() {},
    commitUndo() {},
    getNodeByIdAsync(id) {
      return Promise.resolve(nodes.get(id) || null);
    },
    createFrame() {
      return track(new FakeNode('FRAME', 'Frame ' + (++autoNames)));
    },
    createRectangle() {
      return track(new FakeNode('RECTANGLE', 'Rectangle ' + (++autoNames)));
    },
    group(list, parent) {
      for (const node of list) {
        if (node.parent !== parent) throw new Error('Nodes must have the same parent to be grouped');
      }
      const at = Math.min(...list.map(node => parent.children.indexOf(node)));
      const group = track(new FakeNode('GROUP', 'Group ' + (++autoNames)));
      parent.insertChild(at, group);
      for (const node of list.slice()) group.appendChild(node);
      return group;
    },
    ungroup(node) {
      if (node.type !== 'GROUP') throw new Error('Only groups can be ungrouped');
      const parent = node.parent;
      const at = parent.children.indexOf(node);
      const children = node.children.slice();
      for (let index = children.length - 1; index >= 0; index--) parent.insertChild(at, children[index]);
      node.remove();
      return children;
    }
  };
  const messages = [];
  figma.ui = {postMessage(message) { messages.push(message); }};
  const context = vm.createContext({
    figma,
    __html__: '',
    console: {log() {}, info() {}, debug() {}, warn() {}, error() {}},
    setTimeout,
    clearTimeout
  });
  vm.runInContext(source, context);
  const execute = (command, params) => context.F2AMCP.execute(command, params || {});
  const byName = name => {
    const stack = [page];
    while (stack.length) {
      const node = stack.pop();
      if (node.name === name) return node;
      for (const child of node.children) stack.push(child);
    }
    throw new Error('No node named ' + name);
  };
  return {page, figma, nodes, messages, execute, byName};
}

async function check() {
  const f = harness();
  const add = (type, name, parent, x = 0, y = 0) => {
    const node = new FakeNode(type, name, {x, y});
    (parent || f.page).appendChild(node);
    f.nodes.set(node.id, node);
    return node;
  };

  // --- group_nodes -------------------------------------------------------------------------
  const badge = add('RECTANGLE', 'badge', null, 20, 20);
  const label = add('TEXT', 'label', null, 30, 30);
  const grouped = await f.execute('group_nodes', {nodeIds: [badge.id, label.id], name: '状态/徽标'});
  assert.equal(grouped.ok, true);
  assert.equal(grouped.type, 'GROUP');
  assert.equal(grouped.name, '状态/徽标');
  assert.equal(grouped.grouped.length, 2);
  const group = f.nodes.get(grouped.nodeId);
  assert.equal(f.byName('状态/徽标'), group);
  assert.deepEqual(hostIds(group.children), [badge.id, label.id]);
  assert.equal(group.parent, f.page);
  // A group never clips: that is the whole reason it is preferred over a frame wrapper.
  assert.equal('clipsContent' in group, false);

  // Siblings are a hard requirement; the error names the offender instead of failing silently.
  const other = add('RECTANGLE', 'elsewhere', add('FRAME', 'other parent', null, 400, 0), 5, 5);
  await assert.rejects(f.execute('group_nodes', {nodeIds: [badge.id, other.id]}), /different parent/);
  await assert.rejects(f.execute('group_nodes', {nodeIds: []}), /non-empty/);
  assert.equal(f.page.children.includes(badge), false);

  // --- ungroup_nodes -----------------------------------------------------------------------
  const ungrouped = await f.execute('ungroup_nodes', {nodeIds: [grouped.nodeId]});
  assert.deepEqual(hostIds(ungrouped.affected).sort(), [badge.id, label.id].sort());
  assert.equal(ungrouped.skipped.length, 0);
  assert.equal(f.nodes.get(grouped.nodeId).removed, true);
  assert.equal(badge.parent, f.page);
  // Children are promoted back where the group sat, in their original order.
  assert.deepEqual(hostIds(f.page.children).slice(0, 2), [badge.id, label.id]);
  // A non-group is reported, not thrown, so a mixed list still tidies what it can.
  const skipped = await f.execute('ungroup_nodes', {nodeIds: [badge.id]});
  assert.deepEqual(hostIds(skipped.affected), []);
  assert.equal(skipped.skipped[0].reason, 'not a group');

  // --- reorder_nodes -----------------------------------------------------------------------
  const order = add('FRAME', 'order', null, 2000, 0);
  const a = add('RECTANGLE', 'a', order, 10, 20);
  const b = add('RECTANGLE', 'b', order, 30, 40);
  const c = add('RECTANGLE', 'c', order, 50, 60);
  const bottom = await f.execute('reorder_nodes', {nodeIds: [a.id], index: 0});
  assert.deepEqual(hostIds(order.children), [a.id, b.id, c.id]);
  assert.equal(bottom.moved[0].index, 0);
  // An index past the end appends: that is how a layer comes to the top without counting children.
  const top = await f.execute('reorder_nodes', {nodeIds: [a.id], index: 99});
  assert.equal(top.moved[0].index, order.children.length - 1);
  assert.deepEqual(hostIds(order.children), [b.id, c.id, a.id]);
  // Several ids keep their given order in one call.
  await f.execute('reorder_nodes', {nodeIds: [a.id, b.id], index: 0});
  assert.deepEqual(hostIds(order.children), [a.id, b.id, c.id]);
  await assert.rejects(f.execute('reorder_nodes', {nodeIds: [a.id]}), /index must be a number/);

  // --- reparent_nodes ----------------------------------------------------------------------
  const shelf = add('FRAME', 'shelf', null, 500, 300);
  const moved = await f.execute('reparent_nodes', {nodeIds: [a.id, b.id], newParentId: shelf.id});
  assert.equal(moved.moved.length, 2);
  assert.deepEqual(hostIds(shelf.children), [a.id, b.id]);
  // Absolute positions survive the move, so nothing jumps on canvas: a sat at 2000+10 on canvas and
  // lands at (1510, -280) inside a frame at (500, 300).
  assert.equal(a.absoluteTransform[0][2], 2010);
  assert.equal(a.x, 1510);
  assert.equal(a.y, -280);
  // Moving a node into its own subtree is refused per node instead of corrupting the tree.
  const inside = await f.execute('reparent_nodes', {nodeIds: [shelf.id], newParentId: a.id});
  assert.equal(inside.moved.length, 0);
  assert.match(inside.skipped[0].reason, /own subtree/);
  // keepPosition:false is plain Figma behaviour: the relative coordinates are kept as they are, so
  // the layer visually shifts with its new parent.
  await f.execute('reparent_nodes', {nodeIds: [c.id], newParentId: shelf.id, keepPosition: false});
  assert.equal(c.x, 50);

  // --- batch_rename_nodes ------------------------------------------------------------------
  const renamed = await f.execute('batch_rename_nodes', {renames: [
    {nodeId: a.id, name: 'Frame 1321318046 · 已命名'},
    {nodeId: 'missing:1', name: 'never lands'}
  ]});
  assert.equal(renamed.affected.length, 1);
  assert.equal(renamed.affected[0].previousName, 'a');
  assert.match(f.nodes.get(a.id).name, /已命名/);
  assert.equal(renamed.skipped[0].reason, 'not found');
  await assert.rejects(f.execute('batch_rename_nodes', {renames: []}), /non-empty/);

  // --- set_visible / set_locked -------------------------------------------------------------
  const hid = await f.execute('set_visible', {nodeIds: [badge.id], visible: false});
  assert.deepEqual(hostIds(hid.affected), [badge.id]);
  assert.equal(badge.visible, false);
  const locked = await f.execute('set_locked', {nodeIds: [badge.id, label.id], locked: true});
  assert.equal(locked.affected.length, 2);
  assert.equal(label.locked, true);
  // A missing id is reported, never fatal: a tidy-up over stale ids must still finish.
  const partial = await f.execute('set_visible', {nodeIds: [badge.id, 'missing:2'], visible: true});
  assert.deepEqual(hostIds(partial.affected), [badge.id]);
  assert.equal(partial.skipped[0].id, 'missing:2');

  // --- set_clips_content -------------------------------------------------------------------
  const clipped = await f.execute('set_clips_content', {nodeId: shelf.id, clipsContent: false});
  assert.equal(clipped.clipsContent, false);
  assert.equal(shelf.clipsContent, false);
  // A shape has no such property: refuse with a sentence an agent can act on.
  await assert.rejects(f.execute('set_clips_content', {nodeId: c.id, clipsContent: true}), /does not support clip content/);

  // --- search_nodes ------------------------------------------------------------------------
  const autoNamed = add('FRAME', 'Frame 1321318053', null, 900, 0);
  add('TEXT', 'Frame label', autoNamed);
  add('FRAME', 'Named section', null, 1200, 0);
  const byName = await f.execute('search_nodes', {name: 'frame 1321318053'});
  assert.equal(byName.count, 1);
  assert.equal(byName.nodes[0].id, autoNamed.id);
  assert.equal(byName.nodes[0].parentId, f.page.id);
  const byType = await f.execute('search_nodes', {type: 'TEXT'});
  assert.ok(byType.nodes.every(node => node.type === 'TEXT'));
  assert.ok(byType.nodes.length >= 2);
  // root scopes the walk, and depth counts from that root.
  const scoped = await f.execute('search_nodes', {name: 'Frame', root: autoNamed.id});
  assert.equal(scoped.count, 1);
  assert.equal(scoped.nodes[0].depth, 1);
  const limited = await f.execute('search_nodes', {type: 'RECTANGLE', limit: 1});
  assert.equal(limited.count, 1);
  assert.equal(limited.truncated, true);
  await assert.rejects(f.execute('search_nodes', {}), /Pass name, type or both/);

  // --- batch ------------------------------------------------------------------------------
  const built = await f.execute('batch', {ops: [
    {tool: 'create_frame', params: {x: 0, y: 0, width: 200, height: 200, name: '整理容器'}},
    {tool: 'create_rectangle', params: {x: 0, y: 0, width: 10, height: 10, parentId: '$0'}},
    {tool: 'batch_rename_nodes', params: {renames: [{nodeId: '$0', name: '容器/已整理'}]}}
  ]});
  assert.equal(built.ok, true);
  assert.equal(built.applied, 3);
  const container = f.nodes.get(built.results[0].result.id);
  assert.equal(container.name, '容器/已整理');
  assert.equal(container.children.length, 1);
  assert.equal(built.results[1].result.parentId, container.id);

  // A failure stops the pass, keeps what already applied, and says so - no silent rollback claim.
  const broken = await f.execute('batch', {ops: [
    {tool: 'set_visible', params: {nodeIds: [label.id], visible: false}},
    {tool: 'delete_node', params: {nodeId: 'missing:3'}},
    {tool: 'set_visible', params: {nodeIds: [label.id], visible: true}}
  ]});
  assert.equal(broken.ok, false);
  assert.equal(broken.applied, 1);
  assert.equal(broken.failedIndex, 1);
  assert.equal(broken.rolledBack, false);
  assert.equal(broken.results.length, 2);
  assert.equal(label.visible, false);
  // stopOnError:false runs the rest and still reports the failure.
  const continued = await f.execute('batch', {ops: [
    {tool: 'delete_node', params: {nodeId: 'missing:4'}},
    {tool: 'set_visible', params: {nodeIds: [label.id], visible: true}}
  ], stopOnError: false});
  assert.equal(continued.ok, true);
  assert.equal(continued.applied, 1);
  assert.equal(continued.results[0].ok, false);
  assert.equal(label.visible, true);
  // Reads and batch itself are not batchable: the whitelist is what keeps a pass predictable.
  const refused = await f.execute('batch', {ops: [{tool: 'get_selection', params: {}}]});
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not a batchable write command/);

  // --- the upstream path still works through the new dispatcher ----------------------------
  const selection = await f.execute('get_selection');
  assert.equal(selection.selectionCount, 0);
  await assert.rejects(f.execute('not_a_command'), /Unknown command/);

  console.log('PASS: 10 layer commands; group/ungroup, z-order, reparent with preserved position, bulk rename, visibility, lock, clip content, name/type search and sequential batch (with $N refs, stop-on-error, no-rollback reporting)');
}

check().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
