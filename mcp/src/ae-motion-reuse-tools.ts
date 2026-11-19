import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { registerSurehandTools } from './surehand-tools';
import { z } from 'zod';
import { findMotions, importMotion, loadMotion, makeClip, motionId, motionName, motionSnapshot, motionTags,
  saveMotion, type MotionSnapshot } from './motion-library';

const compId = z.number().int().positive().optional().describe('Composition item ID. Defaults to the active composition.');
const layerIds = z.array(z.number().int().positive()).min(1).refine(ids => new Set(ids).size === ids.length, 'Use each layer ID once.')
  .optional().describe('AE layer IDs. Defaults to selected layers in timeline order.');
const scope = z.enum(['all', 'transform']).default('all');
const projectRef = { comp_id: compId, layer_ids: layerIds };
type Source = { comp_id?: number; layer_ids?: number[]; scope: z.infer<typeof scope>; includeStatic: boolean };

function result(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export function registerAeMotionReuseTools(server: McpServer, call: ReturnType<typeof registerSurehandTools>, jsx: string) {
  let recording: { id: string; snapshot: MotionSnapshot; scope: Source['scope'] } | undefined;

  async function snapshot(source: Source, signal: AbortSignal) {
    // Surehand caps text results. Exchange the full snapshot through a local temporary file.
    const directory = await mkdtemp(path.join(os.tmpdir(), 'f2a-motion-'));
    const snapshotFile = path.join(directory, 'capture.json');
    try {
      const reply = await call('ae_run_script', { code: jsx + '\nreturn captureMotion(args);',
        args: { ...source, snapshotFile }, undoGroup: '', report: false, transpile: false }, signal);
      if (reply.isError) throw new Error(reply.content.find(item => item.type === 'text')?.text || 'Could not capture motion.');
      return motionSnapshot.parse(JSON.parse((await readFile(snapshotFile, 'utf8')).replace(/^\uFEFF/, '')));
    } finally {
      await rm(snapshotFile, {force: true});
      await rmdir(directory);
    }
  }

  server.registerTool('ae_motion_record', {
    description: 'Start a manual motion recording on selected layers. Make edits in After Effects, then call ae_motion_save with the returned recording_id. One recording per F2A session.',
    inputSchema: { ...projectRef, scope }, annotations: {readOnlyHint: true},
  }, async (source, {signal}) => {
    const data = await snapshot({ ...source, includeStatic: true }, signal);
    const id = randomUUID();
    recording = {id, snapshot: data, scope: source.scope};
    return result({ recording_id: id, comp_id: data.comp, composition: data.name,
      layers: data.layers.map(layer => ({ id: layer.id, name: layer.name })) });
  });

  server.registerTool('ae_motion_save', {
    description: 'Save animation on selected AE layers as a reusable motion clip. With recording_id, save the final properties that changed during a manual recording.',
    inputSchema: { name: motionName, tags: motionTags.default([]), ...projectRef, scope, recording_id: motionId.optional() },
    annotations: {readOnlyHint: false, destructiveHint: false},
  }, async ({name, tags, recording_id, ...source}, {signal}) => {
    const active = recording_id ? recording : undefined;
    if (recording_id && active?.id !== recording_id) throw new Error('That recording is not active in this F2A session.');
    const before = active?.snapshot;
    if (before && (source.comp_id !== undefined || source.layer_ids !== undefined))
      throw new Error('The recording already specifies its source composition and layers.');
    const data = await snapshot(active ? { comp_id: active.snapshot.comp, layer_ids: active.snapshot.layers.map(layer => layer.id),
      scope: active.scope, includeStatic: true } : { ...source, includeStatic: false }, signal);
    if (before && (data.project !== before.project || data.comp !== before.comp ||
      (data.revision !== undefined && before.revision !== undefined && data.revision < before.revision)))
      throw new Error('The source project changed. Start a recording in the current project.');
    const {clip, omitted, removed} = makeClip(data, before);
    if (!clip.layers.length) return {isError: true, ...result({error: 'No reusable motion was found.', omitted, removed})};
    const saved = await saveMotion(name, tags, clip);
    if (active && recording === active) recording = undefined;
    return result({ ...saved, omitted, removed });
  });

  server.registerTool('ae_motion_list', {
    description: 'Find saved motion clips by name or tag. The result gives each clip ID, source layer order, duration and its portable JSON file.',
    inputSchema: { query: z.string().trim().default(''), limit: z.number().int().min(1).max(100).default(30) },
    annotations: {readOnlyHint: true},
  }, async ({query, limit}) => result(await findMotions(query, limit)));

  server.registerTool('ae_motion_import', {
    description: 'Import an F2A motion library JSON file and return its new clip ID.',
    inputSchema: {
      file: z.string().refine(p => path.isAbsolute(p) && /\.json$/i.test(p), 'Supply an absolute motion .json path.'),
      name: motionName.optional(),
    },
    annotations: {readOnlyHint: false, destructiveHint: false},
  }, async ({file, name}) => result(await importMotion(file, name)));

  server.registerTool('ae_motion_apply', {
    description: 'Apply a saved motion clip as editable keyframes and expressions in one undo step. Map layers in the listed order. A single-layer clip can be applied to several layers.',
    inputSchema: {
      clip_id: motionId, ...projectRef,
      time: z.number().nonnegative().optional().describe('Place the first keys at this time in seconds. Defaults to the playhead.'),
      time_scale: z.number().positive().default(1).describe('Multiply the animation duration by this factor.'),
      position_anchor: z.enum(['end', 'start', 'absolute']).default('end').describe('Keep the target position at the last key, first key, or copy source coordinates.'),
      replace: z.boolean().default(false).describe('Replace keys and expressions on the matched properties.'),
    },
    annotations: {readOnlyHint: false, destructiveHint: true},
  }, async ({clip_id, replace, ...options}, {signal}) => {
    const record = await loadMotion(clip_id);
    return call('ae_batch', {
      name: 'F2A Motion: ' + record.name, atomic: true, verbose: true,
      steps: [{tool: 'ae_run_script', args: {comp: options.comp_id, code: jsx + '\nreturn applyMotion(args);',
        args: { ...options, replaceTracks: replace, clip: record.clip }}}],
    }, signal);
  });
}
