// F2A layer-organisation commands.
//
// Embedded into the generated F2AMCP block by scripts/build-mcp.cjs. Upstream (vendor/) stays
// unmodified: these are F2A's own commands, dispatched ahead of handleCommand. They exist because
// the upstream command set cannot tidy a real design file: it has no group / ungroup, no z-order
// change, no visibility or lock control, no clip-content switch and no way to rename more than one
// node per round trip.
//
// Every command returns a plain JSON-serialisable object. Missing or unsupported nodes are skipped
// and reported instead of failing a whole batch, because a tidy-up runs over dozens of ids at a
// time and one stale id must not throw away the rest of the work.
//
// The command shapes follow the MIT-licensed Figwright (github.com/awdr74100/figwright): one tool
// per layer operation, "$N" self-references inside a batch, and skipping instead of aborting.

var F2A_LAYER_COMMANDS = {
  group_nodes: groupNodes,
  ungroup_nodes: ungroupNodes,
  reorder_nodes: reorderNodes,
  reparent_nodes: reparentNodes,
  batch_rename_nodes: batchRenameNodes,
  set_visible: setVisible,
  set_locked: setLocked,
  set_clips_content: setClipsContent,
  search_nodes: searchNodes,
  detach_instances: detachInstances,
  batch: batchCommand
};

// Write commands a batch op may run. Reads are excluded (a batch is one edit pass, and a read would
// only cost relay time); `batch` excludes itself; deletes stay available so one pass can drop empty
// leftovers, and they are the reason a batch is documented as sequential without rollback.
var F2A_BATCH_COMMANDS = {
  create_frame: true, create_rectangle: true, create_text: true, create_section: true,
  create_component_instance: true, clone_node: true, delete_node: true, delete_multiple_nodes: true,
  move_node: true, resize_node: true, set_parent: true, rename_node: true,
  set_fill_color: true, set_stroke_color: true, set_corner_radius: true, set_image_fill: true,
  set_text_content: true, set_multiple_text_contents: true,
  set_layout_mode: true, set_padding: true, set_axis_align: true, set_layout_sizing: true,
  set_item_spacing: true, set_annotation: true, set_multiple_annotations: true,
  set_instance_overrides: true, create_connections: true, set_default_connector: true,
  set_focus: true, set_selections: true,
  group_nodes: true, ungroup_nodes: true, reorder_nodes: true, reparent_nodes: true,
  batch_rename_nodes: true, set_visible: true, set_locked: true, set_clips_content: true,
  detach_instances: true
};

function f2aIds(params, field) {
  var key = field || 'nodeIds';
  var value = params && params[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(key + ' must be a non-empty array of node ids');
  }
  for (var i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string' || !value[i]) {
      throw new Error(key + ' must contain node ids only');
    }
  }
  return value;
}

async function f2aResolve(ids) {
  var nodes = [], missing = [];
  for (var i = 0; i < ids.length; i++) {
    var node = await figma.getNodeByIdAsync(ids[i]);
    if (node) nodes.push(node); else missing.push(ids[i]);
  }
  return { nodes: nodes, missing: missing };
}

function f2aDescribe(node) {
  return '"' + (node.name || '') + '" (' + node.type + ')';
}

// Absolute position, so a move can keep the layer where the designer left it.
function f2aAbsolute(node) {
  if (!node || !node.absoluteTransform) return null;
  return { x: node.absoluteTransform[0][2], y: node.absoluteTransform[1][2] };
}

function f2aRestorePosition(node, absolute, parent) {
  if (!absolute || !('x' in node) || !('y' in node)) return;
  var origin = f2aAbsolute(parent) || { x: 0, y: 0 };
  node.x = absolute.x - origin.x;
  node.y = absolute.y - origin.y;
}

// figma.group() requires every node to be a sibling. Report the first offender by name instead of
// letting Figma fail with a bare "nodes must have the same parent".
async function groupNodes(params) {
  var ids = f2aIds(params);
  var resolved = await f2aResolve(ids);
  if (resolved.nodes.length === 0) {
    throw new Error('No node found for: ' + resolved.missing.join(', '));
  }
  var parent = resolved.nodes[0].parent;
  if (!parent) throw new Error('The first node has no parent');
  if (!('appendChild' in parent)) {
    throw new Error('The parent of ' + f2aDescribe(resolved.nodes[0]) + ' cannot contain children');
  }
  for (var i = 0; i < resolved.nodes.length; i++) {
    if (resolved.nodes[i].parent !== parent) {
      throw new Error(f2aDescribe(resolved.nodes[i]) + ' has a different parent; move the layers into one parent with reparent_nodes first');
    }
  }
  var group = figma.group(resolved.nodes, parent);
  if (typeof params.name === 'string' && params.name) group.name = params.name;
  var label = group.name;
  return {
    ok: true,
    nodeId: group.id,
    name: label,
    type: group.type,
    parentId: parent.id,
    index: parent.children.indexOf(group),
    grouped: resolved.nodes.map(function (node) { return node.id; }),
    skipped: resolved.missing
  };
}

// figma.ungroup() only knows GROUP and Figma Draw's TRANSFORM_GROUP; everything else is reported
// back rather than silently ignored.
async function ungroupNodes(params) {
  var ids = f2aIds(params);
  var resolved = await f2aResolve(ids);
  var affected = [], skipped = [];
  for (var i = 0; i < resolved.nodes.length; i++) {
    var node = resolved.nodes[i];
    if (node.type !== 'GROUP' && node.type !== 'TRANSFORM_GROUP') {
      skipped.push({ id: node.id, name: node.name, type: node.type, reason: 'not a group' });
      continue;
    }
    var children = figma.ungroup(node);
    for (var c = 0; c < children.length; c++) affected.push(children[c].id);
  }
  for (var m = 0; m < resolved.missing.length; m++) {
    skipped.push({ id: resolved.missing[m], reason: 'not found' });
  }
  return { ok: true, affected: affected, skipped: skipped };
}

// Z-order within the current parent. `index` is a child index (0 = bottom of the stack) and each id
// lands one step further up, so the given order is preserved; an index at or past the last child
// appends, which is how a layer is brought to the top without knowing the child count.
async function reorderNodes(params) {
  var ids = f2aIds(params);
  if (typeof params.index !== 'number' || !isFinite(params.index)) {
    throw new Error('index must be a number (0 = bottom of the stack)');
  }
  var resolved = await f2aResolve(ids);
  var moved = [], skipped = [];
  for (var i = 0; i < resolved.nodes.length; i++) {
    var node = resolved.nodes[i];
    var parent = node.parent;
    if (!parent || !('insertChild' in parent)) {
      skipped.push({ id: node.id, name: node.name, reason: 'has no reorderable parent' });
      continue;
    }
    var target = params.index + i;
    if (target >= parent.children.length) parent.appendChild(node);
    else parent.insertChild(target, node);
    moved.push({ id: node.id, name: node.name, index: parent.children.indexOf(node) });
  }
  for (var m = 0; m < resolved.missing.length; m++) {
    skipped.push({ id: resolved.missing[m], reason: 'not found' });
  }
  return { ok: true, moved: moved, skipped: skipped };
}

// Move layers into another parent, keeping their on-canvas position unless keepPosition is false.
// Unlike set_parent this takes many ids in one call and refuses a move into the node's own subtree.
async function reparentNodes(params) {
  var ids = f2aIds(params);
  if (typeof params.newParentId !== 'string' || !params.newParentId) {
    throw new Error('newParentId must be a node id');
  }
  var parent = await figma.getNodeByIdAsync(params.newParentId);
  if (!parent) throw new Error('Parent not found: ' + params.newParentId);
  if (!('appendChild' in parent)) throw new Error('Node ' + params.newParentId + ' cannot contain children');
  var keepPosition = params.keepPosition !== false;
  var index = typeof params.index === 'number' && isFinite(params.index) ? params.index : null;
  var resolved = await f2aResolve(ids);
  var moved = [], skipped = [];
  for (var i = 0; i < resolved.nodes.length; i++) {
    var node = resolved.nodes[i];
    var ancestor = parent;
    var cycles = false;
    while (ancestor) {
      if (ancestor.id === node.id) { cycles = true; break; }
      ancestor = ancestor.parent;
    }
    if (cycles) {
      skipped.push({ id: node.id, name: node.name, reason: 'cannot move a node into its own subtree' });
      continue;
    }
    var absolute = keepPosition ? f2aAbsolute(node) : null;
    if (index === null) parent.appendChild(node);
    else parent.insertChild(index + i, node);
    f2aRestorePosition(node, absolute, parent);
    moved.push({ id: node.id, name: node.name, parentId: parent.id, index: parent.children.indexOf(node), x: 'x' in node ? node.x : null, y: 'y' in node ? node.y : null });
  }
  for (var m = 0; m < resolved.missing.length; m++) {
    skipped.push({ id: resolved.missing[m], reason: 'not found' });
  }
  return { ok: true, parentId: parent.id, parentName: parent.name, moved: moved, skipped: skipped };
}

async function batchRenameNodes(params) {
  var renames = params && params.renames;
  if (!Array.isArray(renames) || renames.length === 0) {
    throw new Error('renames must be a non-empty array of {nodeId, name}');
  }
  var affected = [], skipped = [];
  for (var i = 0; i < renames.length; i++) {
    var entry = renames[i] || {};
    if (typeof entry.nodeId !== 'string' || !entry.nodeId || typeof entry.name !== 'string') {
      skipped.push({ id: entry.nodeId || null, reason: 'malformed rename entry' });
      continue;
    }
    var node = await figma.getNodeByIdAsync(entry.nodeId);
    if (!node) { skipped.push({ id: entry.nodeId, reason: 'not found' }); continue; }
    var previous = node.name;
    node.name = entry.name;
    affected.push({ id: node.id, previousName: previous, name: node.name });
  }
  return { ok: true, affected: affected, skipped: skipped };
}

async function setVisible(params) {
  var ids = f2aIds(params);
  if (typeof params.visible !== 'boolean') throw new Error('visible must be a boolean');
  var resolved = await f2aResolve(ids);
  var affected = [], skipped = [];
  for (var i = 0; i < resolved.nodes.length; i++) {
    var node = resolved.nodes[i];
    if (!('visible' in node)) { skipped.push({ id: node.id, name: node.name, reason: 'has no visible flag' }); continue; }
    node.visible = params.visible;
    affected.push(node.id);
  }
  for (var m = 0; m < resolved.missing.length; m++) skipped.push({ id: resolved.missing[m], reason: 'not found' });
  return { ok: true, visible: params.visible, affected: affected, skipped: skipped };
}

async function setLocked(params) {
  var ids = f2aIds(params);
  if (typeof params.locked !== 'boolean') throw new Error('locked must be a boolean');
  var resolved = await f2aResolve(ids);
  var affected = [], skipped = [];
  for (var i = 0; i < resolved.nodes.length; i++) {
    var node = resolved.nodes[i];
    if (!('locked' in node)) { skipped.push({ id: node.id, name: node.name, reason: 'has no locked flag' }); continue; }
    node.locked = params.locked;
    affected.push(node.id);
  }
  for (var m = 0; m < resolved.missing.length; m++) skipped.push({ id: resolved.missing[m], reason: 'not found' });
  return { ok: true, locked: params.locked, affected: affected, skipped: skipped };
}

// Wrapping layers in a frame clips them by default; this is the switch that makes the frame behave
// like a group instead. Only containers that expose clipsContent accept it.
async function setClipsContent(params) {
  if (typeof params.nodeId !== 'string' || !params.nodeId) throw new Error('nodeId must be a node id');
  if (typeof params.clipsContent !== 'boolean') throw new Error('clipsContent must be a boolean');
  var node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) throw new Error('Node not found: ' + params.nodeId);
  if (!('clipsContent' in node)) {
    throw new Error(f2aDescribe(node) + ' does not support clip content; only frames, components and instances do');
  }
  node.clipsContent = params.clipsContent;
  return { ok: true, nodeId: node.id, name: node.name, clipsContent: node.clipsContent };
}

// Name / type search inside a subtree. This is how a tidy-up finds its targets: auto-named layers
// ("Frame 1321318046") and every stray text layer are found by pattern, not by walking one
// get_node_info payload at a time.
async function searchNodes(params) {
  var hasName = typeof params.name === 'string' && params.name.length > 0;
  var hasType = typeof params.type === 'string' && params.type.length > 0;
  if (!hasName && !hasType) throw new Error('Pass name, type or both');
  var limit = typeof params.limit === 'number' && params.limit > 0 ? Math.min(Math.floor(params.limit), 1000) : 200;
  var root = null;
  if (typeof params.root === 'string' && params.root) {
    root = await figma.getNodeByIdAsync(params.root);
    if (!root) throw new Error('Root not found: ' + params.root);
  }
  root = root || figma.currentPage;
  var needle = hasName ? params.name.toLowerCase() : null;
  var matches = [], visited = 0, truncated = false;
  var stack = [{ node: root, depth: 0 }];
  while (stack.length) {
    var entry = stack.pop();
    var current = entry.node;
    visited++;
    var isRoot = current.id === root.id;
    if (!isRoot) {
      var nameOk = needle === null || String(current.name || '').toLowerCase().indexOf(needle) !== -1;
      var typeOk = !hasType || current.type === params.type;
      if (nameOk && typeOk) {
        if (matches.length >= limit) { truncated = true; break; }
        matches.push({
          id: current.id,
          name: current.name,
          type: current.type,
          depth: entry.depth,
          parentId: current.parent ? current.parent.id : null,
          parentName: current.parent ? current.parent.name : null,
          visible: 'visible' in current ? current.visible : null,
          locked: 'locked' in current ? current.locked : null
        });
      }
    }
    if (!('children' in current) || !current.children) continue;
    for (var c = current.children.length - 1; c >= 0; c--) {
      stack.push({ node: current.children[c], depth: entry.depth + 1 });
    }
  }
  return { ok: true, rootId: root.id, rootName: root.name, count: matches.length, visited: visited, truncated: truncated, limit: limit, nodes: matches };
}

// Detach instances: the panel already offers this as 分离实例, and the MCP needs it for the same
// reason. An instance's interior cannot be renamed, locked, reparented or ungrouped, so a tidy-up
// that has to touch the inside of a component copy starts here. detachInstance() swaps the instance
// for a frame in place, so every id in the subtree changes - the result returns both ids.
async function detachInstances(params) {
  var ids = f2aIds(params);
  var recursive = params.recursive !== false;
  var resolved = await f2aResolve(ids);
  var detached = [], skipped = [], count = 0;
  function walk(node, depth) {
    if (depth > 64) {
      skipped.push({ id: node.id, name: node.name, reason: 'nesting deeper than 64 levels' });
      return;
    }
    var current = node;
    if (current.type === 'INSTANCE') {
      var oldId = current.id;
      var oldName = current.name;
      try {
        current = current.detachInstance();
      } catch (error) {
        skipped.push({ id: oldId, name: oldName, reason: error && error.message ? error.message : String(error) });
        return;
      }
      count++;
      detached.push({ nodeId: oldId, newId: current.id, name: current.name, type: current.type });
    }
    if (!recursive) return;
    var children = current.children ? current.children.slice() : [];
    for (var i = 0; i < children.length; i++) walk(children[i], depth + 1);
  }
  for (var n = 0; n < resolved.nodes.length; n++) walk(resolved.nodes[n], 0);
  for (var m = 0; m < resolved.missing.length; m++) skipped.push({ id: resolved.missing[m], reason: 'not found' });
  return { ok: true, recursive: recursive, count: count, detached: detached, skipped: skipped };
}

// "$0" in any argument means "the node id op 0 created". Without it a batch cannot build a
// container and then fill it, which is the whole point of running one pass.
function f2aSubstitute(value, created) {
  if (typeof value === 'string') {
    var match = /^\$(\d+)$/.exec(value);
    if (!match) return value;
    var id = created[Number(match[1])];
    if (!id) throw new Error('$' + match[1] + ' refers to an op that did not create a node');
    return id;
  }
  if (Array.isArray(value)) {
    return value.map(function (item) { return f2aSubstitute(item, created); });
  }
  if (value && typeof value === 'object') {
    var out = {};
    Object.keys(value).forEach(function (key) { out[key] = f2aSubstitute(value[key], created); });
    return out;
  }
  return value;
}

function f2aCreatedId(result) {
  if (!result || typeof result !== 'object') return null;
  if (typeof result.nodeId === 'string') return result.nodeId;
  if (typeof result.id === 'string') return result.id;
  if (result.created && typeof result.created.id === 'string') return result.created.id;
  return null;
}

// Sequential edit pass. Ops run in order and an op can use what an earlier op created ("$N").
// There is no rollback: Figma's plugin API has no transaction, so a failure keeps what already
// landed and the result says exactly which ops applied and which one failed.
async function batchCommand(params) {
  var ops = params && params.ops;
  if (!Array.isArray(ops) || ops.length === 0) throw new Error('ops must be a non-empty array of {tool, params}');
  var stopOnError = params.stopOnError !== false;
  var created = [], results = [], applied = 0;
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i] || {};
    var tool = op.tool;
    if (typeof tool !== 'string' || !F2A_BATCH_COMMANDS[tool]) {
      var rejection = { index: i, tool: tool || null, ok: false, error: 'not a batchable write command' };
      results.push(rejection);
      if (stopOnError) return { ok: false, applied: applied, total: ops.length, results: results, failedIndex: i, error: rejection.error, rolledBack: false };
      created.push(null);
      continue;
    }
    try {
      var args = f2aSubstitute(op.params || {}, created);
      var result = await f2aExecute(tool, args);
      created.push(f2aCreatedId(result));
      applied++;
      results.push({ index: i, tool: tool, ok: true, result: result });
    } catch (error) {
      var message = error && error.message ? error.message : String(error);
      results.push({ index: i, tool: tool, ok: false, error: message });
      if (stopOnError) {
        return { ok: false, applied: applied, total: ops.length, results: results, failedIndex: i, error: message, rolledBack: false };
      }
      created.push(null);
    }
  }
  return { ok: true, applied: applied, total: ops.length, results: results, rolledBack: false };
}

// Dispatch: F2A's own commands first, upstream handleCommand otherwise. batchCommand re-enters here
// so an op may itself be one of these layer commands.
async function f2aExecute(command, params) {
  var own = F2A_LAYER_COMMANDS[command];
  if (own) return await own(params || {});
  return await handleCommand(command, params || {});
}
