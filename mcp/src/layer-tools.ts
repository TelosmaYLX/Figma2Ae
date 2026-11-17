// F2A layer-organisation tools.
//
// Registered by the generated server entry (scripts/build-mcp.cjs) beside the upstream tools, which
// stay untouched in vendor/. The commands themselves live in the embedded plugin block
// (src/layer-commands.js); this file is the MCP face an agent sees.
//
// Scope: the things a tidy-up needs and the upstream set cannot do — group / ungroup, z-order,
// bulk reparent, bulk rename, visibility, lock, clip-content, name/type search, and one sequential
// edit pass. Every result is JSON so an agent can branch on it instead of parsing prose.

import {z} from 'zod';

type LooseServer = {tool: (...args: any[]) => any};
type SendCommand = (command: string, params?: Record<string, unknown>) => Promise<unknown>;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function layerJson(value: unknown) {
  return {content: [{type: 'text', text: JSON.stringify(value)}]};
}

function failed(tool: string, error: unknown) {
  return {isError: true, content: [{type: 'text', text: `${tool}: ${describeError(error)}`}]};
}

const nodeIds = (what: string) =>
  z.array(z.string()).min(1).describe(what);

export function registerLayerTools(server: LooseServer, send: SendCommand): void {
  server.tool(
    'group_nodes',
    'Group nodes that share one parent into a new GROUP and return its id. A group is the layer wrapper that does not clip: unlike a frame it has no clip content, so shadows and overflowing children stay visible. Every id must already be a sibling — move layers in first with reparent_nodes. Groups cannot be created inside an auto-layout frame; wrap those layers in a frame instead. Returns JSON {ok, nodeId, name, type, parentId, index, grouped, skipped}.',
    {
      nodeIds: nodeIds('Node ids to group; all must share the same parent'),
      name: z.string().optional().describe('Name for the new group; Figma auto-names it "Group N" otherwise')
    },
    async ({nodeIds, name}: any) => {
      try {
        return layerJson(await send('group_nodes', {nodeIds, name}));
      } catch (error) {
        return failed('group_nodes', error);
      }
    }
  );

  server.tool(
    'ungroup_nodes',
    'Ungroup GROUP nodes (and Figma Draw repeat groups) by id, promoting their children into the old parent and returning the children ids. This destroys the group node itself and cannot be undone except with Figma undo, so it is the one destructive layer command. Nodes that are not groups are skipped and reported. Returns JSON {ok, affected, skipped}.',
    {nodeIds: nodeIds('Group ids to ungroup')},
    async ({nodeIds}: any) => {
      try {
        return layerJson(await send('ungroup_nodes', {nodeIds}));
      } catch (error) {
        return failed('ungroup_nodes', error);
      }
    }
  );

  server.tool(
    'reorder_nodes',
    'Change z-order inside the current parent. index is a child index (0 = bottom of the stack) and each id lands one step further up, so the given order is kept; an index at or past the last child appends, which is how a layer is brought to the top without counting children. Returns JSON {ok, moved:[{id, name, index}], skipped}.',
    {
      nodeIds: nodeIds('Node ids to reorder, in the order they should stack'),
      index: z.number().int().min(0).describe('Target child index (0 = bottom of the stack)')
    },
    async ({nodeIds, index}: any) => {
      try {
        return layerJson(await send('reorder_nodes', {nodeIds, index}));
      } catch (error) {
        return failed('reorder_nodes', error);
      }
    }
  );

  server.tool(
    'reparent_nodes',
    'Move many nodes into another frame, group, section or page in one call, optionally inserting at index. On-canvas positions are preserved by default (pass keepPosition:false for plain Figma behaviour, where coordinates become relative to the new parent). Moving a node into its own subtree is refused and reported per node. Returns JSON {ok, parentId, parentName, moved, skipped}.',
    {
      nodeIds: nodeIds('Node ids to move'),
      newParentId: z.string().describe('Id of the frame, group, section or page to move them into'),
      index: z.number().int().min(0).optional().describe('Optional child index in the new parent; appended last when omitted'),
      keepPosition: z.boolean().optional().describe('Keep the on-canvas position (default true)')
    },
    async ({nodeIds, newParentId, index, keepPosition}: any) => {
      try {
        return layerJson(await send('reparent_nodes', {nodeIds, newParentId, index, keepPosition}));
      } catch (error) {
        return failed('reparent_nodes', error);
      }
    }
  );

  server.tool(
    'batch_rename_nodes',
    'Rename many nodes in one call from a [{nodeId, name}] list. This is the tool for cleaning auto-generated names ("Frame 1321318046") across a page; missing or malformed entries are skipped and reported. Returns JSON {ok, affected:[{id, previousName, name}], skipped}.',
    {
      renames: z
        .array(z.object({nodeId: z.string(), name: z.string()}))
        .min(1)
        .describe('Per-node renames')
    },
    async ({renames}: any) => {
      try {
        return layerJson(await send('batch_rename_nodes', {renames}));
      } catch (error) {
        return failed('batch_rename_nodes', error);
      }
    }
  );

  server.tool(
    'set_visible',
    'Show or hide nodes by toggling their visible flag. A hidden layer stays in the tree and in the file, is excluded from rendering and export, and takes its descendants with it; the change is reversible. Use it to park work-in-progress rather than deleting it. Returns JSON {ok, visible, affected, skipped}.',
    {
      nodeIds: nodeIds('Node ids to show or hide'),
      visible: z.boolean().describe('true to show, false to hide')
    },
    async ({nodeIds, visible}: any) => {
      try {
        return layerJson(await send('set_visible', {nodeIds, visible}));
      } catch (error) {
        return failed('set_visible', error);
      }
    }
  );

  server.tool(
    'set_locked',
    'Lock or unlock nodes. A locked layer still renders and exports; it only stops canvas selection and editing, and locking a parent locks its descendants. Locking the finished background or artwork keeps a tidy-up from moving the wrong layer. Returns JSON {ok, locked, affected, skipped}.',
    {
      nodeIds: nodeIds('Node ids to lock or unlock'),
      locked: z.boolean().describe('true to lock, false to unlock')
    },
    async ({nodeIds, locked}: any) => {
      try {
        return layerJson(await send('set_locked', {nodeIds, locked}));
      } catch (error) {
        return failed('set_locked', error);
      }
    }
  );

  server.tool(
    'set_clips_content',
    'Turn clip content on or off for a frame, component or instance. This is what decides whether a container trims overflowing children — a new frame clips by default, so a frame used as a grouping wrapper hides shadows and out-of-bounds layers until this is set false. Returns JSON {ok, nodeId, name, clipsContent}.',
    {
      nodeId: z.string().describe('Frame, component or instance id'),
      clipsContent: z.boolean().describe('true to clip children to the bounds, false to let them overflow')
    },
    async ({nodeId, clipsContent}: any) => {
      try {
        return layerJson(await send('set_clips_content', {nodeId, clipsContent}));
      } catch (error) {
        return failed('set_clips_content', error);
      }
    }
  );

  server.tool(
    'search_nodes',
    'Find nodes by name substring (case-insensitive), by type, or both, inside the current page or a subtree. Depth-first and bounded by limit, so it is the cheap way to collect the ids a tidy-up needs (every auto-named frame, every TEXT layer, one component tree) without pulling a whole subtree through get_node_info. Returns JSON {ok, count, visited, truncated, limit, nodes:[{id, name, type, depth, parentId, parentName, visible, locked}]}.',
    {
      name: z.string().optional().describe('Case-insensitive name substring'),
      type: z.string().optional().describe('Node type, e.g. FRAME, GROUP, TEXT, INSTANCE'),
      root: z.string().optional().describe('Node id to search inside; the current page when omitted'),
      limit: z.number().int().min(1).max(1000).optional().describe('Maximum matches to return (default 200)')
    },
    async ({name, type, root: searchRoot, limit}: any) => {
      try {
        return layerJson(await send('search_nodes', {name, type, root: searchRoot, limit}));
      } catch (error) {
        return failed('search_nodes', error);
      }
    }
  );

  server.tool(
    'detach_instances',
    'Detach component instances into editable frames, in place. This is the step before any layer tidy-up that has to touch the inside of a component copy: an instance keeps its interior read-only (no renames, locks, reparenting or ungrouping inside), and detaching turns it into a normal frame that keeps the current overrides. The instance id is replaced by a new frame id and every child id changes, so use the returned ids rather than the ones passed in. An instance that lives inside another instance cannot be detached on its own; detach the outer one first (recursive, the default, does that for the whole subtree). Returns JSON {ok, recursive, count, detached:[{nodeId, newId, name, type}], skipped}.',
    {
      nodeIds: nodeIds('Instance ids to detach'),
      recursive: z.boolean().optional().describe('Also detach instances nested inside the given nodes (default true)')
    },
    async ({nodeIds, recursive}: any) => {
      try {
        return layerJson(await send('detach_instances', {nodeIds, recursive}));
      } catch (error) {
        return failed('detach_instances', error);
      }
    }
  );

  server.tool(
    'batch',
    'Run several write commands in one call, in order. Each op is {tool, params} where tool is any write command (create_frame, move_node, rename_node, reparent_nodes, set_visible, set_layout_mode, ...). An id argument of "$N" means "the node id op N created (0-based)", so one call can create a frame, fill it, and name it. There is NO rollback: Figma has no transaction for plugins, so ops already applied stay applied and the result lists every op with its own result, plus failedIndex and rolledBack:false on failure. Ops are not validated upfront — a bad op fails when it runs. Returns JSON {ok, applied, total, results, failedIndex?, error?}.',
    {
      ops: z
        .array(z.object({tool: z.string(), params: z.record(z.string(), z.unknown()).optional()}))
        .min(1)
        .describe('Ordered write ops'),
      stopOnError: z.boolean().optional().describe('Stop at the first failure (default true)')
    },
    async ({ops, stopOnError}: any) => {
      try {
        return layerJson(await send('batch', {ops, stopOnError}));
      } catch (error) {
        return failed('batch', error);
      }
    }
  );
}
