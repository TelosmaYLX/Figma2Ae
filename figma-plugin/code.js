/*
 * code.js — Figma plugin main thread (sandbox).
 * Exports the current selection as SVG and hands it to the UI iframe,
 * which is the only side allowed to do network (WebSocket to the AE bridge).
 *
 * Main thread can't open sockets, so: export here -> postMessage -> ui.html ships it.
 */

figma.showUI(__html__, { width: 320, height: 390, themeColors: true });


// ===== ORGANIZE MODE =====
// Every Figma container becomes an AE precomp, nested exactly as in Figma. The container's own
// blur / shadow / opacity / blend then belong to the PRECOMP, which is the only way to reproduce
// Figma's rendering: Figma composites a group first and applies the effect to the result, while
// handing the effect down to each child blurs them separately and looks wrong.
function _isContainer(n) {
  return n.type === 'GROUP' || n.type === 'FRAME' || n.type === 'COMPONENT' ||
         n.type === 'COMPONENT_SET' || n.type === 'INSTANCE';
}
// Ancestor container ids, outermost first. Organize mode includes the root so its clip is kept.
function _pathOf(n, rootId) {
  var out = [], p = n.parent, guard = 0;
  while (p && guard++ < 128) {
    if (_isContainer(p) && (p.id !== rootId || _includeRootContainer)) out.push(p.id);
    if (p.id === rootId) break;
    p = p.parent;
  }
  out.reverse();
  return out;
}
// ONE paint order for the whole tree. Shapes, text and pictures are collected by three separate
// walks and land in AE in three separate passes, so their relative stacking was only ever
// approximate — text simply ended up on top. A pre-order index (parent before children, earlier
// sibling before later) IS Figma's paint order, and AE can restore it exactly at the end.
var _zMap = null;
var _ignoreHidden = true;
var _convertMasks = false;      // original-compatible default: masks stay ordinary Figma layers
var _rasterGroups = true;       // exact Figma render for complex mask/image groups
var _rasterByNode = {};         // rasterised group + descendants: collected by the image route
var _includeRootContainer = false;
var _maskByNode = {};          // content node id -> mask ROOT id
var _maskSourceByNode = {};    // mask node + all its descendants -> mask ROOT id
var _exporting = false;        // one export at a time: temporary image fills must never overlap
function buildZMap(root) {
  var map = {}, i = 0;
  (function walk(n) {
    map[n.id] = i++;
    if ('children' in n) for (var c = 0; c < n.children.length; c++) walk(n.children[c]);
  })(root);
  return map;
}
function _zOf(n) { return (_zMap && _zMap[n.id] != null) ? _zMap[n.id] : 0; }

// Build mask relationships BEFORE collecting any channel. A mask applies to the siblings AFTER
// it (Figma's paint order); it is not artwork of its own. This is the vector equivalent of the
// PSD exporter's mask/base handling, without rasterising the design.
function buildImportMaps(root) {
  _maskByNode = {}; _maskSourceByNode = {};
  if (!_convertMasks) return;                // match the original importer exactly
  (function walk(n, inheritedMask, maskRoot) {
    if (_ignoreHidden && _isHidden(n)) return;
    var isMask = false;
    try { isMask = (n.isMask === true); } catch (em) {}
    var activeMaskRoot = maskRoot;
    if (isMask && !activeMaskRoot) activeMaskRoot = n;
    if (activeMaskRoot) _maskSourceByNode[n.id] = activeMaskRoot.id;
    else if (inheritedMask) _maskByNode[n.id] = inheritedMask.id;
    if (n.type === 'BOOLEAN_OPERATION' || !('children' in n)) return;
    var siblingMask = null;
    for (var i = 0; i < n.children.length; i++) {
      var child = n.children[i];
      if (_ignoreHidden && _isHidden(child)) continue;
      walk(child, siblingMask || inheritedMask, activeMaskRoot);
      var childIsMask = false;
      try { childIsMask = (child.isMask === true); } catch (ec) {}
      if (!activeMaskRoot && childIsMask) siblingMask = child;
    }
  })(root, null, null);
}

// A group that uses Figma masks/images/blends cannot be reproduced reliably as separate AE
// shapes. Rasterise the smallest container that owns those features and has no text inside;
// text stays on its own editable channel. This preserves the exact Figma pixels for the
// complex background while keeping text live.
function _subtreeFlags(n, hiddenAncestor) {
  var flags = { mask: false, text: false, complex: false };
  if (!n) return flags;
  if (_ignoreHidden && _isHidden(n)) return flags;
  if (n.type === 'TEXT') flags.text = true;
  if (n.type === 'BOOLEAN_OPERATION') flags.complex = true;   // compound geometry is fragile per-shape
  try { if (n.isMask === true) { flags.mask = true; flags.complex = true; } } catch (e) {}
  try {
    if (n.blendMode && n.blendMode !== 'PASS_THROUGH' && n.blendMode !== 'NORMAL') flags.complex = true;
  } catch (eb) {}
  try {
    var filters = n.effects || [];
    for (var ei = 0; ei < filters.length; ei++) {
      if (filters[ei].visible === false) continue;
      flags.complex = true;
      break;
    }
  } catch (ee) {}
  try {
    var paints = n.fills || [];
    for (var pi = 0; pi < paints.length; pi++) {
      if (paints[pi].visible !== false && paints[pi].type === 'IMAGE') { flags.complex = true; break; }
    }
  } catch (ep) {}
  if (n.type !== 'BOOLEAN_OPERATION' && n.children) {
    for (var i = 0; i < n.children.length; i++) {
      var f = _subtreeFlags(n.children[i], hiddenAncestor);
      flags.mask = flags.mask || f.mask;
      flags.text = flags.text || f.text;
      flags.complex = flags.complex || f.complex;
    }
  }
  return flags;
}
function _markRaster(n) {
  if (!n) return;
  _rasterByNode[n.id] = true;
  if (n.children) for (var i = 0; i < n.children.length; i++) _markRaster(n.children[i]);
}
function _singleImageNeedsRaster(n) {
  if (!n || _isContainer(n) || n.type === 'TEXT' || _maskSourceByNode[n.id] || _maskByNode[n.id]) return false;
  var image = false, crop = false;
  try {
    var paints = n.fills || [];
    for (var i = 0; i < paints.length; i++) {
      var p = paints[i];
      if (p.visible === false || p.type !== 'IMAGE') continue;
      image = true;
      // AE's centred cover-fit is NOT Figma CROP: imageTransform carries the user's crop/zoom.
      // Export just this leaf as rendered by Figma, retaining its own layer and full-resolution
      // appearance instead of silently discarding that transform.
      if (p.scaleMode === 'CROP' || p.imageTransform) crop = true;
    }
    var fx = n.effects || [];
    for (var j = 0; j < fx.length; j++) if (fx[j].visible !== false) crop = true;
  } catch (e) { return false; }
  return image && crop;
}
function _collectRasterCandidates(root) {
  var out = [];
  _rasterByNode = {};
  if (!_rasterGroups) return out;
  function scan(n) {
    if (_ignoreHidden && _isHidden(n)) return;
    var f = _subtreeFlags(n, false);
    if (!f.complex) return;
    if (_isContainer(n) && !f.text) {
      out.push(n);
      _markRaster(n);
      return;
    }
    // A cropped/effected picture is already a bitmap in Figma. Rasterising ONLY THIS LEAF is
    // lossless in appearance and keeps it independently animatable; no sibling/group is merged.
    if (_singleImageNeedsRaster(n)) {
      out.push(n);
      _markRaster(n);
      return;
    }
    var before = out.length;
    if (n.type !== 'BOOLEAN_OPERATION' && n.children)
      for (var i = 0; i < n.children.length; i++) scan(n.children[i]);
    // A mask + text container may have no separable background. Rasterising it (including its
    // text) is the only faithful option; otherwise the text would escape the Figma mask.
    if (_isContainer(n) && f.text && f.mask && out.length === before) {
      out.push(n);
      _markRaster(n);
    }
  }
  if (root.children) for (var i = 0; i < root.children.length; i++) scan(root.children[i]);
  return out;
}

// Metadata for one rasterised group. The actual PNG is exported in shipImages(), after text
// has been hidden, so any text that happens to sit inside a future candidate is not baked in.
function _rasterMeta(n, root, organize) {
  // PNG export includes the node's shadows/blurs. Use the same render bounds so fitting the
  // footage does not shrink the artwork back into the smaller geometry box (or cut the glow).
  var b = n.absoluteRenderBounds || n.absoluteBoundingBox || { x: 0, y: 0, width: 1, height: 1 };
  return {
    rasterNode: n,
    name: (n.name || 'figma-group').replace(/[^A-Za-z0-9_\-\u4e00-\u9fa5]+/g, '_'),
    x: b.x, y: b.y, w: b.width, h: b.height,
    cx: b.x + b.width / 2, cy: b.y + b.height / 2, cw: b.width, ch: b.height,
    natW: Math.max(1, Math.round(b.width * 2)), natH: Math.max(1, Math.round(b.height * 2)),
    scaleMode: 'FIT', opacity: _opacityChain(n, organize, root.id),
    hidden: false, blend: n.blendMode || 'NORMAL',
    path: _pathOf(n, root.id), z: _zOf(n), rotation: _rotOf(n), matte: null
  };
}

// Union of a container and EVERYTHING inside it. A group's own box already covers its children,
// but a FRAME's does not — a list that overflows its card sticks out, and sizing the precomp to
// the frame chopped exactly that overflow off, which made such a group impossible to animate.
function _contentBounds(n) {
  var b = n.absoluteBoundingBox;
  if (!b) return null;
  var minx = b.x, miny = b.y, maxx = b.x + b.width, maxy = b.y + b.height;
  (function walk(m) {
    if (!('children' in m)) return;
    for (var i = 0; i < m.children.length; i++) {
      var c = m.children[i];
      if (_ignoreHidden && _isHidden(c)) continue;       // hidden art must not inflate precomps
      if (_maskSourceByNode[c.id]) continue;             // mask geometry is not visible content
      try {
        var cb = c.absoluteBoundingBox;
        if (cb) {
          if (cb.x < minx) minx = cb.x;
          if (cb.y < miny) miny = cb.y;
          if (cb.x + cb.width > maxx) maxx = cb.x + cb.width;
          if (cb.y + cb.height > maxy) maxy = cb.y + cb.height;
        }
      } catch (e) {}
      // A rasterised group is one image: its own box is the content, not its overflowing
      // texture descendants. Expanding them made the root precomp many times too large.
      if (_rasterByNode[c.id]) continue;
      if (c.type !== 'BOOLEAN_OPERATION') walk(c);   // operands are not drawn
    }
  })(n);
  return { x: minx, y: miny, w: Math.max(1, maxx - minx), h: Math.max(1, maxy - miny) };
}

function _isPureTextContainer(n) {
  if (!_isContainer(n) || n.clipsContent === true) return false;
  try { if ((n.fills || []).length || (n.strokes || []).length) return false; } catch (e) { return false; }
  try {
    var fx = n.effects || [];
    for (var i = 0; i < fx.length; i++) if (fx[i].visible !== false) return false;
  } catch (e2) { return false; }
  if (typeof n.opacity === 'number' && n.opacity < 1) return false;
  if (n.blendMode && n.blendMode !== 'PASS_THROUGH' && n.blendMode !== 'NORMAL') return false;
  var hasText = false, hasPaint = false;
  (function walk(m) {
    if (!m || (_ignoreHidden && _isHidden(m))) return;
    if (m.type === 'TEXT') hasText = true;
    else if (m !== n) {
      try { if ((m.fills || []).length || (m.strokes || []).length) hasPaint = true; } catch (e3) {}
      try { if (m.isMask === true) hasPaint = true; } catch (e4) {}
    }
    if (m.children) for (var j = 0; j < m.children.length; j++) walk(m.children[j]);
  })(n);
  return hasText && !hasPaint;
}

// Flat table of every container under the root, with what the precomp will need.
function collectContainers(root) {
  var out = [];
  (function walk(n) {
    if (_ignoreHidden && _isHidden(n)) return;
    if (_rasterByNode[n.id]) return;            // rendered by Figma's PNG export instead
    if (_maskSourceByNode[n.id]) return;       // a mask container is not an artwork precomp
    if (_isPureTextContainer(n)) return;       // transparent text-only frame: no precomp needed
    if (_isContainer(n) && (n !== root || _includeRootContainer)) {
      var b = n.absoluteBoundingBox;
      if (b) {
        var effs = [], blur = 0, i;
        try {
          var es = n.effects || [];
          for (i = 0; i < es.length; i++) {
            var e = es[i];
            if (e.visible === false) continue;
            if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
              effs.push({ kind: (e.type === 'DROP_SHADOW') ? 'drop' : 'inner',
                          color: [e.color.r, e.color.g, e.color.b], alpha: (e.color.a != null ? e.color.a : 1),
                          dx: (e.offset ? e.offset.x : 0), dy: (e.offset ? e.offset.y : 0),
                          blur: e.radius || 0, spread: e.spread || 0 });
            } else if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') {
              if ((e.radius || 0) > blur) blur = e.radius || 0;
            }
          }
        } catch (ee) {}
        // Only the clipping case needs an exact box (the comp edge is what cuts). A plain group
        // keeps a frame-sized comp, so no render-bounds probing is needed — and that call is not
        // cheap on a big group.
        out.push({
          id: n.id, name: n.name || 'Group', type: n.type,
          root: (n === root),
          path: _pathOf(n, root.id), z: _zOf(n),
          x: b.x, y: b.y, w: b.width, h: b.height,
          // What the precomp must be able to hold. A clipping frame hides its overflow anyway,
          // so for it the box IS the content; everything else takes the union with its children.
          cb: (n.clipsContent === true) ? { x: b.x, y: b.y, w: b.width, h: b.height } : _contentBounds(n),
          opacity: (typeof n.opacity === 'number' ? n.opacity : 1),
          blend: n.blendMode || 'PASS_THROUGH',
          clip: n.clipsContent === true,
          // corner radius travels too: the clip is rebuilt in AE as a rounded-rect mask
          r: (typeof n.cornerRadius === 'number') ? n.cornerRadius
             : ((typeof n.topLeftRadius === 'number') ? n.topLeftRadius : 0),
          hidden: _isHidden(n),
          blur: blur, fx: effs
        });
      }
    }
    // operands of a boolean are never rendered — a group inside one must not become a precomp
    if (n.type !== 'BOOLEAN_OPERATION' && 'children' in n)
      for (var c = 0; c < n.children.length; c++) walk(n.children[c]);
  })(root);
  return out;
}

async function exportSelectionSVG(useNodes, organize, ignoreHidden, convertMasks, rasterGroups) {
  if (_exporting) {
    figma.ui.postMessage({ type: 'error', message: '上一次导出仍在进行，请稍候。' });
    return;
  }
  _ignoreHidden = (ignoreHidden !== false);       // default: hidden Figma layers stay out of AE
  _convertMasks = (convertMasks === true);        // opt-in only; original behaviour otherwise
  _rasterGroups = (rasterGroups !== false);       // default: exact Figma PNG for complex mask groups
  _includeRootContainer = !!organize && !!useNodes;
  var sel = figma.currentPage.selection;
  if (!sel || sel.length === 0) {
    figma.ui.postMessage({ type: 'error', message: '请至少选择一个图层或画框。' });
    return;
  }
  _exporting = true;

  // If one node is selected, export it directly (keeps its name).
  // If several, wrap them in a temporary group so they export as one SVG, then ungroup.
  var node, tempGroup = null, name;
  if (sel.length === 1) {
    node = sel[0];
    name = node.name;
  } else {
    tempGroup = figma.group(sel, figma.currentPage);
    tempGroup.name = 'SaaS Kit Export';
    node = tempGroup;
    name = 'Selection (' + sel.length + ')';
  }

  var restore = [];   // [textNode, originalOpacity] to undo the hide after export
  var clipWasOn = false;
  var restoreFills = [];   // [imageNode, originalFills] — undone after the export
  try {
    if (typeof node.exportAsync !== 'function') {
      figma.ui.postMessage({ type: 'error', message: '此图层类型无法导出为 SVG。' });
      return;
    }

    // Collect editable text (string, font, size, colour, position) BEFORE export,
    // so AE can rebuild real text layers instead of vector outlines.
    // Collect in ABSOLUTE coords first; the SVG's origin is resolved after the text is
    // hidden (below), because that changes a group's render bounds.
    // In organize mode the group's blur and opacity stay ON THE GROUP (they become the precomp's),
    // so they must NOT be multiplied into the children as well — that would apply them twice.
    _zMap = buildZMap(node);
    buildImportMaps(node);
    var rasterCandidates = _collectRasterCandidates(node);
    var nodeShapes = useNodes ? collectShapes(node, !!organize) : null;
    var containers = organize ? collectContainers(node) : null;
    var texts = collectTexts(node, { x: 0, y: 0 }, node.id, !!organize);
    var effects = collectEffects(node, { x: 0, y: 0 });
    var images = await collectImages(node, node.id, !!organize);
    for (var rci = 0; rci < rasterCandidates.length; rci++) images.push(_rasterMeta(rasterCandidates[rci], node, !!organize));

    // Disable clipping only AFTER the container table has captured it. The root is exported
    // uncut so off-frame artwork survives, then collectContainers restores that boundary as an
    // AE mask on the root precomp. Child clipping was never disabled.
    if (node.clipsContent === true) {
      clipWasOn = true;
      try { node.clipsContent = false; } catch (ec) { clipWasOn = false; }
    }

    // In node mode a leaf carries its own shadows (nd.fx), but a shadow set on a GROUP has no
    // geometry to ride on and used to vanish. Flag which effect entries belong to leaves so the
    // bbox matcher can be left to handle exactly the group-level ones, with no double shadows.
    if (nodeShapes && nodeShapes.length) {
      var ownedIds = {};
      for (var oi = 0; oi < nodeShapes.length; oi++) if (nodeShapes[oi].id) ownedIds[nodeShapes[oi].id] = 1;
      for (var ei2 = 0; ei2 < effects.length; ei2++) effects[ei2].leaf = !!ownedIds[effects[ei2].id];
    }

    // Figma requires every current font to be loaded before mutating a TEXT node — even an
    // opacity write can otherwise throw. Load the actual fonts from the styled segments first.
    var fontJobs = {}, fontWaits = [];
    for (var tf = 0; tf < texts.length; tf++) {
      var textNode = texts[tf]._node;
      if (!textNode) continue;
      try {
        var fontSegs = textNode.getStyledTextSegments(['fontName']);
        for (var fs = 0; fs < fontSegs.length; fs++) {
          var fn = fontSegs[fs].fontName;
          if (!fn || fn === figma.mixed || !fn.family) continue;
          var fontKey = fn.family + '\n' + (fn.style || 'Regular');
          if (fontJobs[fontKey]) continue;
          fontJobs[fontKey] = true;
          fontWaits.push(figma.loadFontAsync(fn).catch(function () {}));
        }
      } catch (efl) {}
    }
    await Promise.all(fontWaits);

    // Only legacy SVG mode needs outlined text hidden. Node mode never reads those outlines,
    // so mutating text opacity was both unnecessary and dangerous: a second export could read
    // that temporary zero and recreate every AE text layer at 0% opacity. Keep Figma untouched.
    var kept = [];
    for (var h = 0; h < texts.length; h++) {
      var tn = texts[h]._node, hidden = false;
      if (tn && !useNodes) {
        restore.push([tn, tn.opacity]);
        try { tn.opacity = 0; hidden = (tn.opacity === 0); } catch (eh) { hidden = false; }
      }
      delete texts[h]._node;
      // Node mode reads text directly from the Figma tree, so it never needs the SVG outline.
      // Keep the text even when a locked/instance node refuses the temporary opacity write.
      if (hidden || useNodes) kept.push(texts[h]);
    }
    texts = kept;

    // Picture nodes must NOT export their pixels: Figma embeds them as base64 data-URIs and
    // the multi-megabyte string aborts the plugin VM. Hiding them worked, but then nothing was
    // left in the SVG to mark WHERE they belong, so the footage always landed on top of the
    // scene. Swap the fill for a flat marker colour instead: the shape keeps its exact place in
    // the stack, carries no pixels, and AE turns it into an empty slot for the footage.
    for (var hi = 0; hi < images.length; hi++) {
      var inod = images[hi]._node;
      if (inod) {
        try {
          restoreFills.push([inod, inod.fills]);
          inod.fills = [{ type: 'SOLID', color: { r: 254 / 255, g: 0, b: 1 }, opacity: 1 }];
        } catch (ei) {
          restore.push([inod, inod.opacity]);
          try { inod.opacity = 0; } catch (ei2) {}     // locked node: fall back to hiding it
        }
      }
      delete images[hi]._node;
    }

    var isFrameLike = (node.type === 'FRAME' || node.type === 'COMPONENT' ||
                       node.type === 'COMPONENT_SET' || node.type === 'INSTANCE');

    // Works for any node: frame, group, component, or a single shape/vector.
    // Pure-text selections have nothing left to raster after we hide the text -> export throws
    // "no visible layers". Catch that and ship an EMPTY svg of the node's size (text-only import).
    var svg = '';
    try {
      var bytes = await node.exportAsync({ format: 'SVG', svgIdAttribute: true });   // keeps Figma layer names
      // Uint8Array -> string, chunked (fromCharCode.apply caps at ~65534 args).
      var CHUNK = 8192;
      for (var i = 0; i < bytes.length; i += CHUNK) {
        svg += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
      }
    } catch (exp) { svg = ''; }

    if (!svg || svg.indexOf('<svg') === -1) {
      var bb = node.absoluteBoundingBox || { width: 1, height: 1 };
      var W = Math.max(1, Math.round(bb.width || 1)), H = Math.max(1, Math.round(bb.height || 1));
      svg = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg"></svg>';
    }
    // ORIGIN OF THE EXPORTED SVG — measured, not assumed.
    // With clipping off Figma sizes the SVG to the render bounds and offsets the frame inside
    // it with a translate() on the first drawable (e.g. translate(412) when a glow bleeds
    // 412px to the left). Reading that translate gives the exact zero; absoluteRenderBounds is
    // only the fallback, since it can lag behind the changes we just made.
    var bbox = node.absoluteBoundingBox || { x: 0, y: 0, width: 0, height: 0 };
    var origin = { x: bbox.x, y: bbox.y };      // texts/images are always FRAME-relative
    var svgShift = { x: 0, y: 0 };              // where the frame sits INSIDE the exported SVG
    var vb = svg.substr(0, 400).match(/viewBox="\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
    var vw = vb ? parseFloat(vb[3]) : 0, vh = vb ? parseFloat(vb[4]) : 0;
    var grew = !(bbox.width && Math.abs(vw - bbox.width) < 1.5 && Math.abs(vh - bbox.height) < 1.5);

    if (grew) {
      // The canvas is bigger than the node, so the node sits at an offset inside it. Figma
      // writes that offset as a translate() on the first drawable. Search only the part before
      // <defs>: translates also appear inside filter/clip definitions and matching one of those
      // would hand back a wildly wrong zero.
      var head = svg.split('<defs')[0].substr(0, 4000);
      var tm = head.match(/transform="translate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?\s*\)"/);
      if (tm) {
        svgShift.x = parseFloat(tm[1]);
        svgShift.y = (tm[2] != null ? parseFloat(tm[2]) : 0);
      } else {
        // No marker (a frame with no background fill): derive it from the render bounds.
        try {
          var rb = node.absoluteRenderBounds;
          if (rb && typeof rb.x === 'number') { svgShift.x = bbox.x - rb.x; svgShift.y = bbox.y - rb.y; }
        } catch (erb) {}
      }
    } else if (!isFrameLike && !nodeShapes) {
      // Legacy SVG-only mode needs render-bounds coordinates. Node mode is always relative to
      // the selected node's GEOMETRY box: with editable text left visible, absoluteRenderBounds
      // can grow and would otherwise shift the entire board (this board moved +329,-88 px).
      try { var rb2 = node.absoluteRenderBounds; if (rb2 && typeof rb2.x === 'number') origin = { x: rb2.x, y: rb2.y }; } catch (erb2) {}
    }
    // Node mode collects absolute coordinates; re-base them on the frame exactly like the
    // other channels, so shapes, text and pictures all share one origin.
    if (nodeShapes) {
      for (var ns = 0; ns < nodeShapes.length; ns++) {
        var nsh = nodeShapes[ns];
        nsh.matrix[4] -= origin.x; nsh.matrix[5] -= origin.y;
        var lists = [nsh.fills, nsh.strokes];
        for (var li = 0; li < lists.length; li++) {
          for (var pi2 = 0; pi2 < lists[li].length; pi2++) {
            var pp = lists[li][pi2];
            if (pp && pp.p0) { pp.p0[0] -= origin.x; pp.p0[1] -= origin.y; pp.p1[0] -= origin.x; pp.p1[1] -= origin.y; }
          }
        }
      }
    }
    shiftToOrigin(texts, effects, origin);
    for (var im = 0; im < images.length; im++) {
      images[im].x -= origin.x; images[im].y -= origin.y;
      images[im].cx -= origin.x; images[im].cy -= origin.y;
    }

    // containers are frame-relative too, so the precomps line up with everything else
    if (containers) for (var ci = 0; ci < containers.length; ci++) {
      containers[ci].x -= origin.x; containers[ci].y -= origin.y;
      if (containers[ci].cb) { containers[ci].cb.x -= origin.x; containers[ci].cb.y -= origin.y; }

    }

    figma.ui.postMessage({ type: 'ship', name: name, svg: svg, texts: texts, effects: effects,
                           shift: svgShift, nodes: nodeShapes, nodeOrigin: origin, bytes: svg.length,
                           containers: containers, organize: !!organize, imageCount: images.length,
                           vnStats: _vnStats });
    await shipImages(images);      // sequential, chunked — see shipImages for why
  } catch (e) {
    figma.ui.postMessage({ type: 'error', message: '导出失败：' + (e && e.message ? e.message : e) });
  } finally {
    for (var rr = 0; rr < restore.length; rr++) { try { restore[rr][0].opacity = restore[rr][1]; } catch (er) {} }
    for (var rf = 0; rf < restoreFills.length; rf++) { try { restoreFills[rf][0].fills = restoreFills[rf][1]; } catch (erf) {} }
    if (clipWasOn) { try { node.clipsContent = true; } catch (erc) {} }   // put the frame back
    if (tempGroup) figma.ungroup(tempGroup);   // restore the user's layers
    _exporting = false;
  }
}

// ===== NODE-TREE SHAPE CHANNEL (beta) =====
// Geometry read straight from Figma instead of from its SVG export. Figma splits a layer's
// paints into separate SVG elements (and hides stroke alignment entirely), which is what made
// duplicate layers unavoidable; the node tree states everything explicitly, so one Figma layer
// becomes exactly one AE layer.

// Paint -> our model. Gradient handles are normalised to the node box, so they are mapped
// through the node's own transform (never the axis-aligned bbox, which skews the angle).
function _paint(p, n) {
  if (!p || p.visible === false) return null;
  var op = (p.opacity == null ? 1 : p.opacity);
  if (p.type === 'SOLID') {
    return { kind: 'solid', color: [p.color.r, p.color.g, p.color.b], opacity: op };
  }
  if (p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL' ||
      p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND') {
    var stops = [];
    for (var i = 0; i < p.gradientStops.length; i++) {
      var st = p.gradientStops[i];
      stops.push({ offset: st.position, color: [st.color.r, st.color.g, st.color.b],
                   opacity: (st.color.a == null ? 1 : st.color.a) });
    }
    var h0 = { x: 0, y: 0.5 }, h1 = { x: 1, y: 0.5 };
    var gt = p.gradientTransform;
    if (gt && gt[0] && gt[1]) {
      var a = gt[0][0], c = gt[0][1], e = gt[0][2];
      var b = gt[1][0], d = gt[1][1], f2 = gt[1][2];
      var det = a * d - c * b;
      if (det) {
        var inv = function (x, y) {
          var nx = x - e, ny = y - f2;
          return { x: (d * nx - c * ny) / det, y: (-b * nx + a * ny) / det };
        };
        h0 = inv(0, 0.5); h1 = inv(1, 0.5);
      }
    }
    function abs(hp) {
      var lx = hp.x * n.width, ly = hp.y * n.height;
      try {
        var m = n.absoluteTransform;
        return [m[0][0] * lx + m[0][1] * ly + m[0][2], m[1][0] * lx + m[1][1] * ly + m[1][2]];
      } catch (er) { return [lx, ly]; }
    }
    return { kind: 'grad', type: (p.type === 'GRADIENT_RADIAL' ? 'radial' : 'linear'),
             stops: stops, opacity: op, p0: abs(h0), p1: abs(h1) };
  }
  if (p.type === 'IMAGE') return { kind: 'image' };
  return null;
}

function _paints(list, n) {
  var out = [];
  if (!list || list === figma.mixed) return out;
  for (var i = 0; i < list.length; i++) {
    var q = _paint(list[i], n);
    if (q) out.push(q);
  }
  return out;
}

var CAP = { NONE: 1, ROUND: 2, SQUARE: 3 };
var JOIN = { MITER: 1, ROUND: 2, BEVEL: 3 };

// Why a multi-region vector did or did not get split, so a black cursor can be diagnosed from
// the panel instead of guessed at.
var _vnStats = null;
function collectShapes(root, organize) {
  var out = [];
  _vnStats = { multi: 0, net: 0, mismatch: 0, split: 0, same: 0 };
  // A blur is usually set on the GROUP, not on the shapes inside it (Figma renders the group
  // as one surface). Groups carry no geometry, so their effect has to be handed down to the
  // children — otherwise the blur simply disappeared in node mode.
  (function walk(n, inheritedBlur, inheritedOpacity) {
    if (_ignoreHidden && _isHidden(n)) return;
    if (_rasterByNode[n.id]) return;           // whole group arrives as one Figma PNG
    var isGroup = _isContainer(n) && (n !== root || _includeRootContainer);
    var groupBlur = inheritedBlur || 0;
    // Group opacity multiplies down the tree in Figma (and did in the SVG path). Taking only
    // the node's own value made everything inside a faded group come in at full strength.
    // In organize mode the container keeps its own opacity — the precomp layer carries it.
    var own = (typeof n.opacity === 'number' ? n.opacity : 1);
    var chainOpacity = (inheritedOpacity == null ? 1 : inheritedOpacity) *
                       ((organize && isGroup) ? 1 : own);
    try {
      var ge = n.effects || [];
      for (var gi = 0; gi < ge.length; gi++) {
        var gef = ge[gi];
        if (gef.visible === false) continue;
        // organize mode: a container's blur goes on its precomp, not down onto the children
        if (organize && isGroup) continue;
        if ((gef.type === 'LAYER_BLUR' || gef.type === 'BACKGROUND_BLUR') && (gef.radius || 0) > groupBlur) {
          groupBlur = gef.radius || 0;
        }
      }
    } catch (egb) {}
    try {
      if (n.type !== 'TEXT' && n.absoluteBoundingBox && typeof n.fillGeometry !== 'undefined') {
        var geo = n.fillGeometry || [];
        var fills = _paints(n.fills, n);
        var strokes = _paints(n.strokes, n);
        var strokeAsFill = false;

        // A stroke-only shape (divider, progress bar, icon line) has an EMPTY fillGeometry —
        // there is nothing to fill — so requiring it dropped those layers entirely. Fall back
        // to the centreline, which keeps the stroke editable in AE; if the node has none, use
        // the outlined stroke and paint it as a fill.
        if (!geo.length && strokes.length) {
          try { if (n.vectorPaths && n.vectorPaths.length) geo = n.vectorPaths; } catch (evp) {}
          if (!geo.length) {
            try { geo = n.strokeGeometry || []; strokeAsFill = geo.length > 0; } catch (esg) {}
          }
        }
        var hasImage = false;
        for (var q = 0; q < fills.length; q++) if (fills[q].kind === 'image') hasImage = true;

        // PARAMETRIC PRIMITIVES. AE has real Rectangle and Ellipse shapes with editable Size /
        // Roundness; arriving as a raw path makes them dead geometry. Only exact matches qualify:
        // AE's Rect has ONE roundness value, so mixed Figma corners stay a path, and an ELLIPSE
        // that is really an arc or a donut keeps its outline (that is the progress ring).
        var prim = null;
        try {
          if (!strokeAsFill) {
            if (n.type === 'RECTANGLE' || n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE') {
              if (typeof n.cornerRadius === 'number') prim = { k: 'rect', w: n.width, h: n.height, r: n.cornerRadius || 0 };
            } else if (n.type === 'ELLIPSE') {
              var full = true;
              try {
                var ad = n.arcData;
                if (ad && ((ad.innerRadius || 0) > 0 ||
                           Math.abs((ad.endingAngle - ad.startingAngle) - Math.PI * 2) > 1e-4)) full = false;
              } catch (ead) {}
              if (full) prim = { k: 'ellipse', w: n.width, h: n.height };
            }
          }
        } catch (eprim) {}

        // PER-REGION FILLS. A Figma vector network can paint each region a different colour —
        // the mouse cursor is one node whose body is white and whose outline regions are black.
        // n.fills only reports the node-level paint, so the whole thing came out in one colour
        // (solid black, body and all). Split such a node into one piece per region instead.
        var pieces = null;
        try {
          // Not gated on n.type: a boolean op or a frame-bound vector carries a network too, and
          // requiring VECTOR is what kept the cursor black. Just ask for the network.
          var vn = null;
          try { vn = n.vectorNetwork || null; } catch (evn0) { vn = null; }
          var rgs = vn && vn.regions ? vn.regions : null;
          if (geo.length > 1) _vnStats.multi++;
          if (rgs) _vnStats.net++;
          if (rgs && rgs.length !== geo.length) _vnStats.mismatch++;
          if (rgs && rgs.length === geo.length && geo.length > 1) {
            var seen = {}, kinds = 0, r0;
            for (r0 = 0; r0 < rgs.length; r0++) {
              var key = JSON.stringify(rgs[r0].fills || null);
              if (!seen[key]) { seen[key] = 1; kinds++; }
            }
            if (kinds <= 1) _vnStats.same++;
            if (kinds > 1) {                       // only worth splitting when they really differ
              pieces = [];
              for (r0 = 0; r0 < rgs.length; r0++) {
                var rf = (rgs[r0].fills && rgs[r0].fills.length) ? _paints(rgs[r0].fills, n) : fills;
                if (!rf.length) continue;
                pieces.push({ d: [{ d: geo[r0].data, evenOdd: geo[r0].windingRule === 'EVENODD' }], fills: rf });
              }
              if (pieces.length < 2) pieces = null; else _vnStats.split++;
            }
          }
        } catch (evn) { pieces = null; }

        if (geo.length && (fills.length || strokes.length)) {
          var d = [];
          for (var g = 0; g < geo.length; g++) d.push({ d: geo[g].data, evenOdd: geo[g].windingRule === 'EVENODD' });
          var m = n.absoluteTransform;
          if (pieces) {
            // one AE layer per painted region, in the network's own order (first = bottom)
            for (var pz = 0; pz < pieces.length; pz++) {
              out.push({
                name: n.name, id: n.id + '/' + pz,
                maskId: _maskByNode[n.id] || null, maskSource: _maskSourceByNode[n.id] || null,
                maskType: n.maskType || 'ALPHA',
                path: _pathOf(n, root.id), z: _zOf(n),
                prim: null, hidden: _isHidden(n), opacity: chainOpacity,
                blend: n.blendMode || 'NORMAL',
                paths: pieces[pz].d,
                matrix: [m[0][0], m[1][0], m[0][1], m[1][1], m[0][2], m[1][2]],
                fills: pieces[pz].fills, strokes: (pz === pieces.length - 1 ? strokes : []),
                imageFill: false, strokeAsFill: false,
                strokeWeight: (typeof n.strokeWeight === 'number' ? n.strokeWeight : 1),
                strokeAlign: n.strokeAlign || 'CENTER',
                cap: CAP[n.strokeCap] || null, join: JOIN[n.strokeJoin] || null,
                miter: (typeof n.strokeMiterLimit === 'number' ? n.strokeMiterLimit : null),
                dash: (n.dashPattern && n.dashPattern.length) ? n.dashPattern.slice(0) : null,
                fx: (pz === 0 ? _textEffects(n) : []),     // one shadow per node, not per region
                inheritedBlur: groupBlur
              });
            }
            if (n.type !== 'BOOLEAN_OPERATION' && 'children' in n)
              for (var ch0 = 0; ch0 < n.children.length; ch0++) walk(n.children[ch0], groupBlur, chainOpacity);
            return;
          }
          out.push({
            name: n.name,
            id: n.id,                        // lets group effects tell leaves apart (see exportNode)
            maskId: _maskByNode[n.id] || null,
            maskSource: _maskSourceByNode[n.id] || null,
            maskType: n.maskType || 'ALPHA',
            // A FRAME is BOTH a container and a painted layer: the card's own background. Its
            // path must therefore include ITSELF, or the background ends up as a sibling of its
            // own precomp instead of the bottom layer inside it.
            path: (organize && isGroup) ? _pathOf(n, root.id).concat([n.id]) : _pathOf(n, root.id),
            z: _zOf(n),                      // paint order across the whole tree
            prim: prim,
            hidden: _isHidden(n),
            opacity: chainOpacity,
            blend: n.blendMode || 'NORMAL',
            paths: d,
            matrix: [m[0][0], m[1][0], m[0][1], m[1][1], m[0][2], m[1][2]],   // a,b,c,d,e,f
            fills: fills,
            strokes: strokes,
            imageFill: hasImage,
            strokeAsFill: strokeAsFill,
            strokeWeight: (typeof n.strokeWeight === 'number' ? n.strokeWeight : 1),
            strokeAlign: n.strokeAlign || 'CENTER',
            cap: CAP[n.strokeCap] || null,
            join: JOIN[n.strokeJoin] || null,
            miter: (typeof n.strokeMiterLimit === 'number' ? n.strokeMiterLimit : null),
            dash: (n.dashPattern && n.dashPattern.length) ? n.dashPattern.slice(0) : null,
            // effects belong to the node, so no bounding-box matching is needed here.
            // In organize mode a container's shadow is carried by its PRECOMP, so leaving it on
            // the background as well drew the same drop shadow twice.
            fx: ((organize && isGroup) ? [] : _textEffects(n)),
            inheritedBlur: groupBlur          // blur set on an ancestor group
          });
        }
      }
    } catch (e) {}
    // children are painted after the parent, so keep the natural order.
    // EXCEPT a boolean operation: Figma renders the RESULT only, its operands are not drawn.
    // Descending into them collected the operand shapes as real layers, and since they cover the
    // same area, a black operand painted straight over the white result — the mouse cursor came
    // in as one solid black blob.
    if (n.type === 'BOOLEAN_OPERATION') return;
    if ('children' in n) for (var i = 0; i < n.children.length; i++) walk(n.children[i], groupBlur, chainOpacity);
  })(root, 0, 1);
  return out;
}

// Re-base collected absolute coordinates onto the exported SVG's origin.
function shiftToOrigin(texts, effects, o) {
  var i;
  for (i = 0; i < texts.length; i++) {
    texts[i].x -= o.x; texts[i].y -= o.y;
    if (texts[i].ink) { texts[i].ink.x -= o.x; texts[i].ink.y -= o.y; }
    var gr = texts[i].grad;
    if (gr && gr.p0) { gr.p0[0] -= o.x; gr.p0[1] -= o.y; gr.p1[0] -= o.x; gr.p1[1] -= o.y; }
    if (texts[i].segs) for (var q = 0; q < texts[i].segs.length; q++) {}
  }
  for (i = 0; i < effects.length; i++) { effects[i].x -= o.x; effects[i].y -= o.y; }
}

// Collect Figma layer effects (shadows, blurs) per node, with the node's bbox so AE can
// attach the matching effect to the right imported layer.
function collectEffects(root, rootBox) {
  var out = [];
  function walk(n) {
    if (_ignoreHidden && _isHidden(n)) return;
    if (_rasterByNode[n.id]) return;
    if (_maskSourceByNode[n.id]) return;
    try {
      // TEXT effects are attached to the text layer directly (see _textEffects), not matched by bbox.
      if (n.type !== 'TEXT' && n.effects && n.effects.length && n.absoluteBoundingBox) {
        var b = n.absoluteBoundingBox, effs = [];
        for (var i = 0; i < n.effects.length; i++) {
          var e = n.effects[i];
          if (e.visible === false) continue;
          if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
            effs.push({
              kind: (e.type === 'DROP_SHADOW') ? 'drop' : 'inner',
              color: [e.color.r, e.color.g, e.color.b], alpha: (e.color.a != null ? e.color.a : 1),
              dx: (e.offset ? e.offset.x : 0), dy: (e.offset ? e.offset.y : 0),
              blur: e.radius || 0, spread: e.spread || 0
            });
          } else if (e.type === 'LAYER_BLUR') {
            effs.push({ kind: 'blur', radius: e.radius || 0 });
          } else if (e.type === 'BACKGROUND_BLUR') {
            effs.push({ kind: 'bgblur', radius: e.radius || 0 });
          }
        }
        if (effs.length) out.push({ id: n.id, x: b.x - rootBox.x, y: b.y - rootBox.y, w: b.width, h: b.height, effects: effs });
      }
    } catch (e) {}
    if (n.type !== 'BOOLEAN_OPERATION' && 'children' in n)
      for (var i = 0; i < n.children.length; i++) walk(n.children[i]);
  }
  walk(root);
  return out;
}

// ---- IMAGE fills -> real footage in AE (+ a matte when the picture is cropped) ----
function _ext(bytes) {
  if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
  if (bytes.length > 2 && bytes[0] === 0xFF && bytes[1] === 0xD8) return "jpg";
  if (bytes.length > 3 && bytes[0] === 0x47 && bytes[1] === 0x49) return "gif";
  return "png";
}
// The shape that clips the picture, so AE can rebuild it as a track matte.
function _matteOf(n) {
  try {
    if (n.type === 'ELLIPSE') return { kind: 'ellipse' };
    var r = 0;
    if (typeof n.cornerRadius === 'number') r = n.cornerRadius;
    else if (n.cornerRadius === figma.mixed && typeof n.topLeftRadius === 'number') r = n.topLeftRadius;
    return { kind: 'rect', r: r || 0 };
  } catch (e) { return { kind: 'rect', r: 0 }; }
}
async function collectImages(root, rootId, organize) {
  // METADATA ONLY. Bytes are fetched later, ONE image at a time (shipImages) — holding every
  // photo in the plugin VM at once is what blew its memory cap.
  var out = [];
  var stack = [root];
  while (stack.length) {
    var n = stack.pop();
    if (_ignoreHidden && _isHidden(n)) continue;
    if (_rasterByNode[n.id]) continue;
    if (_maskSourceByNode[n.id]) continue;
    try {
      if (n.fills && n.fills !== figma.mixed && n.absoluteBoundingBox) {
        for (var i = 0; i < n.fills.length; i++) {
          var f = n.fills[i];
          if (f.type !== 'IMAGE' || f.visible === false || !f.imageHash) continue;
          var b = n.absoluteBoundingBox;
          var mode = f.scaleMode || 'FILL';
          var m = _matteOf(n);
          var needsMatte = (m.kind !== 'rect') || (m.r > 0) || (mode !== 'FIT');
          // absoluteBoundingBox is AXIS-ALIGNED, so for a rotated picture it is bigger than
          // the frame itself. Send the node's OWN size plus its true centre (from
          // absoluteTransform) so AE can place and crop it correctly at any angle.
          var lw = n.width, lh = n.height, ccx = b.x + b.width / 2, ccy = b.y + b.height / 2;
          try {
            var mt = n.absoluteTransform;
            ccx = mt[0][0] * (lw / 2) + mt[0][1] * (lh / 2) + mt[0][2];
            ccy = mt[1][0] * (lw / 2) + mt[1][1] * (lh / 2) + mt[1][2];
          } catch (etm) {}
          out.push({
            _node: n,
            name: (n.name || 'image').replace(/[^A-Za-z0-9_\-]+/g, '_'),
            hash: f.imageHash,
            cx: ccx, cy: ccy, cw: lw, ch: lh,
            x: b.x, y: b.y, w: b.width, h: b.height,
          // What the precomp must be able to hold. A clipping frame hides its overflow anyway,
          // so for it the box IS the content; everything else takes the union with its children.
          cb: (n.clipsContent === true) ? { x: b.x, y: b.y, w: b.width, h: b.height } : _contentBounds(n),
            // Was the node's OWN opacity only, so a picture inside a faded group arrived at full
            // strength. The chain fixes that, and in organize mode it stops at the container
            // because the precomp carries the group's opacity.
            scaleMode: mode, opacity: _opacityChain(n, organize, rootId), hidden: _isHidden(n),
            maskId: _maskByNode[n.id] || null,
            blend: n.blendMode || 'NORMAL', path: _pathOf(n, rootId), z: _zOf(n),
            rotation: _rotOf(n), matte: needsMatte ? m : null
          });
          break;                                              // one picture per node
        }
      }
    } catch (e) {}
    // operands of a boolean are not rendered by Figma, so nothing inside one is a real layer
    if (n.type !== 'BOOLEAN_OPERATION' && 'children' in n)
      for (var c = 0; c < n.children.length; c++) stack.push(n.children[c]);
  }
  return out;
}

// Ship pictures sequentially. Everything that crosses the sandbox boundary must be cheap:
//  - encode with the NATIVE figma.base64Encode (runs outside the JS VM);
//  - post the base64 as ~1MB STRING chunks (strings are primitives — deepFreeze is O(1);
//    a Uint8Array gets frozen PER ELEMENT, which is exactly what aborted the runtime).
function _pngSize(bytes) {
  try {
    if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
      return { width: (bytes[16] << 24 | bytes[17] << 16 | bytes[18] << 8 | bytes[19]) >>> 0,
               height: (bytes[20] << 24 | bytes[21] << 16 | bytes[22] << 8 | bytes[23]) >>> 0 };
    }
  } catch (e) {}
  return null;
}

async function shipImages(images) {
  if (!images.length) return;
  if (typeof figma.base64Encode !== 'function') {
    figma.notify('已跳过图片——当前 Figma 版本不支持 base64Encode');
    figma.ui.postMessage({ type: 'image-abort' });
    return;
  }
  var CHUNK = 1024 * 1024;
  for (var q = 0; q < images.length; q++) {
    var im = images[q], b64 = '', ext = 'png', natW = 0, natH = 0;
    try {
      var bytes;
      if (im.rasterNode) {
        bytes = await im.rasterNode.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
        ext = 'png';
        var ps = _pngSize(bytes);
        natW = ps ? ps.width : (im.natW || 0);
        natH = ps ? ps.height : (im.natH || 0);
        b64 = figma.base64Encode(bytes);
        bytes = null;
      } else {
        var img = figma.getImageByHash(im.hash);
        bytes = await img.getBytesAsync();
        ext = _ext(bytes);
        try { var nat = await img.getSizeAsync(); natW = nat.width || 0; natH = nat.height || 0; } catch (es) {}
        b64 = figma.base64Encode(bytes);
        bytes = null;
      }
    } catch (e) { continue; }
    var meta = { name: im.name, ext: ext, x: im.x, y: im.y, w: im.w, h: im.h,
                 cx: im.cx, cy: im.cy, cw: im.cw, ch: im.ch,
                 natW: natW, natH: natH, scaleMode: im.scaleMode,
                 opacity: im.opacity, rotation: im.rotation, matte: im.matte,
                 blend: im.blend || 'NORMAL', path: im.path || null, z: (im.z || 0),
                 hidden: !!im.hidden };   // eye off in Figma -> layer switched off in AE
    var parts = Math.max(1, Math.ceil(b64.length / CHUNK));
    for (var pi = 0; pi < parts; pi++) {
      figma.ui.postMessage({
        type: 'image-chunk', index: q, total: images.length,
        seq: pi, parts: parts, meta: (pi === 0 ? meta : null),
        dataPart: b64.substr(pi * CHUNK, CHUNK)
      });
    }
    b64 = null;
  }
}

// Hidden means hidden — by its own eye icon OR by any parent's. Figma leaves such nodes out
// of the SVG entirely, but text and pictures travel on their own channels, so without this
// check a hidden group's children reappeared in AE.
// Largest blur radius affecting this node — its own or one set on any ancestor group.
// Figma blurs a group as a single surface, so children must inherit it.
function _blurOf(n) {
  var b = 0, p = n, guard = 0;
  while (p && guard++ < 128) {
    try {
      var es = p.effects || [];
      for (var i = 0; i < es.length; i++) {
        var e = es[i];
        if (e.visible === false) continue;
        if ((e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') && (e.radius || 0) > b) b = e.radius || 0;
      }
    } catch (er) {}
    p = p.parent;
  }
  return b;
}

// Opacity multiplies down the tree, so a text inside a 40% group must arrive at 40%.
// Own opacity times every ancestor's, up to and including the exported root — anything above the
// root is not part of this export. In ORGANIZE mode a container's opacity is carried by its
// precomp layer, so folding it in here as well would darken the layer twice.
function _opacityChain(n, organize, rootId) {
  var o = 1, p = n, guard = 0;
  while (p && guard++ < 128) {
    var skip = (organize && p !== n && _isContainer(p));
    if (!skip && typeof p.opacity === 'number') o *= p.opacity;
    if (rootId && p.id === rootId) break;
    p = p.parent;
  }
  return o;
}

function _isHidden(n) {
  var p = n, guard = 0;
  while (p && guard++ < 128) {
    if (p.visible === false) return true;
    p = p.parent;
  }
  return false;
}

// Recursively collect TEXT nodes with everything AE needs to rebuild editable text.
// Figma applies textCase as a DISPLAY transform; node.characters is still the raw text.
// Bake it into the characters we send so AE shows the same (UPPER/LOWER/TITLE).
function _applyCase(str, tc) {
  if (!str || !tc || tc === 'ORIGINAL') return str;
  if (tc === 'UPPER' || tc === 'SMALL_CAPS' || tc === 'SMALL_CAPS_FORCED') return str.toUpperCase();
  if (tc === 'LOWER') return str.toLowerCase();
  if (tc === 'TITLE') return str.replace(/\b([a-z])/g, function (m, c) { return c.toUpperCase(); });
  return str;
}
// Absolute rotation in AE convention (screen-space, clockwise-positive degrees).
// Derived from absoluteTransform so nested/rotated parents are included.
function _rotOf(n) {
  try {
    var m = n.absoluteTransform;
    if (m && m[0] && m[1]) {
      var deg = Math.atan2(m[1][0], m[0][0]) * 180 / Math.PI;
      return (Math.abs(deg) < 0.05) ? 0 : deg;
    }
  } catch (e) {}
  return 0;
}
function _skewOf(n) {
  try {
    var m = n.absoluteTransform;
    if (m && m[0] && m[1]) {
      // Remove ordinary rotation first. For a pure Figma skewX this is atan2(c,d); doing it
      // without the inverse rotation would mistake every rotated text node for an italic one.
      var r = _rotOf(n) * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
      var c = cs * m[0][1] + sn * m[1][1];
      var d = -sn * m[0][1] + cs * m[1][1];
      var deg = Math.atan2(c, d) * 180 / Math.PI;
      return (Math.abs(deg) < 0.05) ? 0 : deg;
    }
  } catch (e) {}
  return 0;
}
// Figma letterSpacing -> AE tracking (AE unit: 1/1000 em). PERCENT: %*10. PIXELS: px/fs*1000.
function _tracking(ls, fontSize) {
  if (!ls || typeof ls.value !== 'number') return 0;
  if (ls.unit === 'PERCENT') return ls.value * 10;
  if (ls.unit === 'PIXELS') return fontSize ? (ls.value / fontSize) * 1000 : 0;
  return 0;
}

function _solidOf(fills) {
  var col = [0, 0, 0], op = 1;
  if (fills && fills !== figma.mixed && fills.length && fills[0].type === 'SOLID') {
    col = [fills[0].color.r, fills[0].color.g, fills[0].color.b];
    if (fills[0].opacity != null) op = fills[0].opacity;
  }
  return { color: col, opacity: op };
}

// Effects living directly on a TEXT node (so AE can attach them to the text layer itself,
// not via bbox-matching which only targets shape layers).
function _textEffects(n) {
  var out = [];
  try {
    var es = n.effects || [];
    for (var i = 0; i < es.length; i++) {
      var e = es[i]; if (e.visible === false) continue;
      if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
        out.push({ kind: (e.type === 'DROP_SHADOW') ? 'drop' : 'inner',
          color: [e.color.r, e.color.g, e.color.b], alpha: (e.color.a != null ? e.color.a : 1),
          dx: (e.offset ? e.offset.x : 0), dy: (e.offset ? e.offset.y : 0), blur: e.radius || 0, spread: e.spread || 0 });
      } else if (e.type === 'LAYER_BLUR') {
        out.push({ kind: 'blur', radius: e.radius || 0 });
      }
    }
  } catch (er) {}
  return out;
}
// Gradient text fill -> data for an AE Gradient Ramp effect. Handles are normalized (0..1)
// to the node box; AE maps them onto the rendered text rect.
function _gradFill(n) {
  try {
    var fills = n.fills;
    if (!fills || fills === figma.mixed || !fills.length) return null;
    // Pick the topmost VISIBLE gradient. Blindly taking the last paint grabbed the wrong one
    // when a node carries several fills (e.g. a solid stacked over the gradient), which is how
    // a vertical gradient came through as a horizontal one.
    var f = null;
    for (var fi = fills.length - 1; fi >= 0; fi--) {
      var cand = fills[fi];
      if (cand.visible === false) continue;
      if (cand.type === 'GRADIENT_LINEAR' || cand.type === 'GRADIENT_RADIAL') { f = cand; break; }
    }
    if (!f) return null;
    if (f.type === 'GRADIENT_LINEAR' || f.type === 'GRADIENT_RADIAL') {
      var stops = [];
      for (var i = 0; i < f.gradientStops.length; i++) {
        var s = f.gradientStops[i];
        stops.push({ offset: s.position, color: [s.color.r, s.color.g, s.color.b], opacity: (s.color.a != null ? s.color.a : 1) });
      }
      // The PLUGIN API describes a gradient with `gradientTransform`, not with
      // `gradientHandlePositions` (that one only exists in the REST API). Reading the missing
      // field silently produced the default left->right handles, which is why every gradient
      // came out horizontal. Invert the matrix instead: the ramp runs (0,0)->(1,0) in gradient
      // space, so the inverse maps those onto the node's normalised box.
      var h = f.gradientHandlePositions || [];
      var h0 = h[0], h1 = h[1];
      if (!h0 || !h1) {
        var gt = f.gradientTransform;
        if (gt && gt[0] && gt[1]) {
          var a = gt[0][0], c = gt[0][1], e = gt[0][2];
          var b = gt[1][0], d = gt[1][1], g2 = gt[1][2];
          var det = a * d - c * b;
          if (det) {
            var inv = function (x, y) {
              var nx = x - e, ny = y - g2;
              return { x: (d * nx - c * ny) / det, y: (-b * nx + a * ny) / det };
            };
            h0 = inv(0, 0.5); h1 = inv(1, 0.5);   // ramp runs left->right on the unit square's mid-line
          }
        }
      }
      if (!h0 || !h1) { h0 = { x: 0, y: 0.5 }; h1 = { x: 1, y: 0.5 }; }
      function abs(hp) {
        var lx = hp.x * n.width, ly = hp.y * n.height;
        try {
          var m = n.absoluteTransform;
          return [m[0][0] * lx + m[0][1] * ly + m[0][2], m[1][0] * lx + m[1][1] * ly + m[1][2]];
        } catch (e) {
          var b = n.absoluteBoundingBox || { x: 0, y: 0 };
          return [b.x + lx, b.y + ly];
        }
      }
      return {
        type: (f.type === 'GRADIENT_RADIAL') ? 'radial' : 'linear', stops: stops,
        p0: abs(h0), p1: abs(h1),                       // absolute; re-based with everything else
        h0: { x: h0.x, y: h0.y }, h1: { x: h1.x, y: h1.y },
        nFills: fills.length, raw: [h0.x, h0.y, h1.x, h1.y]
      };
    }
  } catch (e) {}
  return null;
}

// TIGHT ink bounds of the rendered glyphs (absoluteRenderBounds), relative to root.
// This is what we align to vertically — the layer bbox is the LINE box (with leading), and
// glyphs sit LOW in it, so centring in the line box lifts text ~5px too high.
// Skipped when a bounds-inflating effect (shadow/blur) is present, since it would enlarge the box.
// True when an ancestor frame CLIPS this node (fully or partially). Figma then reports
// absoluteRenderBounds trimmed to the visible part — or null when nothing shows — so it must
// not be used for alignment: that is what moved (or lost) elements hanging off the frame.
function _isClipped(n) {
  try {
    var b = n.absoluteBoundingBox;
    if (!b) return true;
    var p = n.parent, guard = 0;
    while (p && guard++ < 64) {
      if (p.clipsContent === true && p.absoluteBoundingBox) {
        var pb = p.absoluteBoundingBox;
        if (b.x < pb.x - 0.5 || b.y < pb.y - 0.5 ||
            b.x + b.width > pb.x + pb.width + 0.5 ||
            b.y + b.height > pb.y + pb.height + 0.5) return true;
      }
      p = p.parent;
    }
  } catch (e) { return true; }
  return false;
}
function _inkBounds(n, rootBox) {
  try {
    if (_isClipped(n)) return null;            // clipped render bounds would mis-place it
    var es = n.effects || [];
    for (var i = 0; i < es.length; i++) {
      var e = es[i];
      if (e.visible !== false && (e.type === 'DROP_SHADOW' || e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR')) return null;
    }
    var rb = n.absoluteRenderBounds;
    if (rb && typeof rb.y === 'number') return { x: rb.x - rootBox.x, y: rb.y - rootBox.y, w: rb.width, h: rb.height };
  } catch (e) {}
  return null;
}

// Does the text actually RENDER on more than one line? The width guess (chars * size * 0.52)
// undershoots bold uppercase — LEOPARD EFFECT TROUSERS "fit" one line by the guess while Figma
// wrapped it onto two. The ink height is a measurement, not a guess: a single line is about one
// em tall, a wrapped one is at least a line-height more. Rotation inflates the box, so skip it.
function _rendersMultiline(n, fsz) {
  try {
    if (_rotOf(n)) return false;
    var rb = n.absoluteRenderBounds;
    return !!(rb && rb.height > fsz * 1.45);
  } catch (e) { return false; }
}

function collectTexts(root, rootBox, rootId, organize) {
  var out = [];
  function walk(n) {
    if (_ignoreHidden && _isHidden(n)) return;
    if (_rasterByNode[n.id]) return;
    if (_maskSourceByNode[n.id]) return;       // mask contours never become text/art layers
    if (n.type === 'TEXT') {
      var _hid = _isHidden(n);
      try {
        var b = n.absoluteBoundingBox;
        if (b) {
          var x = b.x - rootBox.x, y = b.y - rootBox.y;
          var align = n.textAlignHorizontal || 'LEFT';
          var nodeOp = _opacityChain(n, organize, rootId);   // group opacity stays on the precomp in organize mode

          // rich text: multiple style runs (different colour/size/font per character range)
          var segs = null;
          try { segs = n.getStyledTextSegments(['fontName', 'fontSize', 'fills', 'textCase', 'letterSpacing']); } catch (es) {}

          if (segs && segs.length > 1) {
            var runs = [];
            for (var k = 0; k < segs.length; k++) {
              var sg = segs[k], c = _solidOf(sg.fills);
              var fn = sg.fontName, fam = (fn && fn.family) ? fn.family : 'Arial', sty = (fn && fn.style) ? fn.style : 'Regular';
              var sfs = (typeof sg.fontSize === 'number') ? sg.fontSize : 16;
              runs.push({
                characters: _applyCase(sg.characters, sg.textCase),
                fontSize: sfs,
                family: fam, style: sty, color: c.color, opacity: c.opacity * nodeOp,
                tracking: _tracking(sg.letterSpacing, sfs)
              });
            }
            // Rich text wraps exactly like plain text does — without this flag AE built it as
            // point text and every multi-style paragraph ran off in one endless line.
            var rFixed = (n.textAutoResize && n.textAutoResize !== 'WIDTH_AND_HEIGHT');
            var rChars = n.characters || '';
            var rSize = (typeof n.fontSize === 'number') ? n.fontSize : (runs.length ? runs[0].fontSize : 16);
            var rWraps = /[\n\u2028\u2029]/.test(rChars) || (rChars.length * rSize * 0.52) > (b.width * 1.05) ||
                         _rendersMultiline(n, rSize);
            out.push({ _node: n, runs: true, name: n.name, maskId: _maskByNode[n.id] || null, x: x, y: y, w: b.width, h: b.height, align: align, segs: runs,
                       path: _pathOf(n, rootId), z: _zOf(n), box: !!(rFixed && rWraps), hidden: _hid, blur: _blurOf(n), blend: n.blendMode || 'NORMAL',
                       rotation: _rotOf(n), skewX: _skewOf(n), fx: _textEffects(n), grad: _gradFill(n), ink: _inkBounds(n, rootBox) });
          } else {
            var cc = _solidOf(n.fills);
            var fn2 = n.fontName, fam2 = 'Arial', sty2 = 'Regular';
            if (fn2 && fn2 !== figma.mixed) { fam2 = fn2.family || fam2; sty2 = fn2.style || sty2; }
            var fsz = (typeof n.fontSize === 'number') ? n.fontSize : 16;
            var tc = (n.textCase && n.textCase !== figma.mixed) ? n.textCase : 'ORIGINAL';
            var ls = (n.letterSpacing && n.letterSpacing !== figma.mixed) ? n.letterSpacing : null;
            // Box (wrapping) ONLY when the text actually wraps — an explicit line break, or
            // content wide enough to overflow the fixed width. A fixed-width single line
            // (very common for left-aligned button labels) is placed as reliable point text,
            // which centres correctly instead of slipping on Y.
            var fixedW = (n.textAutoResize && n.textAutoResize !== 'WIDTH_AND_HEIGHT');
            var estW = (n.characters ? n.characters.length : 0) * fsz * 0.52;
            // Real paragraphs overflow the width by a lot; single-line labels don't. Bias hard
            // toward point text (reliable centring) — mis-boxing a single line slips it on Y.
            var wraps = /[\n\u2028\u2029]/.test(n.characters || '') || estW > (b.width * 1.05) ||
                        _rendersMultiline(n, fsz);
            var isBox = fixedW && wraps;
            out.push({
              _node: n, name: n.name, maskId: _maskByNode[n.id] || null, characters: _applyCase(n.characters, tc),
              path: _pathOf(n, rootId), z: _zOf(n),
              x: x, y: y, w: b.width, h: b.height,
              fontSize: fsz, family: fam2, style: sty2,
              color: cc.color, opacity: cc.opacity * nodeOp, align: align, box: !!isBox, hidden: _hid, blur: _blurOf(n),
              blend: n.blendMode || 'NORMAL',
              tracking: _tracking(ls, fsz), rotation: _rotOf(n), skewX: _skewOf(n), fx: _textEffects(n), grad: _gradFill(n), ink: _inkBounds(n, rootBox)
            });
          }
        }
      } catch (e) {}
    }
    // text used as a boolean operand is baked into the boolean's result, not a live layer
    if (n.type !== 'BOOLEAN_OPERATION' && 'children' in n)
      for (var i = 0; i < n.children.length; i++) walk(n.children[i]);
  }
  walk(root);
  return out;
}

figma.ui.onmessage = function (msg) {
  if (msg.type === 'ship-selection') exportSelectionSVG(!!msg.useNodes, !!msg.organize, msg.ignoreHidden !== false, msg.convertMasks === true, msg.rasterGroups !== false);
  if (msg.type === 'close') figma.closePlugin(msg.message || undefined);
  if (msg.type === 'notify') figma.notify(msg.message);
};

// Tell the UI about selection so the button can enable/disable + show a count.
function reportSelection() {
  figma.ui.postMessage({ type: 'selection', count: figma.currentPage.selection.length });
}
figma.on('selectionchange', reportSelection);
reportSelection();
