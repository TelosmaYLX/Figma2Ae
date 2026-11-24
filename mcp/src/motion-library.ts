import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const number = z.number();
const vector = z.array(number).min(1);
const point = z.tuple([number, number]);
const shape = z.object({
  vertices: z.array(point), inTangents: z.array(point).nullable(), outTangents: z.array(point).nullable(), closed: z.boolean(),
  featherSegLocs: vector.optional(), featherRelSegLocs: vector.optional(), featherRadii: vector.optional(),
  featherInterps: vector.optional(), featherTensions: vector.optional(), featherTypes: vector.optional(),
  featherRelCornerAngles: vector.optional(),
});
const value = z.union([number, vector, shape]);
const interpolation = z.enum(['linear', 'bezier', 'hold']);
const ease = z.array(z.object({ speed: number, influence: number })).min(1);
const key = z.object({
  time: number, value, inInterp: interpolation, outInterp: interpolation, inEase: ease.optional(), outEase: ease.optional(),
  temporalContinuous: z.boolean().optional(), temporalAutoBezier: z.boolean().optional(),
  inTangent: vector.optional(), outTangent: vector.optional(), spatialContinuous: z.boolean().optional(),
  spatialAutoBezier: z.boolean().optional(), roving: z.boolean().optional(), label: z.number().int().min(0).max(16).optional(),
});
const track = z.object({
  path: z.array(z.tuple([z.string().min(1), z.number().int().positive()])).min(1),
  type: z.enum(['OneD', 'TwoD', 'ThreeD', 'TwoD_SPATIAL', 'ThreeD_SPATIAL', 'COLOR', 'SHAPE']),
  keys: z.array(key), value: value.optional(), expression: z.object({ code: z.string().min(1), enabled: z.boolean() }).optional(),
  positionReference: z.union([number, vector]).optional(),
}).refine(item => !!item.keys.length || item.value !== undefined, 'A motion track needs keys or a value.');
export const motionSnapshot = z.object({
  project: z.string().nullable(), revision: number.optional(), comp: number, name: z.string(),
  layers: z.array(z.object({ id: number, name: z.string(), tracks: z.array(track), omitted: z.array(z.string()) })),
});
const clip = z.object({
  origin: number, duration: number.nonnegative(),
  layers: z.array(z.object({ name: z.string(), tracks: z.array(track).min(1) })).min(1),
}).refine(data => data.layers.every(layer => layer.tracks.every(item => item.keys.every((sample, i) =>
  sample.time >= 0 && sample.time <= data.duration && (i === 0 || sample.time > item.keys[i - 1].time)))),
  'Motion keys must be ordered and within the clip duration.');
export const motionName = z.string().trim().min(1).max(120);
export const motionTags = z.array(z.string().trim().min(1).max(60)).max(20);
export const motionId = z.uuid();
const artifact = z.object({
  schemaVersion: z.literal(1), id: motionId, name: motionName, tags: motionTags, createdAt: z.iso.datetime(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/), clip,
  category: z.string().optional(), phase: z.string().optional(), defaultAnchor: z.enum(['end', 'start', 'absolute']).optional(),
  description: z.string().optional(), slug: z.string().optional(),
});

export type MotionSnapshot = z.infer<typeof motionSnapshot>;
type Clip = z.infer<typeof clip>;
type Artifact = z.infer<typeof artifact>;

// Adapted from the JUNKDOGE Tool Library. Each artifact is published atomically
// and its normalized motion data has a stable content hash.
function hash(data: Clip) {
  return createHash('sha256').update(JSON.stringify(data), 'utf8').digest('hex');
}

function libraryPath() {
  const local = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'F2A') : path.join(os.homedir(), '.f2a');
  return path.resolve(process.env.F2A_MOTION_LIBRARY || path.join(local, 'motion-library'));
}

function builtinCatalogPath() {
  return path.resolve(__dirname, '../motion-library/builtin.json');
}

function info(record: Artifact, file: string, source: 'user' | 'builtin' = 'user') {
  const { id, name, tags, createdAt, contentHash, clip, category, phase, defaultAnchor, description } = record;
  return {
    id, name, tags, createdAt, contentHash, file, source,
    ...(category ? { category } : {}),
    ...(phase ? { phase } : {}),
    ...(defaultAnchor ? { defaultAnchor } : {}),
    ...(description ? { description } : {}),
    duration: clip.duration,
    layers: clip.layers.map((layer, index) => ({ index: index + 1, name: layer.name, tracks: layer.tracks.length })),
  };
}

async function readBuiltinClips(): Promise<{ file: string; records: Artifact[] }> {
  const file = builtinCatalogPath();
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file, records: [] };
    throw error;
  }
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const items = Array.isArray(parsed?.clips) ? parsed.clips : [];
  const records: Artifact[] = [];
  for (const item of items) {
    try {
      const record = artifact.parse(item);
      if (hash(record.clip) === record.contentHash) records.push(record);
    } catch { /* skip invalid builtin entries */ }
  }
  return { file, records };
}

async function readArtifact(file: string, id?: string) {
  const record = artifact.parse(JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')));
  if (id && record.id !== id) throw new Error('Motion clip ID does not match its filename: ' + file);
  if (hash(record.clip) !== record.contentHash) throw new Error('Motion clip content hash does not match: ' + record.name);
  return record;
}

export async function saveMotion(name: string, tags: string[], data: Clip) {
  const root = libraryPath();
  const clipData = clip.parse(data);
  const record: Artifact = { schemaVersion: 1, id: randomUUID(), name, tags, createdAt: new Date().toISOString(),
    contentHash: hash(clipData), clip: clipData };
  const file = path.join(root, record.id + '.json');
  const temp = path.join(root, '.' + record.id + '.tmp');
  await mkdir(root, {recursive: true});
  try {
    await writeFile(temp, JSON.stringify(record, null, 2), {encoding: 'utf8', mode: 0o600, flag: 'wx'});
    await rename(temp, file);
  } finally {
    await rm(temp, {force: true});
  }
  return info(record, file);
}

export async function findMotions(query: string, limit: number, includeBuiltin = true) {
  const root = libraryPath();
  let files: string[] = [];
  try { files = await readdir(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const userClips: ReturnType<typeof info>[] = [], unreadable: string[] = [];
  const search = query.normalize('NFKC').toLowerCase();
  for (const name of files) {
    const id = name.slice(0, -5);
    if (!name.endsWith('.json') || !motionId.safeParse(id).success) continue;
    const file = path.join(root, name);
    try {
      const record = await readArtifact(file, id);
      const fields = [record.name, ...record.tags, record.category || '', record.description || ''].join(' ').normalize('NFKC').toLowerCase();
      if (fields.includes(search)) userClips.push(info(record, file, 'user'));
    } catch { unreadable.push(name); }
  }
  userClips.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const builtinClips: ReturnType<typeof info>[] = [];
  if (includeBuiltin) {
    const builtin = await readBuiltinClips();
    for (const record of builtin.records) {
      const fields = [record.name, ...record.tags, record.category || '', record.description || '', record.slug || '']
        .join(' ').normalize('NFKC').toLowerCase();
      if (fields.includes(search)) builtinClips.push(info(record, builtin.file, 'builtin'));
    }
  }
  return { clips: [...userClips, ...builtinClips].slice(0, limit), unreadable };
}

export async function loadMotion(id: string) {
  const file = path.join(libraryPath(), id + '.json');
  try {
    return await readArtifact(file, id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const builtin = await readBuiltinClips();
    const match = builtin.records.find(item => item.id === id);
    if (match) return match;
    throw error;
  }
}

export async function importMotion(file: string, name?: string) {
  const record = await readArtifact(file);
  return saveMotion(name || record.name, record.tags, record.clip);
}

export function makeClip(snapshot: MotionSnapshot, before?: MotionSnapshot) {
  const layers: Clip['layers'] = [], removed: string[] = [], omitted: string[] = [];
  let origin = Infinity, end = -Infinity;
  for (const layer of snapshot.layers) {
    const base = before?.layers.find(other => other.id === layer.id);
    const old = new Map(base?.tracks.map(item => [JSON.stringify(item.path), item]));
    const tracks: Clip['layers'][number]['tracks'] = [];
    for (const item of layer.tracks) {
      const key = JSON.stringify(item.path), previous = old.get(key);
      old.delete(key);
      if (base && JSON.stringify(previous) === JSON.stringify(item)) continue;
      const reference = previous?.value;
      const moved = !item.keys.length && item.path.length === 2 && item.path[0][0] === 'ADBE Transform Group' &&
        /^ADBE Position(_[012])?$/.test(item.path[1][0]) && (typeof reference === 'number' || Array.isArray(reference));
      tracks.push(moved ? { ...item, positionReference: reference } : item);
    }
    omitted.push(...layer.omitted.map(prop => layer.name + ' / ' + prop));
    removed.push(...Array.from(old.values(), item => layer.name + ' / ' + item.path.map(([match]) => match).join(' / ')));
    for (const item of tracks) {
      if (!item.keys.length) continue;
      origin = Math.min(origin, item.keys[0].time);
      end = Math.max(end, item.keys[item.keys.length - 1].time);
    }
    if (tracks.length) layers.push({ name: layer.name, tracks });
  }
  if (!Number.isFinite(origin)) origin = end = 0;
  const relative = layers.map(layer => ({ ...layer, tracks: layer.tracks.map(item => ({
    ...item, keys: item.keys.map(key => ({ ...key, time: key.time - origin })),
  })) }));
  return { clip: { layers: relative, origin, duration: end - origin }, omitted, removed };
}
