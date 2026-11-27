/* ===== f2a — local template pack scanner & user motion library storage =====
 * Pure Node.js (zero external deps). Runs inside AE CEP panel (--enable-nodejs) and Node tests.
 *
 * Capabilities:
 *   1. Scan local animation template folders (Titles Factory .aep/.png/.mp4/.ffx,
 *      .mogrt ZIP packages with thumb.png/thumb.mp4/project.aegraphic, standalone .aep & .ffx).
 *   2. Lazily extract .mogrt thumbnails/videos and inner .aep projects into %LOCALAPPDATA%\F2A\pack-cache.
 *   3. Read/save/import/delete user motion clips in %LOCALAPPDATA%\F2A\motion-library using the
 *      exact same schemaVersion: 1 format and SHA-256 contentHash as mcp/src/motion-library.ts.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { createHash, randomUUID } = require('node:crypto');

// ---- Portable storage paths (zero hardcoded user paths) ----
function appDataRoot() {
  return process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'F2A') : path.join(os.homedir(), '.f2a');
}

function getUserLibraryDir() {
  return path.resolve(process.env.F2A_MOTION_LIBRARY || path.join(appDataRoot(), 'motion-library'));
}

function getPackCacheDir() {
  return path.resolve(process.env.F2A_PACK_CACHE || path.join(appDataRoot(), 'pack-cache'));
}

// ---- Minimal ZIP reader (Central Directory based, supports STORED & DEFLATE) ----
function readZipEntries(buffer) {
  const entries = new Map();
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return entries;
  // Locate End of Central Directory (0x06054b50) scanning backwards
  let eocd = -1;
  const minPos = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= minPos; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return entries;

  const cdCount = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  let pos = cdOffset;
  for (let i = 0; i < cdCount && pos + 46 <= buffer.length; i++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(pos + 10);
    const compSize = buffer.readUInt32LE(pos + 20);
    const uncompSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLen);
    entries.set(name, { name, method, compSize, uncompSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractZipEntry(buffer, entry) {
  if (!entry) return null;
  const off = entry.localOffset;
  if (off + 30 > buffer.length || buffer.readUInt32LE(off) !== 0x04034b50) return null;
  const nameLen = buffer.readUInt16LE(off + 26);
  const extraLen = buffer.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const slice = buffer.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return Buffer.from(slice);
  if (entry.method === 8) return zlib.inflateRawSync(slice);
  throw new Error('Unsupported ZIP compression method: ' + entry.method);
}

// ---- Template Pack & Local Media Scanner ----
const VIDEO_PLAYABLE_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);
const VIDEO_EXTS = new Set([
  '.mp4', '.webm', '.mov', '.m4v', '.ogv', '.mkv', '.avi', '.mxf',
  '.mpg', '.mpeg', '.mts', '.m2ts', '.ts', '.wmv', '.flv', '.3gp', '.f4v', '.asf', '.dv', '.vob',
]);
const IMAGE_RENDERABLE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.ico', '.avif', '.jfif']);
const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.ico', '.avif', '.jfif',
  '.tif', '.tiff', '.tga', '.exr', '.hdr', '.dpx', '.cin', '.sgi', '.rla', '.raw', '.dng',
]);
const DESIGN_EXTS = new Set(['.psd', '.psb', '.ai', '.eps', '.pdf']);
const AUDIO_PLAYABLE_EXTS = new Set(['.mp3', '.wav', '.m4a', '.ogg', '.oga', '.flac', '.aac']);
const AUDIO_EXTS = new Set([
  '.mp3', '.wav', '.m4a', '.ogg', '.oga', '.flac', '.aac',
  '.aif', '.aiff', '.wma', '.ac3', '.mp2', '.mpa',
]);
const TRANSPARENT_IMAGE_EXTS = new Set(['.png', '.webp', '.gif', '.svg', '.avif', '.ico']);

function findSiblingPreviewVideo(dir) {
  try {
    const names = fs.readdirSync(dir);
    for (const name of names) {
      if (/\.(mp4|mov|webm)$/i.test(name)) return path.join(dir, name);
    }
  } catch (e) {}
  return null;
}

// Packs often ship one generic cover image (预览.png / preview.jpg) instead of <aep>.png.
const PREVIEW_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
const GENERIC_PREVIEW_NAMES = ['预览', 'preview', 'cover', 'thumbnail', 'poster'];
function findBasePreviewImage(dir, base) {
  for (const ext of PREVIEW_IMAGE_EXTS) {
    const file = path.join(dir, base + ext);
    if (fs.existsSync(file)) return file;
  }
  return null;
}
function findGenericPreviewImage(dir) {
  for (const stem of GENERIC_PREVIEW_NAMES) {
    for (const ext of PREVIEW_IMAGE_EXTS) {
      const file = path.join(dir, stem + ext);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}
function findBasePreviewVideo(dir, base) {
  for (const ext of ['.mp4', '.webm', '.mov']) {
    const file = path.join(dir, base + ext);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function scanTitlesFactoryPack(projectDir, packLabel, relBase) {
  const pkgDir = path.join(projectDir, 'Package');
  const imgDir = path.join(projectDir, 'Images');
  const vidDir = path.join(projectDir, 'Videos');
  const ffxDir = path.join(projectDir, 'ffx');
  const items = [];
  const basePrefix = relBase ? String(relBase).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : '';
  function joinRel(seg) { return basePrefix ? (basePrefix + '/' + seg) : seg; }

  if (fs.existsSync(pkgDir)) {
    const cats = fs.readdirSync(pkgDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !/auto-save/i.test(d.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const cat of cats) {
      const catPkg = path.join(pkgDir, cat.name);
      const catImg = path.join(imgDir, cat.name);
      const catVid = path.join(vidDir, cat.name);
      const vidFiles = fs.existsSync(catVid) ? fs.readdirSync(catVid) : [];
      const aeps = fs.readdirSync(catPkg)
        .filter(f => /\.aep$/i.test(f) && !/auto-save/i.test(f))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const catFallbackThumb = aeps.length === 1 ? findGenericPreviewImage(catImg) : null;

      for (const aepFile of aeps) {
        const base = aepFile.replace(/\.aep$/i, '');
        const aepPath = path.join(catPkg, aepFile);
        const pngPath = path.join(catImg, base + '.png');
        const hasPng = fs.existsSync(pngPath);

        // Match A1/A2/A3 in/out video previews
        const variants = [];
        for (const vTag of ['A1', 'A2', 'A3']) {
          const prefix = (base + '-' + vTag).toLowerCase();
          const inVid = vidFiles.find(f => f.toLowerCase() === prefix + '-in.mp4') ||
                        vidFiles.find(f => f.toLowerCase() === prefix + '.mp4');
          const outVid = vidFiles.find(f => f.toLowerCase() === prefix + '-out.mp4');
          if (inVid || outVid) {
            variants.push({
              label: vTag,
              compName: base + '-' + vTag,
              inVideo: inVid ? path.join(catVid, inVid) : null,
              outVideo: outVid ? path.join(catVid, outVid) : null,
            });
          }
        }
        items.push({
          id: 'tpl-' + createHash('sha1').update(aepPath).digest('hex').slice(0, 12),
          kind: 'aep',
          ext: 'AEP',
          pack: packLabel,
          category: cat.name,
          relDir: joinRel(cat.name),
          name: base,
          file: aepPath,
          thumb: hasPng ? pngPath : catFallbackThumb,
          video: variants[0] ? (variants[0].inVideo || variants[0].outVideo) : null,
          variants: variants,
          defaultComp: variants[0] ? variants[0].compName : base,
        });
      }
    }
  }

  if (fs.existsSync(ffxDir)) {
    const ffxFiles = fs.readdirSync(ffxDir).filter(f => /\.ffx$/i.test(f)).sort();
    for (const f of ffxFiles) {
      const ffxPath = path.join(ffxDir, f);
      items.push({
        id: 'ffx-' + createHash('sha1').update(ffxPath).digest('hex').slice(0, 12),
        kind: 'ffx',
        ext: 'FFX',
        pack: packLabel,
        category: 'FFX 特效',
        relDir: joinRel('ffx'),
        name: f.replace(/\.ffx$/i, ''),
        file: ffxPath,
        thumb: null,
        video: null,
        variants: [],
      });
    }
  }
  return items;
}

function scanTemplateDirectory(rootDir) {
  const resolved = path.resolve(rootDir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return [];
  const items = [];
  const consumedDirs = new Set();

  function walk(dir, depth, topPack) {
    if (depth > 6) return;
    if (consumedDirs.has(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return; }

    const packName = topPack || path.basename(dir);
    const relDir = dir === resolved ? '' : path.relative(resolved, dir).replace(/\\/g, '/');

    // 1) Detect Titles Factory pack structure (contains Package/ + Images/ or Videos/)
    const hasPackage = entries.some(e => e.isDirectory() && e.name === 'Package');
    const hasImages = entries.some(e => e.isDirectory() && e.name === 'Images');
    const hasVideos = entries.some(e => e.isDirectory() && e.name === 'Videos');
    if (hasPackage && (hasImages || hasVideos)) {
      const isProjectWrapper = path.basename(dir) === 'project';
      const label = isProjectWrapper ? path.basename(path.dirname(dir)) : path.basename(dir);
      const packRelBase = isProjectWrapper
        ? path.relative(resolved, path.dirname(dir)).replace(/\\/g, '/')
        : relDir;
      items.push(...scanTitlesFactoryPack(dir, label, packRelBase === '.' ? '' : packRelBase));
      consumedDirs.add(dir);
      return;
    }

    // 2) Scan files in current folder
    const aeps = entries.filter(e => e.isFile() && /\.(aep|aet|aepx)$/i.test(e.name)).map(e => e.name).sort();
    const mogrts = entries.filter(e => e.isFile() && /\.mogrt$/i.test(e.name)).map(e => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const ffxs = entries.filter(e => e.isFile() && /\.ffx$/i.test(e.name)).map(e => e.name).sort();
    const hasTemplates = aeps.length > 0 || mogrts.length > 0 || ffxs.length > 0;
    const siblingVideo = aeps.length > 0 ? findSiblingPreviewVideo(dir) : null;
    const catName = path.basename(dir);
    // Media files already bound as previews for AEP/MOGRT/FFX in this folder are not duplicated
    // as standalone assets, keeping template packs clean while normal media folders show everything.
    const usedPreviews = new Set();

    // Filter out legacy duplicate copies (e.g. "Foo copy 17.x.aep" / "Foo CS6.aep") when a main .aep exists
    const filteredAeps = aeps.length > 1
      ? aeps.filter(n => !/\b(cs6|copy\s+\d+\.x)\b/i.test(n))
      : aeps;
    const finalAeps = filteredAeps.length ? filteredAeps : aeps;
    const dirFallbackThumb = finalAeps.length === 1 ? findGenericPreviewImage(dir) : null;

    for (const aepName of finalAeps) {
      const aepPath = path.join(dir, aepName);
      const ext = path.extname(aepName).slice(1).toUpperCase();
      const base = aepName.replace(/\.(aep|aet|aepx)$/i, '');
      const thumbPath = findBasePreviewImage(dir, base) || dirFallbackThumb;
      const vidPath = findBasePreviewVideo(dir, base) || siblingVideo;
      if (thumbPath) usedPreviews.add(thumbPath.toLowerCase());
      if (vidPath) usedPreviews.add(vidPath.toLowerCase());
      items.push({
        id: 'aep-' + createHash('sha1').update(aepPath).digest('hex').slice(0, 12),
        kind: 'aep',
        ext: ext,
        pack: packName,
        category: 'AEP 模板',
        relDir: relDir,
        name: base,
        file: aepPath,
        thumb: thumbPath,
        video: vidPath,
        variants: [],
      });
    }

    for (const mName of mogrts) {
      const mPath = path.join(dir, mName);
      const base = mName.replace(/\.mogrt$/i, '');
      const thumbPath = findBasePreviewImage(dir, base);
      const vidPath = findBasePreviewVideo(dir, base);
      if (thumbPath) usedPreviews.add(thumbPath.toLowerCase());
      if (vidPath) usedPreviews.add(vidPath.toLowerCase());
      items.push({
        id: 'mogrt-' + createHash('sha1').update(mPath).digest('hex').slice(0, 12),
        kind: 'mogrt',
        ext: 'MOGRT',
        pack: packName,
        category: catName === packName ? 'MOGRT' : catName,
        relDir: relDir,
        name: base,
        file: mPath,
        thumb: thumbPath,
        video: vidPath,
        variants: [],
      });
    }

    for (const fName of ffxs) {
      const fPath = path.join(dir, fName);
      const base = fName.replace(/\.ffx$/i, '');
      const thumbPath = findBasePreviewImage(dir, base);
      const vidPath = findBasePreviewVideo(dir, base);
      if (thumbPath) usedPreviews.add(thumbPath.toLowerCase());
      if (vidPath) usedPreviews.add(vidPath.toLowerCase());
      items.push({
        id: 'ffx-' + createHash('sha1').update(fPath).digest('hex').slice(0, 12),
        kind: 'ffx',
        ext: 'FFX',
        pack: packName,
        category: 'FFX 特效',
        relDir: relDir,
        name: base,
        file: fPath,
        thumb: thumbPath,
        video: vidPath,
        variants: [],
      });
    }

    // 2b) Scan standalone local media assets (video, image, design, audio)
    const mediaFiles = entries
      .filter(e => e.isFile() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    for (const fileName of mediaFiles) {
      const extLower = path.extname(fileName).toLowerCase();
      if (!extLower) continue;
      const fullPath = path.join(dir, fileName);
      if (hasTemplates && usedPreviews.has(fullPath.toLowerCase())) continue;

      const extUpper = extLower.slice(1).toUpperCase();
      const base = fileName.slice(0, -extLower.length);
      if (VIDEO_EXTS.has(extLower)) {
        const playable = VIDEO_PLAYABLE_EXTS.has(extLower);
        items.push({
          id: 'vid-' + createHash('sha1').update(fullPath).digest('hex').slice(0, 12),
          kind: 'video',
          ext: extUpper,
          playable: playable,
          pack: packName,
          category: '视频',
          relDir: relDir,
          name: base,
          file: fullPath,
          thumb: null,
          video: playable ? fullPath : null,
          variants: [],
        });
      } else if (IMAGE_EXTS.has(extLower)) {
        const renderable = IMAGE_RENDERABLE_EXTS.has(extLower);
        items.push({
          id: 'img-' + createHash('sha1').update(fullPath).digest('hex').slice(0, 12),
          kind: 'image',
          ext: extUpper,
          playable: renderable,
          transparent: TRANSPARENT_IMAGE_EXTS.has(extLower),
          pack: packName,
          category: '图片',
          relDir: relDir,
          name: base,
          file: fullPath,
          thumb: renderable ? fullPath : null,
          video: null,
          variants: [],
        });
      } else if (DESIGN_EXTS.has(extLower)) {
        items.push({
          id: 'dsn-' + createHash('sha1').update(fullPath).digest('hex').slice(0, 12),
          kind: 'design',
          ext: extUpper,
          playable: false,
          pack: packName,
          category: '设计稿',
          relDir: relDir,
          name: base,
          file: fullPath,
          thumb: null,
          video: null,
          variants: [],
        });
      } else if (AUDIO_EXTS.has(extLower)) {
        const playable = AUDIO_PLAYABLE_EXTS.has(extLower);
        items.push({
          id: 'aud-' + createHash('sha1').update(fullPath).digest('hex').slice(0, 12),
          kind: 'audio',
          ext: extUpper,
          playable: playable,
          pack: packName,
          category: '音频',
          relDir: relDir,
          name: base,
          file: fullPath,
          thumb: null,
          video: null,
          audio: playable ? fullPath : null,
          variants: [],
        });
      }
    }

    // 3) Recurse into subdirectories
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (/^(\.|__MACOSX|node_modules|Adobe After Effects Auto-Save)/i.test(entry.name)) continue;
      const nextTop = depth === 0 ? entry.name : topPack;
      walk(path.join(dir, entry.name), depth + 1, nextTop);
    }
  }

  walk(resolved, 0, '');
  return items;
}

// Group a flat scanned list into immediate child subfolders + direct files at `subDir`.
function listFolderLevel(items, subDir) {
  const cur = String(subDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const prefix = cur ? (cur + '/') : '';
  const folderMap = new Map();
  const files = [];
  for (const item of items || []) {
    const rel = String(item.relDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (rel === cur) {
      files.push(item);
      continue;
    }
    if (cur && !rel.startsWith(prefix)) continue;
    const rest = cur ? rel.slice(prefix.length) : rel;
    if (!rest) continue;
    const seg = rest.split('/')[0];
    const childRel = cur ? (cur + '/' + seg) : seg;
    let entry = folderMap.get(childRel);
    if (!entry) {
      entry = { name: seg, relDir: childRel, count: 0 };
      folderMap.set(childRel, entry);
    }
    entry.count++;
  }
  const folders = Array.from(folderMap.values())
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { folders, files };
}

// Lazily extract thumb.png / thumb.mp4 from a .mogrt ZIP into pack-cache
function ensureMogrtPreview(mogrtPath, cacheRoot) {
  const key = createHash('sha1').update(path.resolve(mogrtPath)).digest('hex').slice(0, 16);
  const dir = path.join(cacheRoot || getPackCacheDir(), 'mogrt-' + key);
  const pngOut = path.join(dir, 'thumb.png');
  const mp4Out = path.join(dir, 'thumb.mp4');
  const marker = path.join(dir, '.probed');

  if (fs.existsSync(marker)) {
    return {
      thumb: fs.existsSync(pngOut) ? pngOut : null,
      video: fs.existsSync(mp4Out) ? mp4Out : null,
    };
  }
  const buf = fs.readFileSync(mogrtPath);
  const entries = readZipEntries(buf);
  fs.mkdirSync(dir, { recursive: true });
  let thumb = null, video = null;
  if (entries.has('thumb.png')) {
    const data = extractZipEntry(buf, entries.get('thumb.png'));
    if (data && data.length) { fs.writeFileSync(pngOut, data); thumb = pngOut; }
  }
  if (entries.has('thumb.mp4')) {
    const data = extractZipEntry(buf, entries.get('thumb.mp4'));
    if (data && data.length) { fs.writeFileSync(mp4Out, data); video = mp4Out; }
  }
  fs.writeFileSync(marker, '1');
  return { thumb, video };
}

// Extract inner .aep from a .mogrt (mogrt ZIP -> project.aegraphic ZIP -> *.aep)
function extractMogrtAep(mogrtPath, cacheRoot) {
  const key = createHash('sha1').update(path.resolve(mogrtPath)).digest('hex').slice(0, 16);
  const dir = path.join(cacheRoot || getPackCacheDir(), 'mogrt-' + key);
  fs.mkdirSync(dir, { recursive: true });

  // Return cached .aep if already extracted
  const existing = fs.readdirSync(dir).find(f => /\.aep$/i.test(f));
  if (existing) return path.join(dir, existing);

  const outerBuf = fs.readFileSync(mogrtPath);
  const outerEntries = readZipEntries(outerBuf);
  const aeGraphicEntry = outerEntries.get('project.aegraphic');
  if (!aeGraphicEntry) throw new Error('该 MOGRT 文件不包含 After Effects 工程（project.aegraphic）。');
  const innerBuf = extractZipEntry(outerBuf, aeGraphicEntry);
  const innerEntries = readZipEntries(innerBuf);
  let aepEntry = null;
  for (const [name, ent] of innerEntries) {
    if (/\.aep$/i.test(name)) { aepEntry = ent; break; }
  }
  if (!aepEntry) throw new Error('MOGRT 内部未找到 .aep 文件。');
  const safeName = path.basename(mogrtPath, '.mogrt').replace(/[<>:"/\\|?*]+/g, '_') + '.aep';
  const outPath = path.join(dir, safeName);
  fs.writeFileSync(outPath, extractZipEntry(innerBuf, aepEntry));
  return outPath;
}

// ---- User Motion Library (100% compatible with mcp/src/motion-library.ts) ----
// Canonicalize clip key order to match mcp/src/motion-library.ts Zod schema exactly
// so contentHash (sha256(JSON.stringify(clip))) matches byte-for-byte between panel and MCP.
function canonicalizeEase(arr) {
  return arr.map(e => ({ speed: e.speed, influence: e.influence }));
}
function canonicalizeKey(k) {
  const out = {
    time: k.time,
    value: k.value,
    inInterp: k.inInterp,
    outInterp: k.outInterp,
  };
  if (k.inEase !== undefined) out.inEase = canonicalizeEase(k.inEase);
  if (k.outEase !== undefined) out.outEase = canonicalizeEase(k.outEase);
  if (k.temporalContinuous !== undefined) out.temporalContinuous = k.temporalContinuous;
  if (k.temporalAutoBezier !== undefined) out.temporalAutoBezier = k.temporalAutoBezier;
  if (k.inTangent !== undefined) out.inTangent = k.inTangent;
  if (k.outTangent !== undefined) out.outTangent = k.outTangent;
  if (k.spatialContinuous !== undefined) out.spatialContinuous = k.spatialContinuous;
  if (k.spatialAutoBezier !== undefined) out.spatialAutoBezier = k.spatialAutoBezier;
  if (k.roving !== undefined) out.roving = k.roving;
  if (k.label !== undefined) out.label = k.label;
  return out;
}
function canonicalizeTrack(tr) {
  const out = {
    path: tr.path,
    type: tr.type,
    keys: (tr.keys || []).map(canonicalizeKey),
  };
  if (tr.value !== undefined) out.value = tr.value;
  if (tr.expression !== undefined) out.expression = { code: tr.expression.code, enabled: !!tr.expression.enabled };
  if (tr.positionReference !== undefined) out.positionReference = tr.positionReference;
  return out;
}
function canonicalizeClip(clipData) {
  return {
    origin: clipData.origin,
    duration: clipData.duration,
    layers: (clipData.layers || []).map(l => ({
      name: l.name,
      tracks: (l.tracks || []).map(canonicalizeTrack),
    })),
  };
}

function hashClip(clipData) {
  return createHash('sha256').update(JSON.stringify(canonicalizeClip(clipData)), 'utf8').digest('hex');
}

function makeClipFromSnapshots(snapshot, before) {
  const layers = [], removed = [], omitted = [];
  let origin = Infinity, end = -Infinity;
  for (const layer of snapshot.layers || []) {
    const base = before && before.layers ? before.layers.find(other => other.id === layer.id) : null;
    const old = new Map((base ? base.tracks : []).map(item => [JSON.stringify(item.path), item]));
    const tracks = [];
    for (const item of layer.tracks || []) {
      const key = JSON.stringify(item.path), previous = old.get(key);
      old.delete(key);
      if (base && JSON.stringify(previous) === JSON.stringify(item)) continue;
      const reference = previous ? previous.value : undefined;
      const moved = (!item.keys || !item.keys.length) && item.path.length === 2 &&
        item.path[0][0] === 'ADBE Transform Group' &&
        /^ADBE Position(_[012])?$/.test(item.path[1][0]) &&
        (typeof reference === 'number' || Array.isArray(reference));
      tracks.push(moved ? Object.assign({}, item, { positionReference: reference }) : item);
    }
    for (const prop of layer.omitted || []) omitted.push(layer.name + ' / ' + prop);
    for (const item of old.values()) removed.push(layer.name + ' / ' + item.path.map(p => p[0]).join(' / '));
    for (const item of tracks) {
      if (!item.keys || !item.keys.length) continue;
      origin = Math.min(origin, item.keys[0].time);
      end = Math.max(end, item.keys[item.keys.length - 1].time);
    }
    if (tracks.length) layers.push({ name: layer.name, tracks });
  }
  if (!Number.isFinite(origin)) origin = end = 0;
  const relative = layers.map(layer => ({
    name: layer.name,
    tracks: layer.tracks.map(item => Object.assign({}, item, {
      keys: (item.keys || []).map(k => Object.assign({}, k, { time: Math.max(0, k.time - origin) })),
    })),
  }));
  return { clip: canonicalizeClip({ origin, duration: Math.max(0, end - origin), layers: relative }), omitted, removed };
}

function saveUserClip(name, tags, clipData, libDir) {
  const root = libDir || getUserLibraryDir();
  const cleanName = String(name || '').trim().slice(0, 120);
  if (!cleanName) throw new Error('请输入动效名称。');
  if (!clipData || !Array.isArray(clipData.layers) || !clipData.layers.length) {
    throw new Error('未检测到可保存的关键帧或表达式动效。');
  }
  const cleanTags = (Array.isArray(tags) ? tags : [])
    .map(t => String(t).trim()).filter(Boolean).slice(0, 20);
  const canonical = canonicalizeClip(clipData);
  const record = {
    schemaVersion: 1,
    id: randomUUID(),
    name: cleanName,
    tags: cleanTags,
    createdAt: new Date().toISOString(),
    contentHash: hashClip(canonical),
    clip: canonical,
  };
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, record.id + '.json');
  const temp = path.join(root, '.' + record.id + '.tmp');
  try {
    fs.writeFileSync(temp, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (e) {}
  }
  return Object.assign({}, record, { file, source: 'user' });
}

function listUserClips(libDir) {
  const root = libDir || getUserLibraryDir();
  if (!fs.existsSync(root)) return [];
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const out = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!uuidRe.test(id)) continue;
    const file = path.join(root, name);
    try {
      const rec = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (rec.schemaVersion !== 1 || rec.id !== id) continue;
      if (hashClip(rec.clip) !== rec.contentHash) continue;
      out.push(Object.assign({}, rec, { file, source: 'user' }));
    } catch (e) {}
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

function importUserClipFile(jsonPath, newName, libDir) {
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8').replace(/^\uFEFF/, ''));
  if (!raw || raw.schemaVersion !== 1 || !raw.clip) throw new Error('不是有效的 F2A 动效 JSON 文件。');
  if (hashClip(raw.clip) !== raw.contentHash) throw new Error('动效文件校验失败（contentHash 不匹配）。');
  return saveUserClip(newName || raw.name, raw.tags || [], raw.clip, libDir);
}

function deleteUserClip(id, libDir) {
  const root = libDir || getUserLibraryDir();
  const file = path.join(root, id + '.json');
  if (fs.existsSync(file)) fs.unlinkSync(file);
  return true;
}

// Renaming only rewrites the record's display name: the id, file name and contentHash stay
// untouched so MCP references and duplicate detection keep working. The write is atomic.
function renameUserClip(id, name, libDir) {
  const root = libDir || getUserLibraryDir();
  const cleanId = String(id || '');
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(cleanId)) throw new Error('动效 ID 无效。');
  const cleanName = String(name || '').trim().slice(0, 120);
  if (!cleanName) throw new Error('请输入动效名称。');
  const file = path.join(root, cleanId + '.json');
  if (!fs.existsSync(file)) throw new Error('未找到该自存动效。');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!rec || rec.schemaVersion !== 1 || rec.id !== cleanId) throw new Error('动效文件格式无效。');
  if (hashClip(rec.clip) !== rec.contentHash) throw new Error('动效文件校验失败（contentHash 不匹配）。');
  rec.name = cleanName;
  const temp = path.join(root, '.' + cleanId + '.tmp');
  try {
    fs.writeFileSync(temp, JSON.stringify(rec, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (e) {}
  }
  return Object.assign({}, rec, { file, source: 'user' });
}

// Exporting writes the record in the same schemaVersion: 1 format importUserClipFile reads
// (and the MCP ae_motion_import accepts), so a file moved to another machine round-trips.
function exportUserClip(id, targetPath, libDir) {
  const root = libDir || getUserLibraryDir();
  const cleanId = String(id || '');
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(cleanId)) throw new Error('动效 ID 无效。');
  const file = path.join(root, cleanId + '.json');
  if (!fs.existsSync(file)) throw new Error('未找到该自存动效。');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!rec || rec.schemaVersion !== 1 || rec.id !== cleanId) throw new Error('动效文件格式无效。');
  if (hashClip(rec.clip) !== rec.contentHash) throw new Error('动效文件校验失败（contentHash 不匹配）。');
  const target = String(targetPath || '').trim();
  if (!target) throw new Error('请选择导出位置。');
  fs.writeFileSync(target, JSON.stringify(rec, null, 2), { encoding: 'utf8' });
  return target;
}

module.exports = {
  getUserLibraryDir,
  getPackCacheDir,
  readZipEntries,
  extractZipEntry,
  scanTemplateDirectory,
  listFolderLevel,
  ensureMogrtPreview,
  extractMogrtAep,
  hashClip,
  makeClipFromSnapshots,
  saveUserClip,
  listUserClips,
  importUserClipFile,
  deleteUserClip,
  renameUserClip,
  exportUserClip,
};
