/*
 * code.js — Figma plugin main thread (sandbox).
 * Exports the current selection as SVG and hands it to the UI iframe,
 * which is the only side allowed to do network (WebSocket to the AE bridge).
 *
 * Main thread can't open sockets, so: export here -> postMessage -> ui.html ships it.
 */

figma.showUI(__html__, { width: 320, height: 630, themeColors: true });


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
  if (n.id === rootId) return [];
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
var _nativeImageMasks = false;
var _directAep = false;
var _independentMasks = {};
var _rasterOptions = {};       // independent permissions for automatic PNG conversion
var _rasterOptionNames = { effects: '模糊、阴影和特殊效果', paints: '特殊填充与描边', imageCrops: '图片裁剪', masks: '复杂蒙版', booleans: '布尔运算结果' };
function _requireRasterOption(n, key, reason) {
  if (_rasterOptions[key]) return;
  throw _layerError(n, (n.isMask ? '蒙版' : '图层') + '「' + n.name + '」' + reason + '，请开启“' + _rasterOptionNames[key] + '”或标记为图片');
}
function _effectName(e) {
  return { DROP_SHADOW: '投影', INNER_SHADOW: '内阴影', LAYER_BLUR: '图层模糊', BACKGROUND_BLUR: '背景模糊', GLASS: '玻璃', NOISE: '噪点', TEXTURE: '纹理', SHADER: '着色器' }[e.type] || e.type;
}
var _rasterTexts = false;       // opt-in: export each remaining text node as a PNG
var _outlineTexts = false;     // opt-in: export text glyphs as filled vector paths
var _rasterScale = 1;
var _rasterRenderScale = 1;
var _bicubicExport = false;
var _rasterOrigin = { x: 0, y: 0 };
var _rasterAllGroups = false;
var _rasterInstances = false;
var _temporaryExportRoot = null;
var _rasterByNode = {};         // rasterised group + descendants: collected by the image route
var _mergeBlends = false;
var _blendMerged = {};
var _blendPaintMerged = {};
var _includeRootContainer = false;
var _maskByNode = {};          // content node id -> mask ROOT id
var _maskSourceByNode = {};    // mask node + all its descendants -> mask ROOT id
var _exporting = false;        // one export at a time: temporary image fills must never overlap
var _subtreeFlagsByNode = null;
var _contentBoundsByNode = null;
var _exportSourceIds = {};      // temporary copy id -> original document node id
var _exportInstanceNodes = {}; // detached frames that originated as instances
function _rememberExportSource(original, copy) {
  _exportSourceIds[copy.id] = original.id;
  if (original.children && copy.children)
    for (var i = 0; i < original.children.length; i++) _rememberExportSource(original.children[i], copy.children[i]);
}
function _layerError(node, message) {
  var error = new Error(message);
  error.nodeId = node.sourceId || _exportSourceIds[node.id] || node.id || null;
  return error;
}
async function locateErrorLayer(id) {
  try {
    var target = await figma.getNodeByIdAsync(id);
    if (!target || target.removed) throw new Error('图层已删除或不存在。');
    var page = target.parent;
    while (page && page.type !== 'PAGE') page = page.parent;
    if (!page) throw new Error('该图层不在画布中。');
    if (page.id !== figma.currentPage.id) await figma.setCurrentPageAsync(page);
    figma.currentPage.selection = [target];
    figma.viewport.scrollAndZoomIntoView([target]);
    figma.ui.postMessage({type:'locate-result',ok:true});
  } catch (error) { figma.ui.postMessage({type:'locate-result',ok:false,message:'定位失败：' + error.message}); }
}
function _isForcedRaster(n) { return !!(n && n.name && n.name.charAt(0) === '*'); }
function _rasterWhole(n) {
  return _isForcedRaster(n) || n.type === 'TEXT_PATH' ||
         (_rasterAllGroups && n.type === 'GROUP' && n !== _temporaryExportRoot) ||
         (_rasterInstances && (n.type === 'INSTANCE' || !!_exportInstanceNodes[n.id]));
}

// Instance descendants cannot override isMask or tree structure. Detach only export
// copies, outermost first, then remap the replacement frame/child IDs to the originals.
function _detachExportInstances(original, copy, includeRaster) {
  if (_rasterWhole(copy) && !includeRaster && !copy.isMask) return copy;
  if (copy.type === 'INSTANCE') {
    try { copy = copy.detachInstance(); }
    catch (error) { throw _layerError(original, '实例「' + original.name + '」分离失败：' + error.message); }
    _rememberExportSource(original, copy);
    _exportInstanceNodes[copy.id] = true;
  }
  var children = copy.children ? copy.children.slice() : [];
  for (var i = 0; i < children.length; i++)
    _detachExportInstances(original.children[i], children[i], includeRaster);
  return copy;
}

function markRasterSelection(mark) {
  if (_exporting) return;
  var selection = figma.currentPage.selection, changed = 0;
  for (var i = 0; i < selection.length; i++) {
    var n = selection[i], name = mark ? (_isForcedRaster(n) ? n.name : '*' + n.name) : n.name.replace(/^\*+/, '');
    if (name !== n.name) { n.name = name; changed++; }
  }
  if (changed) figma.commitUndo();
  figma.ui.postMessage({ type: 'mark-result', message: (mark ? '已标记 ' : '已取消 ') + changed + ' 个图层' });
}

// Document tools are explicit actions on the selection; the export path never invokes them.
function _selectionRoots() {
  var selection = figma.currentPage.selection, ids = {}, roots = [];
  for (var i = 0; i < selection.length; i++) ids[selection[i].id] = true;
  for (i = 0; i < selection.length; i++) {
    var n = selection[i], p = n.parent;
    while (p && !ids[p.id]) p = p.parent;
    if (!p) roots.push(n);
  }
  return roots;
}
function _matrixProduct(a, b) {
  return [
    [a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1], a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2]],
    [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1], a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2]]
  ];
}
function _inverseMatrix(m) {
  var a = m[0][0], b = m[0][1], x = m[0][2], c = m[1][0], d = m[1][1], y = m[1][2];
  var det = a * d - b * c;
  if (!det) throw new Error('无法处理零缩放的图层');
  return [[d / det, -b / det, (b * y - d * x) / det], [-c / det, a / det, (c * x - a * y) / det]];
}
function _groupToFrame(n) {
  var parent = n.parent, index = parent.children.indexOf(n), children = n.children.slice();
  var transform = n.absoluteTransform, inverse = _inverseMatrix(transform), local = [];
  for (var i = 0; i < children.length; i++) local.push(_matrixProduct(inverse, children[i].absoluteTransform));
  var frame = figma.createFrame();
  frame.name = n.name; frame.fills = []; frame.strokes = []; frame.clipsContent = false;
  frame.resize(Math.max(n.width, 0.01), Math.max(n.height, 0.01));
  frame.opacity = n.opacity; frame.blendMode = n.blendMode; frame.effects = n.effects;
  frame.visible = n.visible;
  parent.insertChild(index, frame);
  if (n.layoutAlign != null) frame.layoutAlign = n.layoutAlign;
  if (n.layoutGrow != null) frame.layoutGrow = n.layoutGrow;
  if (n.layoutPositioning != null) frame.layoutPositioning = n.layoutPositioning;
  for (i = 0; i < children.length; i++) {
    frame.appendChild(children[i]); children[i].relativeTransform = local[i];
  }
  var locked = n.locked;
  n.remove();
  // A parent GROUP may move its origin as children are inserted/removed. Resolve against its
  // final transform instead of reusing the old relative coordinates.
  frame.relativeTransform = _matrixProduct(_inverseMatrix(parent.absoluteTransform), transform);
  frame.locked = locked;
  return frame;
}
function _canExpand(n) {
  if ((n.type !== 'FRAME' && n.type !== 'GROUP') || n.isMask || n.clipsContent || !n.visible || n.locked || n.opacity !== 1) return false;
  if (n.blendMode !== 'PASS_THROUGH') return false;
  if ((n.layoutMode && n.layoutMode !== 'NONE') || (n.parent.layoutMode && n.parent.layoutMode !== 'NONE')) return false;
  var lists = [n.fills || [], n.strokes || [], n.effects || []];
  for (var i = 0; i < lists.length; i++) {
    if (lists[i] === figma.mixed) return false;
    for (var j = 0; j < lists[i].length; j++) if (lists[i][j].visible !== false) return false;
  }
  for (i = 0; i < n.children.length; i++) if (n.children[i].isMask) return false;
  for (i = 0; i < n.parent.children.length; i++) if (n.parent.children[i].isMask) return false;
  return true;
}
function runLayerTool(action) {
  if (_exporting) return;
  var roots = _selectionRoots(), count = 0;
  if (!roots.length) return;
  var labels = {detach: '已分离', 'group-to-frame': '已转换', 'delete-hidden': '已清理', expand: '已展开'};
  if (!labels[action]) return;
  _exporting = true; figma.ui.postMessage({ type: 'export-state', busy: true });
  try {
    function detach(n) {
      if (n.type === 'INSTANCE') { n = n.detachInstance(); count++; }
      var children = n.children ? n.children.slice() : [];
      for (var i = 0; i < children.length; i++) detach(children[i]);
      return n;
    }
    function clean(n) {
      if (n.type === 'INSTANCE') return; // Instance children require the explicit detach action.
      var children = n.children ? n.children.slice() : [];
      for (var i = 0; i < children.length; i++) {
        if (children[i].visible === false) { children[i].remove(); count++; }
        else clean(children[i]);
      }
    }
    function expand(n) {
      if (n.type === 'INSTANCE') return;
      var children = n.children ? n.children.slice() : [];
      for (var i = 0; i < children.length; i++) {
        var child = children[i]; expand(child);
        if (!_canExpand(child)) continue;
        var items = child.children.slice(), positions = [];
        for (var j = 0; j < items.length; j++) positions.push(items[j].absoluteTransform);
        var at = n.children.indexOf(child);
        for (j = 0; j < items.length; j++) {
          n.insertChild(at + j, items[j]);
          items[j].relativeTransform = _matrixProduct(_inverseMatrix(n.absoluteTransform), positions[j]);
        }
        child.remove(); count++;
      }
    }
    for (var i = 0; i < roots.length; i++) {
      if (action === 'detach') roots[i] = detach(roots[i]);
      else if (action === 'group-to-frame' && roots[i].type === 'GROUP' && !roots[i].isMask) { roots[i] = _groupToFrame(roots[i]); count++; }
      else if (action === 'delete-hidden') clean(roots[i]);
      else if (action === 'expand') expand(roots[i]);
    }
    figma.currentPage.selection = roots;
    if (count) figma.commitUndo();
    figma.ui.postMessage({ type: 'tool-result', message: labels[action] + ' ' + count + ' 个' + (action === 'detach' ? '实例' : action === 'delete-hidden' ? '隐藏图层' : '分组') });
  } catch (e) {
    figma.ui.postMessage({ type: 'error', message: '整理失败：' + e.message });
  } finally {
    _exporting = false; reportSelection(); figma.ui.postMessage({ type: 'export-state', busy: false });
  }
}
function buildZMap(root) {
  var map = {}, i = 0;
  (function walk(n) {
    map[n.id] = i++;
    if ('children' in n) for (var c = 0; c < n.children.length; c++) walk(n.children[c]);
  })(root);
  return map;
}
function _zOf(n) { return (_zMap && _zMap[n.id] != null) ? _zMap[n.id] : 0; }

// A sibling group keeps its own inner masks without ending the mask outside that group.
function _maskBoundary(n) {
  return n.isMask === true || (_isContainer(n) && n.clipsContent === true);
}
// Blend baking cannot cross an object with its own mask dependencies.
function _blendBoundary(n) {
  return _maskBoundary(n) || (_isContainer(n) &&
    (n.children || []).some(function (c) { return c.visible !== false && c.isMask === true; }));
}
function _maskRuns(n) {
  var runs = [], active = null;
  if (n.type === 'BOOLEAN_OPERATION' || !n.children) return runs;
  for (var i = 0; i < n.children.length; i++) {
    var c = n.children[i];
    if (_ignoreHidden && _isHidden(c)) continue;
    if (_maskBoundary(c)) active = null;
    if (c.isMask === true) { active = { mask: c, members: [c] }; runs.push(active); }
    else if (active) active.members.push(c);
  }
  return runs;
}
function _nativeMaskGeometrySupported(mask) {
  var fills = mask.fills;
  if (_rasterWhole(mask) || (mask.children && mask.type !== 'BOOLEAN_OPERATION') ||
      !mask.fillGeometry || !mask.fillGeometry.length || !fills || fills === figma.mixed ||
      (mask.strokes || []).some(function (p) { return p.visible !== false; }) ||
      (mask.effects || []).some(function (e) { return e.visible !== false; })) return false;
  var visible = fills.filter(function (p) { return p.visible !== false; });
  if (visible.length !== 1 || visible[0].type !== 'SOLID') return false;
  // Vector masks ignore paint alpha. Both writers express ordinary solid alpha/luma masks.
  if (mask.maskType === 'VECTOR' && (visible[0].opacity != null && visible[0].opacity !== 1)) return false;
  return true;
}
function _nativeMaskSupported(run, organize) {
  if (!_nativeMaskGeometrySupported(run.mask)) return false;
  function supported(n) {
    if (_ignoreHidden && _isHidden(n)) return true;
    if (_isContainer(n) && (!organize || (n.effects || []).some(function (e) { return e.visible !== false; }))) return false;
    if (n.type === 'TEXT' && n.fills && n.fills !== figma.mixed && n.fills.some(function (p) { return p.visible !== false && /^GRADIENT_/.test(p.type); })) return false;
    // Image crops and a Figma mask require a combined matte; render only that mask scope.
    if (!_isContainer(n) && n.fills && n.fills !== figma.mixed && n.fills.some(function (p) { return p.visible !== false && p.type === 'IMAGE'; })) return false;
    return n.type === 'BOOLEAN_OPERATION' || !n.children || n.children.every(supported);
  }
  return run.members.slice(1).every(supported);
}

function _containsImage(n) {
  if (_ignoreHidden && _isHidden(n)) return false;
  if (n.fills && n.fills !== figma.mixed && n.fills.some(function (p) { return p.visible !== false && p.type === 'IMAGE'; })) return true;
  return !!(n.children && n.children.some(_containsImage));
}

// Build mask relationships BEFORE collecting any channel. A mask applies to the siblings AFTER
// it (Figma's paint order); it is not artwork of its own. This is the vector equivalent of the
// PSD exporter's mask/base handling, without rasterising the design.
function buildImportMaps(root) {
  _maskByNode = {}; _maskSourceByNode = {};
  if (!_convertMasks) return;
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
      if (_maskBoundary(child)) siblingMask = null;
      var inherited = _includeRootContainer && _isContainer(n) && _maskByNode[n.id] ? null : inheritedMask;
      walk(child, siblingMask || inherited, activeMaskRoot);
      var childIsMask = false;
      try { childIsMask = (child.isMask === true); } catch (ec) {}
      if (!activeMaskRoot && childIsMask) siblingMask = child;
    }
  })(root, null, null);
}

// Only explicit raster boundaries propagate. A child's paint/effect never flattens its parent.
function _subtreeFlags(n) {
  var flags = { marked: false };
  if (!n) return flags;
  if (_subtreeFlagsByNode && _subtreeFlagsByNode[n.id]) return _subtreeFlagsByNode[n.id];
  if (_subtreeFlagsByNode) _subtreeFlagsByNode[n.id] = flags;
  if (_ignoreHidden && _isHidden(n)) return flags;
  flags.marked = _rasterWhole(n) || !!_blendMerged[n.id] || !!_blendPaintMerged[n.id];
  if (n.type !== 'BOOLEAN_OPERATION' && n.children) {
    for (var i = 0; i < n.children.length; i++) {
      var f = _subtreeFlags(n.children[i]);
      flags.marked = flags.marked || f.marked;
    }
  }
  return flags;
}
function _markRaster(n) {
  if (!n) return;
  _rasterByNode[n.id] = true;
  if (n.children) for (var i = 0; i < n.children.length; i++) _markRaster(n.children[i]);
}
function _usesIndependentMask(n) {
  if (!_nativeImageMasks) return false;
  for (var current = n; current; current = current.parent) {
    if (_maskByNode[current.id]) return !!_independentMasks[_maskByNode[current.id]];
  }
  return false;
}
var _imageAdjustmentNames = ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows'];
function _hasImageAdjustments(paint) {
  var filters = paint && paint.filters;
  if (!filters) return false;
  for (var i = 0; i < _imageAdjustmentNames.length; i++) {
    var value = filters[_imageAdjustmentNames[i]];
    if (typeof value === 'number' && isFinite(value) && value !== 0) return true;
  }
  return false;
}
function _singleImageNeedsRaster(n) {
  // Image adjustments live on the paint, not in n.effects. They cannot be reproduced by AE's
  // original-footage route, so bake this leaf even when an independent mask preserves its siblings.
  if (!n || _isContainer(n) || n.type === 'TEXT' || _maskSourceByNode[n.id]) return false;
  var image = false, crop = false, adjusted = false;
  try {
    var paints = n.fills || [];
    for (var i = 0; i < paints.length; i++) {
      var p = paints[i];
      if (p.visible === false || p.type !== 'IMAGE') continue;
      image = true;
      adjusted = adjusted || _hasImageAdjustments(p);
      // AE's centred cover-fit is NOT Figma CROP: imageTransform carries the user's crop/zoom.
      // Export just this leaf as rendered by Figma, retaining its own layer and full-resolution
      // appearance instead of silently discarding that transform.
      if (p.scaleMode === 'CROP' || p.imageTransform) crop = true;
    }
  } catch (e) { return false; }
  if (image && adjusted) {
    _requireRasterOption(n, 'effects', '的图片调色（曝光、对比度等）需要转为图片');
    return true;
  }
  if (_maskByNode[n.id] || _usesIndependentMask(n)) return false;
  if (image && crop) _requireRasterOption(n, 'imageCrops', '的自定义图片裁剪需要固定为 PNG');
  var effect = _rasterOptions.effects && (n.effects || []).some(function (e) { return e.visible !== false; });
  return image && (crop || effect);
}
function _collectRasterCandidates(root, organize) {
  var out = [];
  _rasterByNode = {};
  _independentMasks = {};
  for (var mergedId in _blendMerged) _rasterByNode[mergedId] = true;
  _subtreeFlagsByNode = {};
  function add(n) { out.push({ node: n }); _markRaster(n); }
  function scan(n) {
    if (_ignoreHidden && _isHidden(n)) return;
    if (_rasterByNode[n.id]) return;
    if (_independentMasks[n.id]) return;
    if (_rasterWhole(n)) {
      add(n); return;
    }
    if (_rasterTexts && n.type === 'TEXT') { add(n); return; }
    if (n.type === 'TEXT' && n.hasMissingFont && !_vectorText(n)) throw _layerError(n, '文字「' + n.name + '」缺少字体');
    var paintLists = [n.fills || [], n.strokes || []], unsupportedPaint = [];
    for (var pl = 0; pl < paintLists.length; pl++) if (paintLists[pl] !== figma.mixed) {
      for (var pi = 0; pi < paintLists[pl].length; pi++) {
        var paint = paintLists[pl][pi];
        if (paint.visible !== false && paint.type === 'IMAGE' && !paint.imageHash) throw _layerError(n, '图层「' + n.name + '」的图片素材缺失');
        if (paint.visible !== false && ['SOLID', 'IMAGE', 'GRADIENT_LINEAR', 'GRADIENT_RADIAL'].indexOf(paint.type) === -1)
          unsupportedPaint.push({ GRADIENT_ANGULAR: '角度渐变', GRADIENT_DIAMOND: '菱形渐变', VIDEO: '视频', PATTERN: '图案', SHADER: '着色器' }[paint.type] || paint.type);
      }
    }
    if (unsupportedPaint.length) {
      _requireRasterOption(n, 'paints', '含无法原生转换的' + unsupportedPaint.join('、') + '填充或描边');
      if (!_isContainer(n)) { add(n); return; }
      throw _layerError(n, '图层「' + n.name + '」包含不支持的' + unsupportedPaint.join('、') + '填充或描边，请将该容器标记为图片');
    }
    var visibleEffects = (n.effects || []).filter(function (e) { return e.visible !== false; });
    if (visibleEffects.some(function (e) { return e.type === 'BACKGROUND_BLUR'; })) {
      _requireRasterOption(n, 'effects', '的背景模糊需要转为图片');
      add(n); return;
    }
    if (_directAep && visibleEffects.length) {
      _requireRasterOption(n, 'effects', '的' + visibleEffects.map(_effectName).join('、') + '暂不能原生写入 AEP');
      if (visibleEffects.some(function (e) { return e.type !== 'DROP_SHADOW'; })) { add(n); return; }
    }
    var unknownEffect = visibleEffects.some(function (e) { return ['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR'].indexOf(e.type) === -1; });
    if (unknownEffect) {
      _requireRasterOption(n, 'effects', '含无法原生转换的' + visibleEffects.map(_effectName).join('、') + '效果');
      if (!_isContainer(n)) { add(n); return; }
      throw _layerError(n, '图层「' + n.name + '」包含不支持的' + visibleEffects.map(_effectName).join('、') + '效果，请标记该层栅格化');
    }
    if (n.type === 'BOOLEAN_OPERATION' && !(n.fillGeometry || []).length) {
      _requireRasterOption(n, 'booleans', '未提供布尔运算的结果路径');
      add(n); return;
    }
    if (_rasterOptions.effects) {
      var localEffects = visibleEffects.filter(function (e) { return e.type !== 'DROP_SHADOW'; });
      if (_isContainer(n) && localEffects.length && !organize) throw _layerError(n, '图层「' + n.name + '」的组效果需要启用预合成');
      if (!_isContainer(n) && n.type !== 'TEXT' && localEffects.length) { add(n); return; }
    }
    if (_singleImageNeedsRaster(n)) { add(n); return; }
    if (_convertMasks) {
      var runs = _maskRuns(n);
      for (var mi = 0; mi < runs.length; mi++) {
        var run = runs[mi];
        // A mask without exported siblings contributes no artwork of its own.
        if (run.members.length < 2) { _markRaster(run.mask); continue; }
        if (_nativeImageMasks && run.members.slice(1).some(_containsImage)) {
          _independentMasks[run.mask.id] = run.mask;
          if (!_nativeMaskGeometrySupported(run.mask)) {
            if (!_rasterWhole(run.mask)) _requireRasterOption(run.mask, 'masks', '需要单独渲染为遮罩图片');
            _markRaster(run.mask);
          }
          continue;
        }
        if (_nativeMaskSupported(run, organize)) continue;
        // Choosing merged image masks is itself an explicit request to bake that scope.
        if (!run.members.slice(1).some(_containsImage)) _requireRasterOption(run.mask, 'masks', '无法转换为原生轨道遮罩');
        out.push({ node: n, mask: run.mask, members: run.members });
        for (var mm = 0; mm < run.members.length; mm++) _markRaster(run.members[mm]);
      }
    }
    if (n.type !== 'BOOLEAN_OPERATION' && n.children)
      for (var i = 0; i < n.children.length; i++) scan(n.children[i]);
  }
  scan(root);
  return out;
}

async function _bakeIndependentMasks(root, organize) {
  var images = [];
  for (var id in _independentMasks) {
    var n = _independentMasks[id];
    if (_nativeMaskGeometrySupported(n)) continue;
    var im = _rasterMeta(n, root, organize), wasMask = n.isMask;
    var fills = n.fills, strokes = n.strokes, effects = n.effects, opacity = n.opacity;
    try {
      n.isMask = false;
      if (n.maskType === 'VECTOR') {
        n.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
        n.strokes = []; n.effects = []; n.opacity = 1;
      }
      im.rasterBytes = await _exportRasterPng(im);
    } finally {
      n.isMask = wasMask;
      if (n.maskType === 'VECTOR') { n.fills = fills; n.strokes = strokes; n.effects = effects; n.opacity = opacity; }
    }
    im.maskSource = id; im.maskType = n.maskType || 'ALPHA'; im.maskId = null;
    im.opacity = 1; im.blend = 'NORMAL';
    delete im.rasterNode; delete im.rasterBounds;
    images.push(im);
  }
  return images;
}

// One mask over several siblings must composite their result once. Add a packet-only
// precomp around that scope; nested Figma groups and their own masks stay inside it.
function _nestIndependentMasks(root, organize, channels, containers) {
  if (!_nativeImageMasks) return;
  var scopes = [];
  (function walk(n) {
    if ((_ignoreHidden && _isHidden(n)) || _rasterByNode[n.id] || _maskSourceByNode[n.id]) return;
    var runs = _maskRuns(n);
    for (var i = 0; i < runs.length; i++) {
      var run = runs[i];
      if (!_independentMasks[run.mask.id] || run.members.length < 3) continue;
      if (!organize) throw _layerError(run.mask, '蒙版「' + run.mask.name + '」需要开启“保留分组层级”以建立预合成');
      var ids = {}, left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (var j = 1; j < run.members.length; j++) {
        var member = run.members[j], b = _contentBounds(member);
        ids[member.id] = true;
        left = Math.min(left, b.x); top = Math.min(top, b.y);
        right = Math.max(right, b.x + b.w); bottom = Math.max(bottom, b.y + b.h);
        var render = member.absoluteRenderBounds;
        if (render) {
          left = Math.min(left, render.x); top = Math.min(top, render.y);
          right = Math.max(right, render.x + render.width); bottom = Math.max(bottom, render.y + render.height);
        }
      }
      var container = { id: run.mask.id + '-scope', name: run.mask.name + ' 内容', type: 'GROUP',
        sourceId: _exportSourceIds[run.mask.id] || run.mask.id,
        maskScope: true, maskId: run.mask.id, path: _pathOf(run.mask, root.id), z: _zOf(run.mask),
        x: left, y: top, w: right - left, h: bottom - top,
        cb: { x: left, y: top, w: right - left, h: bottom - top },
        opacity: 1, blend: 'NORMAL', clip: false, hidden: false, blur: 0, fx: [] };
      containers.push(container); scopes.push({ container: container, members: ids });
    }
    if (n.type !== 'BOOLEAN_OPERATION' && n.children) for (var i = 0; i < n.children.length; i++) walk(n.children[i]);
  })(root);
  for (var si = 0; si < scopes.length; si++) {
    var scope = scopes[si], target = scope.container;
    for (var ci = 0; ci < channels.length; ci++) for (var ri = 0; ri < channels[ci].length; ri++) {
      var row = channels[ci][ri];
      if (row === target || row.reference) continue;
      var path = row.path || [], at = -1;
      for (var pi = 0; pi < path.length; pi++) if (scope.members[path[pi]]) { at = pi; break; }
      if (at < 0 && !scope.members[row.id] && row.maskId !== target.maskId) continue;
      row.path = path.slice(); row.path.splice(at < 0 ? path.length : at, 0, target.id);
      if (row.maskId === target.maskId) row.maskId = null;
    }
  }
}

// Shared masks on pass-through artwork belong to each drawing result. Keep the matte
// inside a Normal wrapper and put the drawing's blend/opacity on that wrapper, so
// the blend sees the backdrop outside the masked content instead of transparent pixels.
function _distributeBlendMasks(root, channels, containers) {
  var byId = {}, spread = {}, removed = {}, rows = [], additions = [], serial = 0;
  function passes(c) {
    return c.maskScope || (c.blend === 'PASS_THROUGH' && c.opacity === 1 && !c.clip && !c.blur && !(c.fx && c.fx.length));
  }
  for (var i = 0; i < containers.length; i++) byId[containers[i].id] = containers[i];
  for (i = 0; i < channels.length; i++) rows = rows.concat(channels[i]);
  rows = rows.concat(containers);
  for (i = 0; i < rows.length; i++) {
    var row = rows[i], mode = row.blend || 'NORMAL';
    if (row.reference || row.maskSource || mode === 'NORMAL' || mode === 'PASS_THROUGH') continue;
    for (var p = (row.path || []).length - 1; p >= 0; p--) {
      var c = byId[row.path[p]];
      if (!c || !passes(c)) break;
      if (c.maskId) spread[c.id] = c.maskId;
    }
  }
  if (!Object.keys(spread).length) return;
  for (i = 0; i < containers.length; i++) if (spread[containers[i].id] && containers[i].maskScope) removed[containers[i].id] = true;
  var bounds = _contentBounds(root);
  for (i = 0; i < rows.length; i++) {
    row = rows[i];
    if (row.reference || row.maskSource || removed[row.id]) continue;
    var originalPath = row.path || [], path = [], masks = [];
    for (p = 0; p < originalPath.length; p++) {
      c = byId[originalPath[p]];
      if (c && spread[c.id]) masks.push(spread[c.id]);
      else if (c && !passes(c)) masks = [];
      if (!removed[originalPath[p]]) path.push(originalPath[p]);
    }
    row.path = path;
    // A retained pass-through group carries its mask down to its drawings.
    if (byId[row.id] && passes(row)) { if (spread[row.id]) row.maskId = null; continue; }
    if (!masks.length) continue;
    if (row.maskId && masks.indexOf(row.maskId) === -1) masks.push(row.maskId);
    var blend = row.blend || 'NORMAL', opacity = row.opacity == null ? 1 : row.opacity;
    for (var m = 0; m < masks.length; m++) {
      var id = root.id + '-masked-' + (++serial);
      additions.push({id:id,sourceId:row.sourceId,name:row.name + (m ? ' 蒙版' : ' 内容'),type:'GROUP',
        path:path.slice(),z:row.z,x:bounds.x,y:bounds.y,w:bounds.w,h:bounds.h,
        cb:{x:bounds.x,y:bounds.y,w:bounds.w,h:bounds.h},
        opacity:m ? 1 : opacity,blend:m ? 'NORMAL' : blend,maskId:masks[m],
        clip:false,hidden:!!row.hidden,blur:0,fx:[]});
      path.push(id);
    }
    row.path = path; row.maskId = null; row.blend = 'NORMAL'; row.opacity = 1;
  }
  for (i = containers.length - 1; i >= 0; i--) if (removed[containers[i].id]) containers.splice(i, 1);
  for (i = 0; i < additions.length; i++) containers.push(additions[i]);
}

// Blend pixels depend on the paint below them. Baking only the blend layer still asks AE to
// repeat that operation. Render the smallest closed sibling range instead, on the export copy.
async function _bakeBlendStacks(root, organize) {
  var images = [], paintOwners = [], stats = { merged: 0, layers: 0, external: 0 };
  function mode(n) { return n.blendMode || 'NORMAL'; }
  function mixed(n) { return mode(n) !== 'NORMAL' && mode(n) !== 'PASS_THROUGH'; }
  function paints(n) { return [].concat(n.fills === figma.mixed ? [] : (n.fills || []), n.strokes === figma.mixed ? [] : (n.strokes || [])).filter(function (p) { return p.visible !== false && p.opacity !== 0; }); }
  function paintBlend(n) { return paints(n).some(function (p) { return p.blendMode && p.blendMode !== 'NORMAL'; }); }
  function effects(n) { return (n.effects || []).some(function (e) { return e.visible !== false; }); }
  function hasMask(n) { return n.children && n.children.some(function (c) { return c.visible !== false && c.isMask; }); }
  function masksClose(n, bounds) { return !n.children || n.children.every(function (c) { return _isHidden(c) || !c.isMask || _rasterOpaqueBackdrop(c, bounds, true); }); }
  function opaque(n, bounds) {
    if (_isHidden(n) || n.opacity !== 1 || mixed(n) || effects(n)) return false;
    if (_rasterOpaqueBackdrop(n, bounds)) return true;
    // Boolean operands do not paint independently. An opaque operand cannot prove
    // coverage of the Boolean result (a Subtract may only leave a hollow border).
    if (!_isContainer(n) || !n.children || n.clipsContent) return false;
    var mask = true;
    for (var i = 0; i < n.children.length; i++) {
      var c = n.children[i];
      if (_isHidden(c)) continue;
      if (c.isMask) mask = c.maskType !== 'LUMINANCE' && _rasterOpaqueBackdrop(c, bounds);
      else if (mask && opaque(c, bounds)) return true;
    }
    return false;
  }
  function outsideBlend(n) {
    if (mixed(n)) return true;
    if (mode(n) !== 'PASS_THROUGH') return false;
    if (_isContainer(n) && n.opacity === 1 && !paints(n).length && !effects(n)) {
      var passes = _rasterBlendPasses(n);
      if (passes.length === 1 && !passes[0].atoms) return false;
    }
    return paintBlend(n) || !!(n.children && n.children.some(function (c) { return !_isHidden(c) && outsideBlend(c); }));
  }
  function box(n) { return n.absoluteRenderBounds || n.absoluteBoundingBox; }
  function union(a, b) {
    if (!a) return b;
    if (!b) return a;
    var x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x: x, y: y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
  }
  function overlap(a, b) { return !a || !b || (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height); }
  function mark(n) { _blendMerged[n.id] = true; if (n.children) n.children.forEach(mark); }
  async function fonts(nodes) {
    var loaded = {};
    for (var i = 0; i < nodes.length; i++) if (nodes[i].type === 'TEXT') {
      var segments = nodes[i].getStyledTextSegments(['fontName']);
      for (var j = 0; j < segments.length; j++) {
        var f = segments[j].fontName, key = JSON.stringify(f);
        if (!loaded[key]) { await figma.loadFontAsync(f); loaded[key] = true; }
      }
    }
  }
  async function whole(n) {
    if (n.type === 'TEXT') await fonts([n]);
    var im = _rasterMeta(n, root, organize);
    im.rasterBytes = await _exportRasterPng(im);
    delete im.rasterNode; delete im.rasterBounds;
    im.name += '_叠加合并'; im.mergedBlend = true; images.push(im); mark(n); stats.merged++; stats.layers++;
  }
  async function visit(ctx) {
    if (_isHidden(ctx) || _blendMerged[ctx.id] || _rasterWhole(ctx)) return;
    if (!ctx.children || ctx.type === 'BOOLEAN_OPERATION') {
      // Normal isolates paint blends inside this one node; no siblings need to be absorbed.
      if (paintBlend(ctx) && mode(ctx) !== 'PASS_THROUGH') await whole(ctx);
      return;
    }
    // Masks own their scope; parent effects and opacity remain on the precomp.
    if (hasMask(ctx) || effects(ctx) || ctx.opacity !== 1) {
      for (var vi = 0; vi < ctx.children.length; vi++) await visit(ctx.children[vi]);
      return;
    }
    var atoms = [], ownPaint = paints(ctx).length > 0;
    if (ownPaint) atoms.push({ node: ctx, paint: true, blend: paintBlend(ctx), bounds: box(ctx) });
    function flatten(n) {
      if (_isHidden(n)) return;
      if (_isContainer(n) && mode(n) === 'PASS_THROUGH' && n.opacity === 1 && !paints(n).length && !effects(n) && !hasMask(n) && !n.clipsContent && !_rasterWhole(n)) n.children.forEach(flatten);
      else atoms.push({ node: n, paint: false, blend: outsideBlend(n), bounds: box(n) });
    }
    ctx.children.forEach(flatten);
    var ranges = [], isolated = mode(ctx) !== 'PASS_THROUGH';
    for (var end = 0; end < atoms.length; end++) {
      if (!atoms[end].blend) continue;
      var needed = atoms[end].bounds, start = -1;
      for (var back = end - 1; back >= 0; back--) {
        if (_blendBoundary(atoms[back].node) || _subtreeFlags(atoms[back].node).marked) break;
        if (atoms[back].blend) needed = union(needed, atoms[back].bounds);
        if (masksClose(ctx, needed) && !atoms[back].blend && opaque(atoms[back].node, needed)) { start = back; break; }
      }
      if (start < 0 && isolated) start = 0;
      if (start < 0) continue;
      if (atoms.slice(start, end + 1).some(function (a) { return _blendBoundary(a.node) || _subtreeFlags(a.node).marked || !!_maskByNode[a.node.id]; })) continue;
      while (ranges.length && start <= ranges[ranges.length - 1].end) start = Math.min(start, ranges.pop().start);
      ranges.push({ start: start, end: end });
    }
    if (ranges.length) await fonts(atoms.map(function (a) { return a.node; }));
    for (var ri = 0; ri < ranges.length; ri++) {
      var range = ranges[ri], keep = [], includePaint = false, lifted = [];
      for (var k = range.start; k <= range.end; k++) {
        var atom = atoms[k];
        // Pictures, icons and buttons have the same independence as text.
        if (!atom.paint && !atom.blend && atoms.slice(k + 1, range.end + 1).every(function (a) { return !overlap(atom.bounds, a.bounds); })) { lifted.push(atom.node); continue; }
        if (atom.paint) includePaint = true;
        else keep.push(atom.node);
      }
      var hasFills = 'fills' in ctx, hasStrokes = 'strokes' in ctx;
      var savedFills = hasFills ? ctx.fills : null, savedStrokes = hasStrokes ? ctx.strokes : null;
      var image = _rasterMeta(ctx, root, organize);
      try {
        if (!includePaint) {
          if (hasFills) ctx.fills = [];
          if (hasStrokes) ctx.strokes = [];
        }
        image.rasterPass = { atoms: atoms.filter(function (a) { return !a.paint; }).map(function (a) { return a.node; }), keep: keep, blend: 'NORMAL' };
        image.rasterBytes = await _exportRasterPass(image);
      } finally {
        if (!includePaint) {
          if (hasFills) ctx.fills = savedFills;
          if (hasStrokes) ctx.strokes = savedStrokes;
        }
      }
      image.name = (ctx.name || 'Figma') + '_叠加合并'; image.blend = 'NORMAL'; image.mergedBlend = true;
      image.path = _pathOf(ctx, root.id);
      if (ctx !== root || _includeRootContainer) image.path.push(ctx.id);
      image.z = _zOf(atoms[range.end].node);
      if (!includePaint && keep.length) {
        var common = _pathOf(keep[0], root.id);
        for (var ki = 1; ki < keep.length; ki++) {
          var kp = _pathOf(keep[ki], root.id), same = 0;
          while (same < common.length && same < kp.length && common[same] === kp[same]) same++;
          common = common.slice(0, same);
        }
        image.path = common;
      }
      // A suffix left in the ending pass-through group must remain above the cross-group PNG.
      var parent = atoms[range.end].node.parent;
      while (parent && parent !== ctx && parent !== root && parent.type !== 'PAGE') {
        if (image.path.indexOf(parent.id) !== -1) break;
        _zMap[parent.id] = image.z + 0.2;
        parent = parent.parent;
      }
      for (var lt = 0; lt < lifted.length; lt++) {
        _zMap[lifted[lt].id] = image.z + 0.1 + lt * 0.0001;
        for (var lp = lifted[lt].parent; lp && lp !== root && lp !== ctx && image.path.indexOf(lp.id) === -1; lp = lp.parent) _zMap[lp.id] = image.z + 0.2;
      }
      delete image.rasterNode; delete image.rasterBounds; delete image.rasterPass;
      images.push(image); keep.forEach(mark); stats.merged++; stats.layers += keep.length + (includePaint ? 1 : 0);
      if (includePaint) { paintOwners.push(ctx); _blendPaintMerged[ctx.id] = true; }
    }
    for (var ai = 0; ai < atoms.length; ai++) if (!atoms[ai].paint && !_blendMerged[atoms[ai].node.id]) {
      var child = atoms[ai].node;
      if (mixed(child) || (paintBlend(child) && mode(child) === 'PASS_THROUGH')) stats.external++;
      await visit(child);
    }
  }
  await visit(root);
  if (mixed(root) || (paintBlend(root) && mode(root) === 'PASS_THROUGH')) stats.external++;
  // Clear baked frame paints only after every PNG has rendered against the original copy.
  paintOwners.forEach(function (n) {
    if ('fills' in n) n.fills = [];
    if ('strokes' in n) n.strokes = [];
  });
  return { images: images, stats: stats };
}

// The clean pass removes foreground pixels from the full Figma render.
async function _bakeNodeShadow(n, root, organize) {
  var effects = n.effects || [];
  if (n.type === 'TEXT') {
    var segments = n.getStyledTextSegments(['fontName']);
    for (var f = 0; f < segments.length; f++) await figma.loadFontAsync(segments[f].fontName);
  }
  var image = _rasterMeta(n, root, organize);
  image.rasterBytes = await _exportRasterPng(image);
  var fullBounds = image.rasterBounds;
  n.effects = effects.filter(function (e) { return e.type !== 'DROP_SHADOW' || e.visible === false; });
  var cleanImage = _rasterMeta(n, root, organize);
  var clean = await _exportRasterPng(cleanImage), cleanBounds = cleanImage.rasterBounds;
  image.shadowBase = { data: figma.base64Encode(clean), dx: (cleanBounds.x - fullBounds.x) * _rasterRenderScale,
    dy: (cleanBounds.y - fullBounds.y) * _rasterRenderScale, w: cleanBounds.width * _rasterRenderScale, h: cleanBounds.height * _rasterRenderScale };
  image.name += '_投影'; image.blend = 'NORMAL'; image.z -= 0.01; image.shadow = true;
  image.external = n === root; delete image.rasterNode; delete image.rasterBounds;
  return image;
}

// Bake drop shadows separately where editable text prevents a whole-group PNG.
async function _bakeEditableShadows(root, organize) {
  var images = [];
  async function walk(n) {
    if (_rasterByNode[n.id] || _isHidden(n)) return;
    if ((n.effects || []).some(function (e) { return e.type === 'DROP_SHADOW' && e.visible !== false; })) images.push(await _bakeNodeShadow(n, root, organize));
    if (n.type !== 'BOOLEAN_OPERATION' && n.children)
      for (var c = 0; c < n.children.length; c++) await walk(n.children[c]);
  }
  await walk(root);
  return images;
}

// Metadata for one rasterised node. Explicitly marked groups include their text in the PNG.
function _rasterMeta(n, root, organize) {
  // PNG export includes the node's shadows/blurs. Use the same render bounds so fitting the
  // footage does not shrink the artwork back into the smaller geometry box (or cut the glow).
  var b = n.absoluteRenderBounds || n.absoluteBoundingBox || { x: 0, y: 0, width: 1, height: 1 };
  var opacity = _opacityChain(n, organize, root.id);
  // The PNG already includes the exported node's opacity; only unbaked ancestors belong in AE.
  if (typeof n.opacity === 'number' && n.opacity > 0) opacity /= n.opacity;
  return {
    rasterNode: n,
    sourceId: _exportSourceIds[n.id] || n.id,
    rasterBounds: b,
    name: (n.name || 'figma-group').replace(/[^A-Za-z0-9_\-\u4e00-\u9fa5]+/g, '_'),
    x: b.x, y: b.y, w: b.width, h: b.height,
    cx: b.x + b.width / 2, cy: b.y + b.height / 2, cw: b.width, ch: b.height,
    natW: Math.max(1, Math.round(b.width * _rasterScale)), natH: Math.max(1, Math.round(b.height * _rasterScale)),
    scaleMode: 'FIT', rasterScale: _rasterScale, opacity: opacity,
    hidden: false, blend: n.blendMode || 'NORMAL',
    // exportAsync already bakes the absolute transform into the PNG's axis-aligned bounds.
    path: _pathOf(n, root.id), z: _zOf(n), rotation: 0, matte: null, maskId: _maskByNode[n.id] || null
  };
}

// A solid backdrop closes the blend stack inside this raster group. Keep that stack in
// Figma: exporting every burn/soft-light layer and blending again in AE changes its colour.
function _rasterOpaqueBackdrop(n, bounds, maskBounds) {
  if (!n || !bounds || (n.type !== 'RECTANGLE' && n.type !== 'FRAME')) return false;
  if (maskBounds && n.maskType === 'LUMINANCE') return false;
  if (typeof n.opacity === 'number' && n.opacity !== 1) return false;
  var fills = n.fills, opaque = false;
  if (!fills || fills === figma.mixed) return false;
  for (var i = 0; i < fills.length; i++) {
    var p = fills[i];
    if (p.visible === false || (p.opacity != null && p.opacity !== 1)) continue;
    if (p.blendMode && p.blendMode !== 'NORMAL') continue;
    if (p.type === 'SOLID') opaque = true;
    else if (/^GRADIENT_/.test(p.type) && p.gradientStops && p.gradientStops.length) {
      var full = true;
      for (var s = 0; s < p.gradientStops.length; s++)
        if (p.gradientStops[s].color.a != null && p.gradientStops[s].color.a !== 1) full = false;
      if (full) opaque = true;
    }
  }
  if (!opaque || !n.absoluteTransform) return false;
  var m = n.absoluteTransform, det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  if (!det) return false;
  var corners = [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y],
                 [bounds.x, bounds.y + bounds.height], [bounds.x + bounds.width, bounds.y + bounds.height]];
  var radii = [n.topLeftRadius, n.topRightRadius, n.bottomLeftRadius, n.bottomRightRadius];
  for (i = 0; i < corners.length; i++) {
    var dx = corners[i][0] - m[0][2], dy = corners[i][1] - m[1][2];
    var x = (m[1][1] * dx - m[0][1] * dy) / det, y = (-m[1][0] * dx + m[0][0] * dy) / det;
    if (x < -0.0001 || y < -0.0001 || x > n.width + 0.0001 || y > n.height + 0.0001) return false;
    var right = x > n.width / 2, bottom = y > n.height / 2;
    var r = maskBounds ? 0 : (typeof n.cornerRadius === 'number' ? n.cornerRadius : (radii[(bottom ? 2 : 0) + (right ? 1 : 0)] || 0));
    r = Math.min(r, n.width / 2, n.height / 2);
    var cx = right ? n.width - r : r, cy = bottom ? n.height - r : r;
    if (Math.abs(x - (right ? n.width : 0)) < r && Math.abs(y - (bottom ? n.height : 0)) < r &&
        (x - cx) * (x - cx) + (y - cy) * (y - cy) > r * r + 0.0001) return false;
  }
  return true;
}

// Transparent pass-through groups still need the AE backdrop. Keep their blended PNGs
// separate, retaining paint order and the Figma masks around each render pass.
function _rasterBlendPasses(root, members) {
  function hasPaintOrEffect(n) {
    var fills = n.fills, strokes = n.strokes, fx = n.effects || [], i;
    if (fills && fills !== figma.mixed) for (i = 0; i < fills.length; i++) if (fills[i].visible !== false) return true;
    if (strokes && strokes !== figma.mixed) for (i = 0; i < strokes.length; i++) if (strokes[i].visible !== false) return true;
    for (i = 0; i < fx.length; i++) if (fx[i].visible !== false) return true;
    return typeof n.opacity === 'number' && n.opacity !== 1;
  }
  if (!members && (!_isContainer(root) || root.blendMode !== 'PASS_THROUGH' || hasPaintOrEffect(root))) return [{}];
  var atoms = [], anyBlend = false, bounds = root.absoluteRenderBounds || root.absoluteBoundingBox;
  function children(n, canClose) {
    var maskAllowsBackdrop = true;
    var list = n === root && members ? members : n.children;
    for (var i = 0; i < list.length; i++) {
      var child = list[i];
      if (_isHidden(child)) continue;
      if (child.isMask === true) maskAllowsBackdrop = _rasterOpaqueBackdrop(child, bounds, true);
      else walk(child, canClose && maskAllowsBackdrop);
    }
  }
  function walk(n, canClose) {
    if (_isHidden(n) || n.isMask === true) return;
    var blend = n.blendMode || 'NORMAL';
    if (blend !== 'NORMAL' && blend !== 'PASS_THROUGH') {
      atoms.push({ node: n, blend: blend }); anyBlend = true; return;
    }
    if (_isContainer(n) && blend === 'PASS_THROUGH' && !hasPaintOrEffect(n)) {
      children(n, canClose);
    } else atoms.push({ node: n, blend: 'NORMAL', canClose: canClose });
  }
  children(root, true);
  if (!anyBlend) return [{}];
  // Only a backdrop BEFORE the first blend makes the group self-contained. In particular,
  // the redemption rows' transparent glows must keep using the external AE background.
  for (var i = 0; i < atoms.length && atoms[i].blend === 'NORMAL'; i++)
    if (atoms[i].canClose && _rasterOpaqueBackdrop(atoms[i].node, bounds)) return [{}];
  var all = [], passes = [], normal = [];
  for (i = 0; i < atoms.length; i++) all.push(atoms[i].node);
  function flush() { if (normal.length) { passes.push({ atoms: all, keep: normal, blend: 'NORMAL' }); normal = []; } }
  for (i = 0; i < atoms.length; i++) {
    if (atoms[i].blend === 'NORMAL') normal.push(atoms[i].node);
    else { flush(); passes.push({ atoms: all, keep: [atoms[i].node], blend: atoms[i].blend }); }
  }
  flush();
  return passes;
}

function _updateRasterBounds(im, bounds) {
  var b = bounds || im.rasterNode.absoluteRenderBounds || im.rasterNode.absoluteBoundingBox;
  if (!b) return;
  im.x += b.x - im.rasterBounds.x; im.y += b.y - im.rasterBounds.y;
  im.w = im.cw = b.width; im.h = im.ch = b.height;
  im.cx = im.x + b.width / 2; im.cy = im.y + b.height / 2;
  // The next measurement is relative to this crop, not the original one. Preserve the
  // scene-relative offset in im.x/y without accumulating the same crop delta twice.
  im.rasterBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
}

// Render into a pixel-aligned canvas instead of letting Figma independently round the
// tight PNG width/height. Keep fractional artwork inside transparent padding, so AE
// can use the original pixel scale without stretching or filtering the tight crop again.
async function _exportRasterPng(im) {
  var n = im.rasterNode, b = n.absoluteRenderBounds || n.absoluteBoundingBox;
  var left = _rasterOrigin.x + Math.floor((b.x - _rasterOrigin.x) * _rasterScale + 0.000001) / _rasterScale;
  var top = _rasterOrigin.y + Math.floor((b.y - _rasterOrigin.y) * _rasterScale + 0.000001) / _rasterScale;
  var width = Math.max(1, Math.ceil((b.x + b.width - left) * _rasterScale - 0.000001)) / _rasterScale;
  var height = Math.max(1, Math.ceil((b.y + b.height - top) * _rasterScale - 0.000001)) / _rasterScale;
  if (Math.abs(left - b.x) < 0.000001 && Math.abs(top - b.y) < 0.000001 &&
      Math.abs(width - b.width) < 0.000001 && Math.abs(height - b.height) < 0.000001)
    return n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: _rasterRenderScale } });
  var frame = figma.createFrame();
  try {
    frame.name = 'F2A 切图'; frame.fills = []; frame.clipsContent = true;
    frame.resizeWithoutConstraints(width, height); frame.x = left; frame.y = top;
    var transform = n.absoluteTransform.map(function (row) { return row.slice(); });
    var size = { width: n.width, height: n.height };
    var copy = n.clone(); frame.appendChild(copy);
    if ((copy.width !== size.width || copy.height !== size.height) && typeof copy.resizeWithoutConstraints === 'function')
      copy.resizeWithoutConstraints(size.width, size.height);
    copy.relativeTransform = _matrixProduct(_inverseMatrix(frame.absoluteTransform), transform);
    var bytes = await frame.exportAsync({ format: 'PNG', useAbsoluteBounds: true,
      constraint: { type: 'SCALE', value: _rasterRenderScale } });
    _updateRasterBounds(im, { x: left, y: top, width: width, height: height });
    return bytes;
  } finally { frame.remove(); }
}

async function _exportRasterPass(im) {
  var pass = im.rasterPass;
  if (!pass) {
    // Root clipping may have been disabled after metadata collection. Measure the same bounds
    // the PNG now uses, so partially clipped text is not squeezed into its earlier visible box.
    _updateRasterBounds(im);
    return _exportRasterPng(im);
  }
  var restored = [], parentState = [], target = (pass.blend !== 'NORMAL') ? pass.keep[0] : null;
  var oldBlend = target ? target.blendMode : null;
  try {
    if (pass.mask) {
      var parent = im.rasterNode;
      for (var si = 0, keys = ['fills', 'strokes', 'effects', 'opacity', 'blendMode']; si < keys.length; si++) {
        var key = keys[si];
        if (!(key in parent)) continue;
        parentState.push({ key: key, value: parent[key] });
        parent[key] = key === 'opacity' ? 1 : key === 'blendMode' ? 'PASS_THROUGH' : [];
      }
    }
    for (var i = 0; i < pass.atoms.length; i++) {
      var atom = pass.atoms[i];
      if (pass.keep.indexOf(atom) !== -1) continue;
      // Visibility removes an item from auto layout and moves the retained artwork.
      // Suppress its paint while keeping its original place and size in the layout.
      restored.push({ node: atom, opacity: atom.opacity, mask: atom.isMask }); atom.opacity = 0;
      if (pass.mask && atom.isMask === true) atom.isMask = false;
    }
    if (target) target.blendMode = 'NORMAL';
    // Suppressing other artwork can shrink the render bounds. Carry the resulting crop back
    // into the already frame-relative metadata, so separate glow layers do not move.
    _updateRasterBounds(im);
    return await _exportRasterPng(im);
  } finally {
    if (target) target.blendMode = oldBlend;
    for (var j = restored.length - 1; j >= 0; j--) {
      restored[j].node.opacity = restored[j].opacity;
      if (pass.mask && restored[j].mask === true) restored[j].node.isMask = true;
    }
    for (var ps = 0; ps < parentState.length; ps++) im.rasterNode[parentState[ps].key] = parentState[ps].value;
  }
}

// Union of a container and EVERYTHING inside it. A group's own box already covers its children,
// but a FRAME's does not — a list that overflows its card sticks out, and sizing the precomp to
// the frame chopped exactly that overflow off, which made such a group impossible to animate.
function _contentBounds(n) {
  if (_contentBoundsByNode && _contentBoundsByNode[n.id]) {
    var cached = _contentBoundsByNode[n.id];
    return { x: cached.x, y: cached.y, w: cached.w, h: cached.h };
  }
  var b = n.absoluteBoundingBox;
  if (!b) return null;
  var minx = b.x, miny = b.y, maxx = b.x + b.width, maxy = b.y + b.height;
  var render = n.absoluteRenderBounds;
  if (render) {
    minx = Math.min(minx, render.x); miny = Math.min(miny, render.y);
    maxx = Math.max(maxx, render.x + render.width); maxy = Math.max(maxy, render.y + render.height);
  }
  if (!_rasterByNode[n.id] && n.type !== 'BOOLEAN_OPERATION' && n.clipsContent !== true && n.children) {
    for (var i = 0; i < n.children.length; i++) {
      var c = n.children[i];
      if (_ignoreHidden && _isHidden(c)) continue;       // hidden art must not inflate precomps
      if (_maskSourceByNode[c.id]) continue;             // mask geometry is not visible content
      try {
        var cb = _contentBounds(c);
        if (cb) {
          if (cb.x < minx) minx = cb.x;
          if (cb.y < miny) miny = cb.y;
          if (cb.x + cb.w > maxx) maxx = cb.x + cb.w;
          if (cb.y + cb.h > maxy) maxy = cb.y + cb.h;
        }
      } catch (e) {}
    }
  }
  var result = { x: minx, y: miny, w: Math.max(1, maxx - minx), h: Math.max(1, maxy - miny) };
  if (_contentBoundsByNode) _contentBoundsByNode[n.id] = result;
  return { x: result.x, y: result.y, w: result.w, h: result.h };
}

function _isPureTextContainer(n) {
  if (_maskByNode[n.id]) return false;
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
    // Normal text-only wrappers must still isolate their blended descendants.
    if (m !== n && n.blendMode === 'NORMAL' && m.blendMode && m.blendMode !== 'NORMAL' && m.blendMode !== 'PASS_THROUGH') hasPaint = true;
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
          id: n.id, sourceId: _exportSourceIds[n.id] || n.id, name: n.name || 'Group', type: n.type,
          maskId: _maskByNode[n.id] || null,
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

// Only retained blend layers need a pass-through chain. A normal/effect/matte boundary
// composites its children locally, so the dependency stops there.
function _markBlendPassThrough(containers, channels) {
  var byId = {}, i;
  for (i = 0; i < containers.length; i++) { byId[containers[i].id] = containers[i]; containers[i].collapseForBlends = false; }
  var rows = containers.slice();
  for (i = 0; i < channels.length; i++) rows = rows.concat(channels[i]);
  for (i = 0; i < rows.length; i++) {
    var row = rows[i], blend = row.blend || 'NORMAL';
    if (row.reference || row.maskSource || blend === 'NORMAL' || blend === 'PASS_THROUGH') continue;
    var path = row.path || [];
    for (var p = path.length - 1; p >= 0; p--) {
      var c = byId[path[p]];
      if (!c) continue;
      if (c.blend !== 'PASS_THROUGH' || c.clip || c.maskScope || c.maskId || c.blur || (c.fx && c.fx.length) || c.opacity < 1) break;
      c.collapseForBlends = true;
    }
  }
}

function _disableExportClipping(root, changed) {
  function disable(n) {
    if (n.clipsContent !== true) return;
    changed.push(n); n.clipsContent = false;
  }
  (function walk(n) {
    disable(n);
    if (n.children) for (var i = 0; i < n.children.length; i++) walk(n.children[i]);
  })(root);
  for (var p = root.parent; p && p.type !== 'PAGE'; p = p.parent) disable(p);
}

async function exportSelectionSVG(useNodes, organize, ignoreHidden, convertMasks, rasterGroups, rasterTexts, options) {
  if (_exporting || mcpBusy) {
    figma.ui.postMessage({ type: 'error', message: '上一次导出仍在进行，请稍候。' });
    return;
  }
  _ignoreHidden = (ignoreHidden !== false);       // default: hidden Figma layers stay out of AE
  _rasterTexts = (rasterTexts === true);
  options = options || {};
  _outlineTexts = options.outlineTexts === true;
  _directAep = options.target === 'aep';
  _nativeImageMasks = options.nativeImageMasks === true;
  // Keep the legacy API argument as the default for callers without per-category settings.
  var rasterDefaults = rasterGroups !== false, rasterOptions = options.rasterize || {};
  _rasterOptions = {};
  for (var rasterKey in _rasterOptionNames) _rasterOptions[rasterKey] = rasterOptions[rasterKey] == null ?
    (rasterDefaults || (rasterKey === 'masks' && _nativeImageMasks)) : rasterOptions[rasterKey] === true;
  _convertMasks = convertMasks === true || rasterDefaults || _nativeImageMasks || _rasterOptions.masks;
  _rasterScale = options.rasterScale == null ? 1 : Number(options.rasterScale);
  _bicubicExport = options.bicubicExport === true;
  _rasterRenderScale = _rasterScale * (_bicubicExport ? 2 : 1);
  _mergeBlends = options.mergeBlends === true;
  _blendMerged = {};
  _blendPaintMerged = {};
  _rasterAllGroups = options.rasterAllGroups === true;
  _rasterInstances = options.rasterInstances === true;
  _includeRootContainer = !!organize && !!useNodes;
  var sel = figma.currentPage.selection;
  if (!sel || sel.length === 0) {
    figma.ui.postMessage({ type: 'error', message: '请至少选择一个图层或画框。' });
    return;
  }
  _exporting = true;
  _exportSourceIds = {};
  _exportInstanceNodes = {};
  _contentBoundsByNode = {};
  figma.ui.postMessage({ type: 'export-state', busy: true });

  var originals = sel.slice(), node, name, workspace = null, references = [];
  var restore = [];   // [textNode, originalOpacity] to undo the hide after export
  var clipWasOn = false;
  var restoreFills = [];   // [imageNode, originalFills] — undone after the export
  var rasterHidden = [];
  var disabledClips = [];
  try {
    if ([1, 2, 3, 4].indexOf(_rasterScale) === -1) throw new Error('请选择有效的切图倍率');
    _rasterOrigin = {
      x: Math.min.apply(null, sel.map(function (n) { return n.absoluteBoundingBox.x; })),
      y: Math.min.apply(null, sel.map(function (n) { return n.absoluteBoundingBox.y; }))
    };
    // Capture the untouched selection before creating or changing any temporary node.
    // Multi-selection keeps one complete reference for each selected frame/group.
    var transforms = [], sizes = [];
    for (var ri = 0; ri < originals.length; ri++) {
      var original = originals[ri];
      transforms.push(original.absoluteTransform.map(function (row) { return row.slice(); }));
      sizes.push({ width: original.width, height: original.height });
      var reference = _rasterMeta(original, original, false);
      try { reference.rasterBytes = await original.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: _rasterRenderScale } }); }
      catch (referenceError) { throw _layerError(original, '图层「' + original.name + '」原图导出失败：' + referenceError.message); }
      delete reference.rasterNode; delete reference.rasterBounds;
      reference.name += '_原图对照'; reference.reference = true; reference.hidden = true;
      reference.opacity = 1; reference.blend = 'NORMAL'; reference.path = [];
      references.push(reference);
    }
    // A page-level frame keeps clipping changes away from the original ancestors.
    // Clone/reparent synchronously, then restore the original absolute transform.
    workspace = figma.createFrame();
    workspace.name = 'F2A 临时导出'; workspace.fills = []; workspace.clipsContent = false;
    workspace.x = 0; workspace.y = 0;
    var copies = [];
    for (var ci0 = 0; ci0 < originals.length; ci0++) {
      var copy = originals[ci0].clone();
      try {
        workspace.appendChild(copy);
        _rememberExportSource(originals[ci0], copy);
        if ((copy.width !== sizes[ci0].width || copy.height !== sizes[ci0].height) && typeof copy.resizeWithoutConstraints === 'function')
          copy.resizeWithoutConstraints(sizes[ci0].width, sizes[ci0].height);
        copy.relativeTransform = _matrixProduct(_inverseMatrix(workspace.absoluteTransform), transforms[ci0]);
        copy = _detachExportInstances(originals[ci0], copy, options.enableClip === false);
      } catch (cloneError) { if (!copy.removed) copy.remove(); throw cloneError; }
      copies.push(copy);
    }
    name = originals.length === 1 ? originals[0].name : 'Selection (' + originals.length + ')';
    node = copies.length === 1 ? copies[0] : figma.group(copies, workspace);
    if (copies.length > 1) { node.name = 'f2a Export'; _temporaryExportRoot = node; }
    if (options.enableClip === false) _disableExportClipping(node, disabledClips);
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
    // A fully rasterized selection needs no SVG, including a directly selected text node.
    if (_rasterWhole(node) || (_rasterTexts && node.type === 'TEXT')) useNodes = true;
    _zMap = buildZMap(node);
    if (node.isMask === true) throw _layerError(node, '蒙版「' + node.name + '」缺少作用内容，请选择其所在分组');
    buildImportMaps(node);
    if (!useNodes && Object.keys(_maskSourceByNode).length) {
      useNodes = true; _includeRootContainer = !!organize; buildImportMaps(node);
    }
    _subtreeFlagsByNode = {};
    var blendBake = _mergeBlends ? await _bakeBlendStacks(node, !!organize) : { images: [], stats: null };
    var rasterCandidates = _collectRasterCandidates(node, !!organize);
    var shadowImages = _rasterOptions.effects ? await _bakeEditableShadows(node, !!organize) : [];
    if (shadowImages.length) rasterCandidates = _collectRasterCandidates(node, !!organize);
    var maskImages = await _bakeIndependentMasks(node, !!organize);
    var nodeShapes = useNodes ? collectShapes(node, !!organize) : null;
    var containers = organize ? collectContainers(node) : null;
    var texts = collectTexts(node, { x: 0, y: 0 }, node.id, !!organize, !!useNodes);
    var effects = collectEffects(node, { x: 0, y: 0 });
    var images = await collectImages(node, node.id, !!organize);
    images = images.concat(blendBake.images, shadowImages, maskImages);
    for (var rci = 0; rci < rasterCandidates.length; rci++) {
      var candidate = rasterCandidates[rci], rn = candidate.node;
      var passes = _rasterWhole(rn) ? [{}] : _rasterBlendPasses(rn, candidate.members);
      for (var rpi = 0; rpi < passes.length; rpi++) {
        var rim = _rasterMeta(rn, node, !!organize), pass = passes[rpi];
        if (pass.atoms) {
          rim.rasterPass = pass;
          rim.name = (rpi === 0 ? rn.name : pass.keep[0].name).replace(/[^A-Za-z0-9_\-\u4e00-\u9fa5]+/g, '_');
          rim.z = _zOf(pass.keep[0]);
          rim.blend = pass.blend;
        }
        if (candidate.members) {
          var outside = rn.children.filter(function (c) { return candidate.members.indexOf(c) === -1; });
          rim.rasterPass = { atoms: outside.concat(pass.atoms || candidate.members.slice(1)),
            keep: pass.keep || candidate.members.slice(1), blend: pass.blend || 'NORMAL', mask: candidate.mask };
          rim.name = candidate.mask.name + '_蒙版';
          rim.path = _pathOf(rn, node.id);
          if (rn !== node || _includeRootContainer) rim.path.push(rn.id);
          rim.opacity = organize ? 1 : _opacityChain(rn, false, node.id);
          rim.blend = pass.blend || 'NORMAL'; rim.maskId = null;
          rim.z = _zOf(pass.keep ? pass.keep[pass.keep.length - 1] : candidate.members[candidate.members.length - 1]);
        }
        images.push(rim);
      }
    }
    _nestIndependentMasks(node, !!organize, [nodeShapes || [], texts, images, containers || []], containers);
    if (containers) _distributeBlendMasks(node, [nodeShapes || [], texts, images], containers);
    if (containers) _markBlendPassThrough(containers, [nodeShapes || [], texts, images]);

    // Disable clipping only AFTER the container table has captured it. The root is exported
    // uncut so off-frame artwork survives, then collectContainers restores that boundary as an
    // AE mask on the root precomp. Child clipping was never disabled.
    if (node.clipsContent === true && !_rasterByNode[node.id]) {
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
    for (var tf = 0; !useNodes && tf < texts.length; tf++) {
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
    if (fontWaits.length) await Promise.all(fontWaits);

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
      if (inod && !useNodes) {
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
    if (!useNodes) try {
      (function suppressMerged(n) {
        if (_blendMerged[n.id]) { restore.push([n, n.opacity]); n.opacity = 0; return; }
        if (n.children) n.children.forEach(suppressMerged);
      })(node);
      // Raster candidates arrive through the image channel. Keep them out of legacy SVG too.
      for (var rh = 0; rh < rasterCandidates.length; rh++) {
        var hiddenMembers = rasterCandidates[rh].members || [rasterCandidates[rh].node];
        for (var hm = 0; hm < hiddenMembers.length; hm++) {
          var rnHide = hiddenMembers[hm];
          rasterHidden.push([rnHide, rnHide.visible]); rnHide.visible = false;
        }
      }
      var bytes = await node.exportAsync({ format: 'SVG', svgIdAttribute: true });   // keeps Figma layer names
      // Uint8Array -> string, chunked (fromCharCode.apply caps at ~65534 args).
      var CHUNK = 8192;
      for (var i = 0; i < bytes.length; i += CHUNK) {
        svg += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
      }
    } catch (exp) { svg = ''; }
    finally {
      for (var rv = 0; rv < rasterHidden.length; rv++) rasterHidden[rv][0].visible = rasterHidden[rv][1];
      rasterHidden = [];
    }

    // Node mode already has all geometry and paints. A header preserves the bridge contract
    // without rendering, copying, transmitting and parsing a second copy of the whole design.
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
    var grew = !useNodes && !(bbox.width && Math.abs(vw - bbox.width) < 1.5 && Math.abs(vh - bbox.height) < 1.5);

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
        var parts = [nsh].concat(nsh.outlinedStrokes || []);
        for (var np = 0; np < parts.length; np++) {
          var part = parts[np];
          // Regions can share a matrix/paint object. Rebase independent copies once.
          part.matrix = part.matrix.slice(); part.matrix[4] -= origin.x; part.matrix[5] -= origin.y;
          var lists = ['fills', 'strokes'];
          for (var li = 0; li < lists.length; li++) {
            part[lists[li]] = (part[lists[li]] || []).map(function (paint) {
              if (!paint.p0) return paint;
              var shifted = {}; for (var key in paint) shifted[key] = paint[key];
              shifted.p0 = [paint.p0[0] - origin.x, paint.p0[1] - origin.y];
              shifted.p1 = [paint.p1[0] - origin.x, paint.p1[1] - origin.y];
              return shifted;
            });
          }
        }
      }
    }
    shiftToOrigin(texts, effects, origin);
    images = images.concat(references);
    for (var im = 0; im < images.length; im++) {
      images[im].x -= origin.x; images[im].y -= origin.y;
      images[im].cx -= origin.x; images[im].cy -= origin.y;
      if (images[im].imageMatrix) { images[im].imageMatrix[4] -= origin.x; images[im].imageMatrix[5] -= origin.y; }
    }

    // containers are frame-relative too, so the precomps line up with everything else
    if (containers) for (var ci = 0; ci < containers.length; ci++) {
      containers[ci].x -= origin.x; containers[ci].y -= origin.y;
      if (containers[ci].cb) { containers[ci].cb.x -= origin.x; containers[ci].cb.y -= origin.y; }

    }

    figma.ui.postMessage({ type: 'ship', name: name, svg: svg, texts: texts, effects: effects,
                           frame: { width: bbox.width, height: bbox.height },
                           shift: svgShift, nodes: nodeShapes, nodeOrigin: origin, bytes: svg.length,
                           containers: containers, organize: !!organize, imageCount: images.length, imageBatch: true,
                           vnStats: _vnStats, blendStats: blendBake.stats });
    await shipImages(images);      // sequential, chunked — see shipImages for why
    if (images.length) figma.ui.postMessage({ type: 'images-done' });
  } catch (e) {
    figma.ui.postMessage({ type: 'error', message: '导出失败：' + (e && e.message ? e.message : e), nodeId: e && e.nodeId || null });
  } finally {
    for (var rv2 = 0; rv2 < rasterHidden.length; rv2++) { try { rasterHidden[rv2][0].visible = rasterHidden[rv2][1]; } catch (erv) {} }
    for (var rr = 0; rr < restore.length; rr++) { try { restore[rr][0].opacity = restore[rr][1]; } catch (er) {} }
    for (var rf = 0; rf < restoreFills.length; rf++) { try { restoreFills[rf][0].fills = restoreFills[rf][1]; } catch (erf) {} }
    if (clipWasOn) { try { node.clipsContent = true; } catch (erc) {} }   // put the frame back
    for (var dc = disabledClips.length - 1; dc >= 0; dc--) { try { disabledClips[dc].clipsContent = true; } catch (edc) {} }
    if (workspace) workspace.remove();
    figma.currentPage.selection = originals;
    _temporaryExportRoot = null;
    _subtreeFlagsByNode = null;
    _contentBoundsByNode = null;
    _exportSourceIds = {};
    _exportInstanceNodes = {};
    _blendMerged = {};
    _blendPaintMerged = {};
    _exporting = false;
    figma.ui.postMessage({ type: 'export-state', busy: false });
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

function _needsStrokeOutline(n) {
  if (!(n.strokes || []).some(function (p) { return p.visible !== false; }) || n.strokeWeight === 0) return false;
  if (n.dashPattern && n.dashPattern.length) return true;
  if (typeof n.strokeWeight === 'number') return n.strokeWeight > 0 && n.strokeWeight < 1;
  return ['strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight'].some(function (key) {
    return n[key] > 0 && n[key] < 1;
  });
}

function _vectorText(n) { return n.type === 'TEXT' && (_outlineTexts || _needsStrokeOutline(n)); }

function _isolatedExportCopy(n, root) {
  var transform = n.absoluteTransform.map(function (row) { return row.slice(); }), copy = n.clone();
  root.parent.appendChild(copy);
  if ((copy.width !== n.width || copy.height !== n.height) && typeof copy.resizeWithoutConstraints === 'function') copy.resizeWithoutConstraints(n.width, n.height);
  copy.relativeTransform = _matrixProduct(_inverseMatrix(root.parent.absoluteTransform), transform);
  return copy;
}

function _vectorPaintParts(vector) {
  var m = vector.absoluteTransform, geo = vector.fillGeometry || [], paints = _paints(vector.fills, vector);
  var matrix = [m[0][0], m[1][0], m[0][1], m[1][1], m[0][2], m[1][2]];
  var regions = vector.vectorNetwork && vector.vectorNetwork.regions, parts = [];
  if (regions && regions.length === geo.length && regions.some(function (r) { return JSON.stringify(r.fills) !== JSON.stringify(regions[0].fills); })) {
    for (var i = 0; i < geo.length; i++) parts.push({ geometry: [geo[i]], fills: _paints(regions[i].fills && regions[i].fills.length ? regions[i].fills : vector.fills, vector), matrix: matrix });
  } else parts.push({ geometry: geo, fills: paints, matrix: matrix });
  return parts.filter(function (part) { return part.geometry.length && part.fills.length; }).map(function (part) {
    part.paths = part.geometry.map(function (p) { return { d: p.data, evenOdd: p.windingRule === 'EVENODD' }; });
    return part;
  });
}

function _vectorTextFills(n, root) {
  var copy = null, vector = null;
  try {
    copy = _isolatedExportCopy(n, root);
    copy.strokes = [];
    vector = figma.flatten([copy], root.parent);
    return _vectorPaintParts(vector);
  } catch (error) { throw _layerError(n, '文字「' + n.name + '」转矢量失败：' + (error.message || error)); }
  finally {
    if (vector && !vector.removed) vector.remove();
    if (copy && !copy.removed) copy.remove();
  }
}

function _outlineExportStroke(n, root, force) {
  if (force ? !(n.strokes || []).some(function (p) { return p.visible !== false; }) || n.strokeWeight === 0 : !_needsStrokeOutline(n)) return null;
  var copy = null, outline = null;
  try {
    // Outline an isolated copy: adding the new vector must not reflow an auto-layout parent.
    copy = _isolatedExportCopy(n, root);
    outline = copy.outlineStroke();
    if (!outline || !(outline.fillGeometry || []).length) throw new Error('未生成描边轮廓');
    var parts = _vectorPaintParts(outline);
    for (var k = 0; k < parts.length; k++) {
      if (parts[k].fills.some(function (p) { return p.kind === 'image'; })) throw new Error('图片描边需要标记为图片');
    }
    return parts;
  } catch (error) {
    throw _layerError(n, '图层「' + n.name + '」描边轮廓化失败：' + (error.message || error));
  } finally {
    if (outline && !outline.removed) outline.remove();
    if (copy && !copy.removed) copy.remove();
  }
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
      if ((n.type !== 'TEXT' || _vectorText(n)) && n.absoluteBoundingBox && typeof n.fillGeometry !== 'undefined') {
        var geo = n.fillGeometry || [];
        var fills = _paints(n.fills, n);
        var strokes = _paints(n.strokes, n);
        var strokeAsFill = false;
        var textVector = _vectorText(n), outlines = _outlineExportStroke(n, root, textVector), outlineBase = null;
        if (outlines) strokes = [];
        if (textVector) {
          var glyphs = _vectorTextFills(n, root);
          if (glyphs.length) {
            outlineBase = glyphs.shift(); geo = outlineBase.geometry; fills = outlineBase.fills;
            outlines = glyphs.concat(outlines || []);
          }
        }
        if (outlines) {
          if (!fills.length && outlines.length) {
            outlineBase = outlines.shift();
            geo = outlineBase.geometry;
            fills = outlineBase.fills;
          }
        }

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
          if (!strokeAsFill && !outlineBase) {
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
          try { vn = outlineBase ? null : (n.vectorNetwork || null); } catch (evn0) { vn = null; }
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
          var m = outlineBase ? [[outlineBase.matrix[0], outlineBase.matrix[2], outlineBase.matrix[4]], [outlineBase.matrix[1], outlineBase.matrix[3], outlineBase.matrix[5]]] : n.absoluteTransform;
          if (pieces) {
            // one AE layer per painted region, in the network's own order (first = bottom)
            for (var pz = 0; pz < pieces.length; pz++) {
              out.push({
                name: n.name, id: n.id + '/' + pz, sourceId: _exportSourceIds[n.id] || n.id,
                maskId: organize && isGroup ? null : (_maskByNode[n.id] || null), maskSource: _maskSourceByNode[n.id] || null,
                maskType: n.maskType || 'ALPHA',
                path: _pathOf(n, root.id), z: _zOf(n),
                prim: null, hidden: _isHidden(n), opacity: _maskSourceByNode[n.id] ? own : chainOpacity,
                blend: organize && isGroup ? 'NORMAL' : (n.blendMode || 'NORMAL'),
                paths: pieces[pz].d,
                matrix: [m[0][0], m[1][0], m[0][1], m[1][1], m[0][2], m[1][2]],
                fills: pieces[pz].fills, strokes: (pz === pieces.length - 1 ? strokes : []),
                imageFill: false, strokeAsFill: false,
                strokeWeight: (typeof n.strokeWeight === 'number' ? n.strokeWeight : 1),
                strokeAlign: n.strokeAlign || 'CENTER',
                cap: CAP[n.strokeCap] || null, join: JOIN[n.strokeJoin] || null,
                miter: (typeof n.strokeMiterLimit === 'number' ? n.strokeMiterLimit : null),
                dash: outlines ? null : ((n.dashPattern && n.dashPattern.length) ? n.dashPattern.slice(0) : null),
                outlinedStrokes: pz === pieces.length - 1 ? outlines : null,
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
            sourceId: _exportSourceIds[n.id] || n.id,
            maskId: organize && isGroup ? null : (_maskByNode[n.id] || null),
            maskSource: _maskSourceByNode[n.id] || null,
            maskType: n.maskType || 'ALPHA',
            // A FRAME is BOTH a container and a painted layer: the card's own background. Its
            // path must therefore include ITSELF, or the background ends up as a sibling of its
            // own precomp instead of the bottom layer inside it.
            path: (organize && isGroup) ? _pathOf(n, root.id).concat([n.id]) : _pathOf(n, root.id),
            z: _zOf(n),                      // paint order across the whole tree
            prim: prim,
            hidden: _isHidden(n),
            opacity: _maskSourceByNode[n.id] ? own : chainOpacity,
            blend: organize && isGroup ? 'NORMAL' : (n.blendMode || 'NORMAL'),
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
            dash: outlines ? null : ((n.dashPattern && n.dashPattern.length) ? n.dashPattern.slice(0) : null),
            outlinedStrokes: outlines,
            // effects belong to the node, so no bounding-box matching is needed here.
            // In organize mode a container's shadow is carried by its PRECOMP, so leaving it on
            // the background as well drew the same drop shadow twice.
            fx: ((organize && isGroup) ? [] : _textEffects(n)),
            inheritedBlur: groupBlur          // blur set on an ancestor group
          });
        }
      }
    } catch (e) { throw _layerError(n, '图层「' + n.name + '」读取失败：' + (e.message || e)); }
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
          var imageMatrix = null;
          if (mode === 'CROP' && f.imageTransform && _usesIndependentMask(n)) {
            var crop = _inverseMatrix(f.imageTransform);
            var placement = _matrixProduct(n.absoluteTransform, [
              [n.width * crop[0][0], n.width * crop[0][1], n.width * crop[0][2]],
              [n.height * crop[1][0], n.height * crop[1][1], n.height * crop[1][2]]
            ]);
            imageMatrix = [placement[0][0], placement[1][0], placement[0][1], placement[1][1], placement[0][2], placement[1][2]];
          }
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
            sourceId: _exportSourceIds[n.id] || n.id,
            name: (n.name || 'image').replace(/[^A-Za-z0-9_\-]+/g, '_'),
            hash: f.imageHash,
            imageMatrix: imageMatrix, preserveSource: _usesIndependentMask(n),
            cx: ccx, cy: ccy, cw: lw, ch: lh,
            x: b.x, y: b.y, w: b.width, h: b.height,
          // What the precomp must be able to hold. A clipping frame hides its overflow anyway,
          // so for it the box IS the content; everything else takes the union with its children.
          cb: (n.clipsContent === true) ? { x: b.x, y: b.y, w: b.width, h: b.height } : _contentBounds(n),
            // Was the node's OWN opacity only, so a picture inside a faded group arrived at full
            // strength. The chain fixes that, and in organize mode it stops at the container
            // because the precomp carries the group's opacity.
            scaleMode: mode, opacity: (organize && _isContainer(n) ? 1 : _opacityChain(n, organize, rootId)) * (f.opacity == null ? 1 : f.opacity), hidden: _isHidden(n),
            maskId: organize && _isContainer(n) ? null : (_maskByNode[n.id] || null),
            blend: organize && _isContainer(n) ? 'NORMAL' : (n.blendMode || 'NORMAL'),
            path: organize && _isContainer(n) ? _pathOf(n, rootId).concat([n.id]) : _pathOf(n, rootId), z: _zOf(n),
            rotation: _rotOf(n), matte: needsMatte ? m : null
          });
          break;                                              // one picture per node
        }
      }
    } catch (e) { throw _layerError(n, '图片「' + n.name + '」读取失败：' + (e.message || e)); }
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
    throw new Error('当前 Figma 版本不支持图片导出');
  }
  var CHUNK = 1024 * 1024;
  for (var q = 0; q < images.length; q++) {
    var im = images[q], b64 = '', ext = 'png', natW = 0, natH = 0;
    try {
      var bytes;
      if (im.rasterBytes) {
        bytes = im.rasterBytes; im.rasterBytes = null;
        var referenceSize = _pngSize(bytes);
        natW = referenceSize ? referenceSize.width : im.natW;
        natH = referenceSize ? referenceSize.height : im.natH;
        b64 = figma.base64Encode(bytes); bytes = null;
      } else if (im.rasterNode) {
        bytes = await _exportRasterPass(im);
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
    } catch (e) { throw _layerError(im, '图片「' + im.name + '」导出失败：' + (e.message || e)); }
    var meta = { name: im.name, sourceId: im.sourceId || null, ext: ext, x: im.x, y: im.y, w: im.w, h: im.h,
                 cx: im.cx, cy: im.cy, cw: im.cw, ch: im.ch,
                 natW: natW, natH: natH, scaleMode: im.scaleMode, rasterScale: im.rasterScale || null, imageMatrix: im.imageMatrix || null,
                 maskSource: im.maskSource || null, maskType: im.maskType || null,
                 opacity: im.opacity, rotation: im.rotation, matte: im.matte,
                 blend: im.blend || 'NORMAL', path: im.path || null, z: (im.z || 0), maskId: im.maskId || null,
                 hidden: !!im.hidden, reference: !!im.reference, shadow: !!im.shadow, shadowBase: im.shadowBase || null, mergedBlend: !!im.mergedBlend, external: !!im.external };
    if (_bicubicExport && !(im.preserveSource && !im.rasterScale)) {
      var factor = im.rasterScale ? 0.5 : _rasterScale * (im.scaleMode === 'FIT'
        ? Math.min(im.cw / natW, im.ch / natH) : Math.max(im.cw / natW, im.ch / natH));
      meta.bicubic = { width: Math.max(1, Math.ceil(natW * factor)), height: Math.max(1, Math.ceil(natH * factor)) };
    }
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
function _leading(lineHeight, fontSize) {
  if (!lineHeight || lineHeight === figma.mixed || typeof lineHeight.value !== 'number') return null;
  if (lineHeight.unit === 'PIXELS') return lineHeight.value;
  if (lineHeight.unit === 'PERCENT') return lineHeight.value * fontSize / 100;
  return null;
}

function _solidOf(fills) {
  var col = [0, 0, 0], op = 1;
  if (fills && fills !== figma.mixed) {
    op = 0;
    for (var i = 0; i < fills.length; i++) {
      var paint = fills[i]; if (paint.visible === false) continue;
      op = 1;
      if (paint.type === 'SOLID') { col = [paint.color.r, paint.color.g, paint.color.b]; op = paint.opacity == null ? 1 : paint.opacity; }
      break;
    }
  }
  return { color: col, opacity: op };
}

function _textStroke(n) {
  var strokes = n.strokes;
  if (!strokes || strokes === figma.mixed || typeof n.strokeWeight !== 'number' || n.strokeWeight <= 0) return null;
  for (var i = strokes.length - 1; i >= 0; i--) {
    var p = strokes[i];
    if (p.visible === false || p.type !== 'SOLID') continue;
    return { color: [p.color.r, p.color.g, p.color.b], width: n.strokeWeight, align: n.strokeAlign || 'CENTER', opacity: p.opacity == null ? 1 : p.opacity };
  }
  return null;
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
        type: (f.type === 'GRADIENT_RADIAL') ? 'radial' : 'linear', stops: stops, opacity: f.opacity == null ? 1 : f.opacity,
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
    if (rb && typeof rb.y === 'number') {
      var ink = { x: rb.x - rootBox.x, y: rb.y - rootBox.y, w: rb.width, h: rb.height };
      var stroke = _textStroke(n);
      // Layer Styles do not enlarge sourceRectAtTime(). Align the glyphs using
      // their unstroked bounds, rather than moving/scaling them to the outer edge.
      if (stroke && !_rotOf(n) && !_skewOf(n)) {
        var amount = stroke.width * (stroke.align === 'OUTSIDE' ? 1 : stroke.align === 'CENTER' ? 0.5 : 0);
        var matrix = n.absoluteTransform;
        var dx = amount * Math.abs(matrix[0][0]), dy = amount * Math.abs(matrix[1][1]);
        ink.x += dx; ink.y += dy; ink.w -= dx * 2; ink.h -= dy * 2;
      }
      return ink;
    }
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

function collectTexts(root, rootBox, rootId, organize, vectorTexts) {
  var out = [];
  function walk(n) {
    if (_ignoreHidden && _isHidden(n)) return;
    if (_rasterByNode[n.id]) return;
    if (_maskSourceByNode[n.id]) return;       // mask contours never become text/art layers
    if (vectorTexts && _vectorText(n)) return;
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
          try { segs = n.getStyledTextSegments(['fontName', 'fontSize', 'fills', 'textCase', 'letterSpacing', 'lineHeight']); } catch (es) {}

          if (segs && segs.length > 1) {
            var runs = [];
            for (var k = 0; k < segs.length; k++) {
              var sg = segs[k], c = _solidOf(sg.fills);
              var fn = sg.fontName, fam = (fn && fn.family) ? fn.family : 'Arial', sty = (fn && fn.style) ? fn.style : 'Regular';
              var sfs = (typeof sg.fontSize === 'number') ? sg.fontSize : 16;
              runs.push({
                characters: _applyCase(sg.characters, sg.textCase),
                fontSize: sfs,
                family: fam, style: sty, color: c.color, opacity: c.opacity, stroke: _textStroke(n),
                tracking: _tracking(sg.letterSpacing, sfs), leading: _leading(sg.lineHeight || n.lineHeight, sfs)
              });
            }
            // Rich text wraps exactly like plain text does — without this flag AE built it as
            // point text and every multi-style paragraph ran off in one endless line.
            var rFixed = (n.textAutoResize && n.textAutoResize !== 'WIDTH_AND_HEIGHT');
            var rChars = n.characters || '';
            var rSize = (typeof n.fontSize === 'number') ? n.fontSize : (runs.length ? runs[0].fontSize : 16);
            var rWraps = /[\n\u2028\u2029]/.test(rChars) || (rChars.length * rSize * 0.52) > (b.width * 1.05) ||
                         _rendersMultiline(n, rSize);
            out.push({ _node: n, sourceId: _exportSourceIds[n.id] || n.id, runs: true, name: n.name, opacity: nodeOp, maskId: _maskByNode[n.id] || null, x: x, y: y, w: b.width, h: b.height, align: align, segs: runs,
                       path: _pathOf(n, rootId), z: _zOf(n), box: !!(rFixed && rWraps), hidden: _hid, blur: _blurOf(n), blend: n.blendMode || 'NORMAL',
                       rotation: _rotOf(n), skewX: _skewOf(n), stroke: _textStroke(n), fx: _textEffects(n), grad: _gradFill(n), ink: _inkBounds(n, rootBox),
                       leading: _leading(n.lineHeight, rSize), paragraphSpacing: typeof n.paragraphSpacing === 'number' ? n.paragraphSpacing : null,
                       paragraphIndent: typeof n.paragraphIndent === 'number' ? n.paragraphIndent : null });
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
              _node: n, sourceId: _exportSourceIds[n.id] || n.id, name: n.name, maskId: _maskByNode[n.id] || null, characters: _applyCase(n.characters, tc),
              path: _pathOf(n, rootId), z: _zOf(n),
              x: x, y: y, w: b.width, h: b.height,
              fontSize: fsz, family: fam2, style: sty2,
              color: cc.color, opacity: nodeOp, fillOpacity: cc.opacity, align: align, box: !!isBox, hidden: _hid, blur: _blurOf(n),
              blend: n.blendMode || 'NORMAL',
              tracking: _tracking(ls, fsz), rotation: _rotOf(n), skewX: _skewOf(n), stroke: _textStroke(n), fx: _textEffects(n), grad: _gradFill(n), ink: _inkBounds(n, rootBox),
              leading: _leading(n.lineHeight, fsz), paragraphSpacing: typeof n.paragraphSpacing === 'number' ? n.paragraphSpacing : null,
              paragraphIndent: typeof n.paragraphIndent === 'number' ? n.paragraphIndent : null
            });
          }
        }
      } catch (e) { throw _layerError(n, '文字「' + n.name + '」读取失败：' + (e.message || e)); }
    }
    // text used as a boolean operand is baked into the boolean's result, not a live layer
    if (n.type !== 'BOOLEAN_OPERATION' && 'children' in n)
      for (var i = 0; i < n.children.length; i++) walk(n.children[i]);
  }
  walk(root);
  return out;
}

figma.ui.onmessage = function (msg) {
  if (msg.type === 'mcp-info') {
    reportMcpInfo();
    return;
  }
  if (msg.type === 'mcp-command') return executeMcpCommand(msg);
  if (msg.type === 'locate-layer') return locateErrorLayer(msg.nodeId);
  if (msg.type === 'ship-selection') exportSelectionSVG(!!msg.useNodes, !!msg.organize, msg.ignoreHidden !== false, msg.convertMasks === true, msg.rasterGroups !== false, msg.rasterTexts === true, msg);
  if (msg.type === 'mark-raster') markRasterSelection(true);
  if (msg.type === 'unmark-raster') markRasterSelection(false);
  if (msg.type === 'layer-tool') runLayerTool(msg.action);
  if (msg.type === 'close') figma.closePlugin(msg.message || undefined);
  if (msg.type === 'notify') figma.notify(msg.message);
};

// Tell the UI about selection so the button can enable/disable + show a count.
function reportSelection() {
  figma.ui.postMessage({ type: 'selection', count: figma.currentPage.selection.length });
}
figma.on('selectionchange', reportSelection);
reportSelection();

// Share the document with the embedded MCP handlers without replacing F2A's UI callbacks.
var mcpQueue = Promise.resolve(), mcpBusy = false;
function reportMcpInfo() {
  figma.ui.postMessage({type:'mcp-info', name:figma.root.name, fileKey:figma.fileKey || null,
    pageId:figma.currentPage.id, pageName:figma.currentPage.name});
}
figma.on('currentpagechange', reportMcpInfo);
function executeMcpCommand(msg) {
  mcpQueue = mcpQueue.then(async function () {
    if (_exporting) throw new Error('F2A 正在导出，请稍后重试');
    mcpBusy = true;
    figma.ui.postMessage({type:'mcp-busy', busy:true});
    try {
      var result = await F2AMCP.execute(msg.command, msg.params || {});
      figma.ui.postMessage({type:'mcp-result', id:msg.id, result:result});
    } finally { mcpBusy = false; figma.ui.postMessage({type:'mcp-busy', busy:false}); }
  }).catch(function (error) {
    figma.ui.postMessage({type:'mcp-result', id:msg.id, error:error.message || String(error)});
  });
  return mcpQueue;
}

// BEGIN F2A MCP (generated by scripts/build-mcp.cjs)
/*
The MIT License (MIT)

Copyright (c) 2025 Github User sonnylazuardi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
var F2AMCP = /* @__PURE__ */ (function() {
  async function sendProgressUpdate(commandId, commandType, status, progress, totalItems, processedItems, message, payload = null) {
    const update = {
      type: "command_progress",
      commandId,
      commandType,
      status,
      progress,
      totalItems,
      processedItems,
      message,
      timestamp: Date.now()
    };
    if (payload) {
      if (payload.currentChunk !== void 0 && payload.totalChunks !== void 0) {
        update.currentChunk = payload.currentChunk;
        update.totalChunks = payload.totalChunks;
        update.chunkSize = payload.chunkSize;
      }
      update.payload = payload;
    }
    figma.ui.postMessage(update);
    console.log(`Progress update: ${status} - ${progress}% - ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return update;
  }
  async function handleCommand(command, params) {
    switch (command) {
      case "get_document_info":
        return await getDocumentInfo();
      case "get_selection":
        return await getSelection();
      case "get_node_info":
        if (!params || !params.nodeId) {
          throw new Error("Missing nodeId parameter");
        }
        return await getNodeInfo(params.nodeId);
      case "get_nodes_info":
        if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
          throw new Error("Missing or invalid nodeIds parameter");
        }
        return await getNodesInfo(params.nodeIds);
      case "read_my_design":
        return await readMyDesign();
      case "create_rectangle":
        return await createRectangle(params);
      case "create_frame":
        return await createFrame(params);
      case "create_text":
        return await createText(params);
      case "set_fill_color":
        return await setFillColor(params);
      case "set_stroke_color":
        return await setStrokeColor(params);
      case "move_node":
        return await moveNode(params);
      case "resize_node":
        return await resizeNode(params);
      case "delete_node":
        return await deleteNode(params);
      case "delete_multiple_nodes":
        return await deleteMultipleNodes(params);
      case "get_styles":
        return await getStyles();
      case "get_local_components":
        return await getLocalComponents(params);
      // case "get_team_components":
      //   return await getTeamComponents();
      case "create_component_instance":
        return await createComponentInstance(params);
      case "export_node_as_image":
        return await exportNodeAsImage(params);
      case "set_corner_radius":
        return await setCornerRadius(params);
      case "set_text_content":
        return await setTextContent(params);
      case "clone_node":
        return await cloneNode(params);
      case "scan_text_nodes":
        return await scanTextNodes(params);
      case "set_multiple_text_contents":
        return await setMultipleTextContents(params);
      case "get_annotations":
        return await getAnnotations(params);
      case "set_annotation":
        return await setAnnotation(params);
      case "scan_nodes_by_types":
        return await scanNodesByTypes(params);
      case "set_multiple_annotations":
        return await setMultipleAnnotations(params);
      case "get_instance_overrides":
        if (params && params.instanceNodeId) {
          const instanceNode = await figma.getNodeByIdAsync(params.instanceNodeId);
          if (!instanceNode) {
            throw new Error(`Instance node not found with ID: ${params.instanceNodeId}`);
          }
          return await getInstanceOverrides(instanceNode);
        }
        return await getInstanceOverrides();
      case "set_instance_overrides":
        if (params && params.targetNodeIds) {
          if (!Array.isArray(params.targetNodeIds)) {
            throw new Error("targetNodeIds must be an array");
          }
          const targetNodes = await getValidTargetInstances(params.targetNodeIds);
          if (!targetNodes.success) {
            figma.notify(targetNodes.message);
            return { success: false, message: targetNodes.message };
          }
          if (params.sourceInstanceId) {
            let sourceInstanceData = null;
            sourceInstanceData = await getSourceInstanceData(params.sourceInstanceId);
            if (!sourceInstanceData.success) {
              figma.notify(sourceInstanceData.message);
              return { success: false, message: sourceInstanceData.message };
            }
            return await setInstanceOverrides(targetNodes.targetInstances, sourceInstanceData);
          } else {
            throw new Error("Missing sourceInstanceId parameter");
          }
        }
      case "set_layout_mode":
        return await setLayoutMode(params);
      case "set_padding":
        return await setPadding(params);
      case "set_axis_align":
        return await setAxisAlign(params);
      case "set_layout_sizing":
        return await setLayoutSizing(params);
      case "set_item_spacing":
        return await setItemSpacing(params);
      case "get_reactions":
        if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
          throw new Error("Missing or invalid nodeIds parameter");
        }
        return await getReactions(params.nodeIds);
      case "set_default_connector":
        return await setDefaultConnector(params);
      case "create_connections":
        return await createConnections(params);
      case "set_focus":
        return await setFocus(params);
      case "set_selections":
        return await setSelections(params);
      case "set_image_fill":
        return await setImageFill(params);
      case "rename_node":
        return await renameNode(params);
      case "create_section":
        return await createSection(params);
      case "set_parent":
        return await setParent(params);
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }
  async function getDocumentInfo() {
    await figma.currentPage.loadAsync();
    const page = figma.currentPage;
    return {
      name: page.name,
      id: page.id,
      type: page.type,
      children: page.children.map((node) => ({
        id: node.id,
        name: node.name,
        type: node.type
      })),
      currentPage: {
        id: page.id,
        name: page.name,
        childCount: page.children.length
      },
      pages: [
        {
          id: page.id,
          name: page.name,
          childCount: page.children.length
        }
      ]
    };
  }
  async function getSelection() {
    return {
      selectionCount: figma.currentPage.selection.length,
      selection: figma.currentPage.selection.map((node) => ({
        id: node.id,
        name: node.name,
        type: node.type,
        visible: node.visible
      }))
    };
  }
  function rgbaToHex(color) {
    var r = Math.round(color.r * 255);
    var g = Math.round(color.g * 255);
    var b = Math.round(color.b * 255);
    var a = color.a !== void 0 ? Math.round(color.a * 255) : 255;
    if (a === 255) {
      return "#" + [r, g, b].map((x) => {
        return x.toString(16).padStart(2, "0");
      }).join("");
    }
    return "#" + [r, g, b, a].map((x) => {
      return x.toString(16).padStart(2, "0");
    }).join("");
  }
  function filterFigmaNode(node) {
    if (node.type === "VECTOR") {
      return null;
    }
    var filtered = {
      id: node.id,
      name: node.name,
      type: node.type
    };
    if (node.fills && node.fills.length > 0) {
      filtered.fills = node.fills.map((fill) => {
        var processedFill = Object.assign({}, fill);
        delete processedFill.boundVariables;
        delete processedFill.imageRef;
        if (processedFill.gradientStops) {
          processedFill.gradientStops = processedFill.gradientStops.map(
            (stop) => {
              var processedStop = Object.assign({}, stop);
              if (processedStop.color) {
                processedStop.color = rgbaToHex(processedStop.color);
              }
              delete processedStop.boundVariables;
              return processedStop;
            }
          );
        }
        if (processedFill.color) {
          processedFill.color = rgbaToHex(processedFill.color);
        }
        return processedFill;
      });
    }
    if (node.strokes && node.strokes.length > 0) {
      filtered.strokes = node.strokes.map((stroke) => {
        var processedStroke = Object.assign({}, stroke);
        delete processedStroke.boundVariables;
        if (processedStroke.color) {
          processedStroke.color = rgbaToHex(processedStroke.color);
        }
        return processedStroke;
      });
    }
    if (node.cornerRadius !== void 0) {
      filtered.cornerRadius = node.cornerRadius;
    }
    if (node.absoluteBoundingBox) {
      filtered.absoluteBoundingBox = node.absoluteBoundingBox;
    }
    if (node.characters) {
      filtered.characters = node.characters;
    }
    if (node.style) {
      filtered.style = {
        fontFamily: node.style.fontFamily,
        fontStyle: node.style.fontStyle,
        fontWeight: node.style.fontWeight,
        fontSize: node.style.fontSize,
        textAlignHorizontal: node.style.textAlignHorizontal,
        letterSpacing: node.style.letterSpacing,
        lineHeightPx: node.style.lineHeightPx
      };
    }
    if (node.children) {
      filtered.children = node.children.map((child) => {
        return filterFigmaNode(child);
      }).filter((child) => {
        return child !== null;
      });
    }
    return filtered;
  }
  async function getNodeInfo(nodeId) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error(`Node not found with ID: ${nodeId}`);
    }
    const response = await node.exportAsync({
      format: "JSON_REST_V1"
    });
    return filterFigmaNode(response.document);
  }
  async function getNodesInfo(nodeIds) {
    try {
      const nodes = await Promise.all(
        nodeIds.map((id) => figma.getNodeByIdAsync(id))
      );
      const validNodes = nodes.filter((node) => node !== null);
      const responses = await Promise.all(
        validNodes.map(async (node) => {
          const response = await node.exportAsync({
            format: "JSON_REST_V1"
          });
          return {
            nodeId: node.id,
            document: filterFigmaNode(response.document)
          };
        })
      );
      return responses;
    } catch (error) {
      throw new Error(`Error getting nodes info: ${error.message}`);
    }
  }
  async function getReactions(nodeIds) {
    try {
      let getNodePath2 = function(node) {
        const path = [];
        let current = node;
        while (current && current.parent) {
          path.unshift(current.name);
          current = current.parent;
        }
        return path.join(" > ");
      };
      var getNodePath = getNodePath2;
      const commandId = generateCommandId();
      sendProgressUpdate(
        commandId,
        "get_reactions",
        "started",
        0,
        nodeIds.length,
        0,
        `Starting deep search for reactions in ${nodeIds.length} nodes and their children`
      );
      async function findNodesWithReactions(node, processedNodes = /* @__PURE__ */ new Set(), depth = 0, results = []) {
        if (processedNodes.has(node.id)) {
          return results;
        }
        processedNodes.add(node.id);
        let filteredReactions = [];
        if (node.reactions && node.reactions.length > 0) {
          filteredReactions = node.reactions.filter((r) => {
            if (r.action && r.action.navigation === "CHANGE_TO") return false;
            if (Array.isArray(r.actions)) {
              return !r.actions.some((a) => a.navigation === "CHANGE_TO");
            }
            return true;
          });
        }
        const hasFilteredReactions = filteredReactions.length > 0;
        if (hasFilteredReactions) {
          results.push({
            id: node.id,
            name: node.name,
            type: node.type,
            depth,
            hasReactions: true,
            reactions: filteredReactions,
            path: getNodePath2(node)
          });
          await highlightNodeWithAnimation(node);
        }
        if (node.children) {
          for (const child of node.children) {
            await findNodesWithReactions(child, processedNodes, depth + 1, results);
          }
        }
        return results;
      }
      async function highlightNodeWithAnimation(node) {
        const originalStrokeWeight = node.strokeWeight;
        const originalStrokes = node.strokes ? [...node.strokes] : [];
        try {
          node.strokeWeight = 4;
          node.strokes = [{
            type: "SOLID",
            color: { r: 1, g: 0.5, b: 0 },
            // Orange color
            opacity: 0.8
          }];
          setTimeout(() => {
            try {
              node.strokeWeight = originalStrokeWeight;
              node.strokes = originalStrokes;
            } catch (restoreError) {
              console.error(`Error restoring node stroke: ${restoreError.message}`);
            }
          }, 1500);
        } catch (highlightError) {
          console.error(`Error highlighting node: ${highlightError.message}`);
        }
      }
      let allResults = [];
      let processedCount = 0;
      const totalCount = nodeIds.length;
      for (let i = 0; i < nodeIds.length; i++) {
        try {
          const nodeId = nodeIds[i];
          const node = await figma.getNodeByIdAsync(nodeId);
          if (!node) {
            processedCount++;
            sendProgressUpdate(
              commandId,
              "get_reactions",
              "in_progress",
              processedCount / totalCount,
              totalCount,
              processedCount,
              `Node not found: ${nodeId}`
            );
            continue;
          }
          const processedNodes = /* @__PURE__ */ new Set();
          const nodeResults = await findNodesWithReactions(node, processedNodes);
          allResults = allResults.concat(nodeResults);
          processedCount++;
          sendProgressUpdate(
            commandId,
            "get_reactions",
            "in_progress",
            processedCount / totalCount,
            totalCount,
            processedCount,
            `Processed node ${processedCount}/${totalCount}, found ${nodeResults.length} nodes with reactions`
          );
        } catch (error) {
          processedCount++;
          sendProgressUpdate(
            commandId,
            "get_reactions",
            "in_progress",
            processedCount / totalCount,
            totalCount,
            processedCount,
            `Error processing node: ${error.message}`
          );
        }
      }
      sendProgressUpdate(
        commandId,
        "get_reactions",
        "completed",
        1,
        totalCount,
        totalCount,
        `Completed deep search: found ${allResults.length} nodes with reactions.`
      );
      return {
        nodesCount: nodeIds.length,
        nodesWithReactions: allResults.length,
        nodes: allResults
      };
    } catch (error) {
      throw new Error(`Failed to get reactions: ${error.message}`);
    }
  }
  async function readMyDesign() {
    try {
      const nodes = await Promise.all(
        figma.currentPage.selection.map((node) => figma.getNodeByIdAsync(node.id))
      );
      const validNodes = nodes.filter((node) => node !== null);
      const responses = await Promise.all(
        validNodes.map(async (node) => {
          const response = await node.exportAsync({
            format: "JSON_REST_V1"
          });
          return {
            nodeId: node.id,
            document: filterFigmaNode(response.document)
          };
        })
      );
      return responses;
    } catch (error) {
      throw new Error(`Error getting nodes info: ${error.message}`);
    }
  }
  async function createRectangle(params) {
    const {
      x = 0,
      y = 0,
      width = 100,
      height = 100,
      name = "Rectangle",
      parentId
    } = params || {};
    const rect = figma.createRectangle();
    rect.x = x;
    rect.y = y;
    rect.resize(width, height);
    rect.name = name;
    if (parentId) {
      const parentNode = await figma.getNodeByIdAsync(parentId);
      if (!parentNode) {
        throw new Error(`Parent node not found with ID: ${parentId}`);
      }
      if (!("appendChild" in parentNode)) {
        throw new Error(`Parent node does not support children: ${parentId}`);
      }
      parentNode.appendChild(rect);
    } else {
      figma.currentPage.appendChild(rect);
    }
    return {
      id: rect.id,
      name: rect.name,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      parentId: rect.parent ? rect.parent.id : void 0
    };
  }
  async function createFrame(params) {
    const {
      x = 0,
      y = 0,
      width = 100,
      height = 100,
      name = "Frame",
      parentId,
      fillColor,
      strokeColor,
      strokeWeight,
      layoutMode = "NONE",
      layoutWrap = "NO_WRAP",
      paddingTop = 10,
      paddingRight = 10,
      paddingBottom = 10,
      paddingLeft = 10,
      primaryAxisAlignItems = "MIN",
      counterAxisAlignItems = "MIN",
      layoutSizingHorizontal = "FIXED",
      layoutSizingVertical = "FIXED",
      itemSpacing = 0
    } = params || {};
    const frame = figma.createFrame();
    frame.x = x;
    frame.y = y;
    frame.resize(width, height);
    frame.name = name;
    if (layoutMode !== "NONE") {
      frame.layoutMode = layoutMode;
      frame.layoutWrap = layoutWrap;
      frame.paddingTop = paddingTop;
      frame.paddingRight = paddingRight;
      frame.paddingBottom = paddingBottom;
      frame.paddingLeft = paddingLeft;
      frame.primaryAxisAlignItems = primaryAxisAlignItems;
      frame.counterAxisAlignItems = counterAxisAlignItems;
      frame.layoutSizingHorizontal = layoutSizingHorizontal;
      frame.layoutSizingVertical = layoutSizingVertical;
      frame.itemSpacing = itemSpacing;
    }
    if (fillColor) {
      const paintStyle = {
        type: "SOLID",
        color: {
          r: parseFloat(fillColor.r) || 0,
          g: parseFloat(fillColor.g) || 0,
          b: parseFloat(fillColor.b) || 0
        },
        opacity: parseFloat(fillColor.a) || 1
      };
      frame.fills = [paintStyle];
    }
    if (strokeColor) {
      const strokeStyle = {
        type: "SOLID",
        color: {
          r: parseFloat(strokeColor.r) || 0,
          g: parseFloat(strokeColor.g) || 0,
          b: parseFloat(strokeColor.b) || 0
        },
        opacity: parseFloat(strokeColor.a) || 1
      };
      frame.strokes = [strokeStyle];
    }
    if (strokeWeight !== void 0) {
      frame.strokeWeight = strokeWeight;
    }
    if (parentId) {
      const parentNode = await figma.getNodeByIdAsync(parentId);
      if (!parentNode) {
        throw new Error(`Parent node not found with ID: ${parentId}`);
      }
      if (!("appendChild" in parentNode)) {
        throw new Error(`Parent node does not support children: ${parentId}`);
      }
      parentNode.appendChild(frame);
    } else {
      figma.currentPage.appendChild(frame);
    }
    return {
      id: frame.id,
      name: frame.name,
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      fills: frame.fills,
      strokes: frame.strokes,
      strokeWeight: frame.strokeWeight,
      layoutMode: frame.layoutMode,
      layoutWrap: frame.layoutWrap,
      parentId: frame.parent ? frame.parent.id : void 0
    };
  }
  async function createText(params) {
    const {
      x = 0,
      y = 0,
      text = "Text",
      fontSize = 14,
      fontWeight = 400,
      fontColor = { r: 0, g: 0, b: 0, a: 1 },
      // Default to black
      name = "",
      parentId
    } = params || {};
    const getFontStyle = (weight) => {
      switch (weight) {
        case 100:
          return "Thin";
        case 200:
          return "Extra Light";
        case 300:
          return "Light";
        case 400:
          return "Regular";
        case 500:
          return "Medium";
        case 600:
          return "Semi Bold";
        case 700:
          return "Bold";
        case 800:
          return "Extra Bold";
        case 900:
          return "Black";
        default:
          return "Regular";
      }
    };
    const textNode = figma.createText();
    textNode.x = x;
    textNode.y = y;
    textNode.name = name || text;
    try {
      await figma.loadFontAsync({
        family: "Inter",
        style: getFontStyle(fontWeight)
      });
      textNode.fontName = { family: "Inter", style: getFontStyle(fontWeight) };
      textNode.fontSize = parseInt(fontSize);
    } catch (error) {
      console.error("Error setting font size", error);
    }
    setCharacters(textNode, text);
    const paintStyle = {
      type: "SOLID",
      color: {
        r: parseFloat(fontColor.r) || 0,
        g: parseFloat(fontColor.g) || 0,
        b: parseFloat(fontColor.b) || 0
      },
      opacity: parseFloat(fontColor.a) || 1
    };
    textNode.fills = [paintStyle];
    if (parentId) {
      const parentNode = await figma.getNodeByIdAsync(parentId);
      if (!parentNode) {
        throw new Error(`Parent node not found with ID: ${parentId}`);
      }
      if (!("appendChild" in parentNode)) {
        throw new Error(`Parent node does not support children: ${parentId}`);
      }
      parentNode.appendChild(textNode);
    } else {
      figma.currentPage.appendChild(textNode);
    }
    return {
      id: textNode.id,
      name: textNode.name,
      x: textNode.x,
      y: textNode.y,
      width: textNode.width,
      height: textNode.height,
      characters: textNode.characters,
      fontSize: textNode.fontSize,
      fontWeight,
      fontColor,
      fontName: textNode.fontName,
      fills: textNode.fills,
      parentId: textNode.parent ? textNode.parent.id : void 0
    };
  }
  async function setFillColor(params) {
    console.log("setFillColor", params);
    const {
      nodeId,
      color: { r, g, b, a }
    } = params || {};
    if (!nodeId) {
      throw new Error("Missing nodeId parameter");
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error(`Node not found with ID: ${nodeId}`);
    }
    if (!("fills" in node)) {
      throw new Error(`Node does not support fills: ${nodeId}`);
    }
    const rgbColor = {
      r: parseFloat(r) || 0,
      g: parseFloat(g) || 0,
      b: parseFloat(b) || 0,
      a: parseFloat(a) || 1
    };
    const paintStyle = {
      type: "SOLID",
      color: {
        r: parseFloat(rgbColor.r),
        g: parseFloat(rgbColor.g),
        b: parseFloat(rgbColor.b)
      },
      opacity: parseFloat(rgbColor.a)
    };
    console.log("paintStyle", paintStyle);
    node.fills = [paintStyle];
    return {
      id: node.id,
      name: node.name,
      fills: [paintStyle]
    };
  }
  async function setStrokeColor(params) {
    const {
      nodeId,
      color: { r, g, b, a },
      weight = 1
    } = params || {};
    if (!nodeId) {
      throw new Error("Missing nodeId parameter");
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error(`Node not found with ID: ${nodeId}`);
    }
    if (!("strokes" in node)) {
      throw new Error(`Node does not support strokes: ${nodeId}`);
    }
    const rgbColor = {
      r: r !== void 0 ? r : 0,
      g: g !== void 0 ? g : 0,
      b: b !== void 0 ? b : 0,
      a: a !== void 0 ? a : 1
    };
    const paintStyle = {
      type: "SOLID",
      color: {
        r: rgbColor.r,
        g: rgbColor.g,
        b: rgbColor.b
      },
      opacity: rgbColor.a
    };
    node.strokes = [paintStyle];
    if ("strokeWeight" in node) {
      node.strokeWeight = weight;
    }
    return {
      id: node.id,
      name: node.name,
      strokes: node.strokes,
      strokeWeight: "strokeWeight" in node ? node.strokeWeight : void 0
    };
  }
  async function setImageFill(params) {
    const { nodeId, imageBase64, scaleMode = "FILL" } = params || {};
    if (!nodeId) {
      throw new Error("Missing nodeId parameter");
    }
    if (!imageBase64) {
      throw new Error("Missing imageBase64 parameter");
    }
    const validScaleModes = ["FILL", "FIT", "CROP", "TILE"];
    if (validScaleModes.indexOf(scaleMode) === -1) {
      throw new Error(
        `Invalid scaleMode: ${scaleMode}. Must be one of: ${validScaleModes.join(", ")}`
      );
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error(`Node not found with ID: ${nodeId}`);
    }
    if (!("fills" in node)) {
      throw new Error(`Node does not support fills: ${nodeId}`);
    }
    const bytes = base64ToUint8Array(imageBase64);
    let image;
    try {
      image = figma.createImage(bytes);
    } catch (error) {
      throw new Error(
        `Figma rejected the image (supported: PNG/JPG/GIF/WEBP up to 4096x4096): ${error.message}`
      );
    }
    node.fills = [
      {
        type: "IMAGE",
        imageHash: image.hash,
        scaleMode
      }
    ];
    let imageWidth;
    let imageHeight;
    try {
      const size = await image.getSizeAsync();
      imageWidth = size.width;
      imageHeight = size.height;
    } catch (sizeError) {
    }
    return {
      id: node.id,
      name: node.name,
      imageHash: image.hash,
      scaleMode,
      imageWidth,
      imageHeight
    };
  }
  function base64ToUint8Array(base64) {
    if (typeof figma.base64Decode === "function") {
      return figma.base64Decode(base64);
    }
    const base64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const clean = base64.replace(/[^A-Za-z0-9+/]/g, "");
    const length = clean.length;
    const bytes = new Uint8Array(Math.floor(length * 3 / 4));
    let byteIndex = 0;
    for (let i = 0; i < length; i += 4) {
      const a = base64Chars.indexOf(clean[i]);
      const b = base64Chars.indexOf(clean[i + 1]);
      const c = base64Chars.indexOf(clean[i + 2]);
      const d = base64Chars.indexOf(clean[i + 3]);
      bytes[byteIndex++] = a << 2 | b >> 4;
      if (c !== -1) bytes[byteIndex++] = (b & 15) << 4 | c >> 2;
      if (d !== -1) bytes[byteIndex++] = (c & 3) << 6 | d;
    }
    return bytes.slice(0, byteIndex);
  }
  async function renameNode(params) {
    const { nodeId, name } = params || {};
    if (!nodeId) {
      throw new Error("Missing nodeId parameter");
    }
    if (name === void 0 || name === null) {
      throw new Error("Missing name parameter");
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error(`Node not found with ID: ${nodeId}`);
    }
    const previousName = node.name;
    try {
      node.name = String(name);
    } catch (error) {
      throw new Error(`Cannot rename node: ${error.message}`);
    }
    return {
      id: node.id,
      previousName,
      name: node.name
    };
  }
  async function createSection(params) {
    const {
      x = 0,
      y = 0,
      width = 100,
      height = 100,
      name = "Section"
    } = params || {};
    const section = figma.createSection();
    section.name = name;
    section.x = x;
    section.y = y;
    section.resizeWithoutConstraints(width, height);
    return {
      id: section.id,
      name: section.name,
      x: section.x,
      y: section.y,
      width: section.width,
      height: section.height
    };
  }
  async function setParent(params) {
    const { nodeId, parentId, x, y, index } = params || {};
    if (!nodeId) {
      throw new Error("Missing nodeId parameter");
    }
    if (!parentId) {
      throw new Error("Missing parentId parameter");
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error(`Node not found with ID: ${nodeId}`);
    }
    const parentNode = await figma.getNodeByIdAsync(parentId);
    if (!parentNode) {
      throw new Error(`Parent node not found with ID: ${parentId}`);
    }
    if (!("appendChild" in parentNode)) {
      throw new Error(`Parent node does not support children: ${parentId}`);
    }
    let ancestor = parentNode;
    while (ancestor) {
      if (ancestor.id === node.id) {
        throw new Error("Cannot move a node into its own subtree");
      }
      ancestor = ancestor.parent;
    }
    const hasAbsolute = "absoluteTransform" in node;
    const absoluteX = hasAbsolute ? node.absoluteTransform[0][2] : void 0;
    const absoluteY = hasAbsolute ? node.absoluteTransform[1][2] : void 0;
    if (index !== void 0) {
      parentNode.insertChild(index, node);
    } else {
      parentNode.appendChild(node);
    }
    if (x !== void 0 && y !== void 0) {
      node.x = x;
      node.y = y;
    } else if (hasAbsolute && "x" in node) {
      const parentAbsoluteX = "absoluteTransform" in parentNode ? parentNode.absoluteTransform[0][2] : 0;
      const parentAbsoluteY = "absoluteTransform" in parentNode ? parentNode.absoluteTransform[1][2] : 0;
      node.x = absoluteX - parentAbsoluteX;
      node.y = absoluteY - parentAbsoluteY;
    }
    return {
      id: node.id,
      name: node.name,
      parentId: parentNode.id,
      parentName: parentNode.name,
      x: "x" in node ? node.x : void 0,
      y: "y" in node ? node.y : void 0,
      index: parentNode.children.indexOf(node)
    };
  }
  async function moveNode(params) {
    const { nodeId, x, y } = params || {};
    if (!nodeId) {
      throw new Error("Missing nodeId parameter");
    }
    if (x === void 0 || y === void 0) {
      throw new Error("Missing x or y parameters");
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error(`Node not found with ID: ${nodeId}`);
    }
    if (!("x" in node) || !("y" in node)) {
      throw new Error(`Node does not support position: ${nodeId}`);
    }
    node.x = x;
    node.y = y;
    return {
      id: node.id,
      name: node.name,
      x: node.x,
      y: node.y
    };
  }
  async function resizeNode(params) {
    const { nodeId, width, height } = params || {};
    if (!nodeId) {
      throw new Error("Missing nodeId parameter");
    }
    if (width === void 0 || height === void 0) {
      throw new Error("Missing width or height parameters");
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error(`Node not found with ID: ${nodeId}`);
    }
    if (!("resize" in node)) {
      throw new Error(`Node does not support resizing: ${nodeId}`);
    }
    node.resize(width, height);
    return {
      id: node.id,
      name: node.name,
      width: node.width,
      height: node.height
    };
  }
  async function deleteNode(params) {
    const { nodeId } = params || {};
    if (!nodeId) {
      throw new Error("Missing nodeId parameter");
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error(`Node not found with ID: ${nodeId}`);
    }
    const nodeInfo = {
      id: node.id,
      name: node.name,
      type: node.type
    };
    node.remove();
    return nodeInfo;
  }
  async function getStyles() {
    const styles = {
      colors: await figma.getLocalPaintStylesAsync(),
      texts: await figma.getLocalTextStylesAsync(),
      effects: await figma.getLocalEffectStylesAsync(),
      grids: await figma.getLocalGridStylesAsync()
    };
    return {
      colors: styles.colors.map((style) => ({
        id: style.id,
        name: style.name,
        key: style.key,
        paint: style.paints[0]
      })),
      texts: styles.texts.map((style) => ({
        id: style.id,
        name: style.name,
        key: style.key,
        fontSize: style.fontSize,
        fontName: style.fontName
      })),
      effects: styles.effects.map((style) => ({
        id: style.id,
        name: style.name,
        key: style.key
      })),
      grids: styles.grids.map((style) => ({
        id: style.id,
        name: style.name,
        key: style.key
      }))
    };
  }
  async function getLocalComponents(params) {
    const commandId = params && params.commandId || generateCommandId();
    const pages = figma.root.children;
    const totalPages = pages.length;
    await sendProgressUpdate(
      commandId,
      "get_local_components",
      "started",
      0,
      totalPages,
      0,
      "Starting component scan across " + totalPages + " pages...",
      null
    );
    var allComponents = [];
    for (var i = 0; i < totalPages; i++) {
      var page = pages[i];
      await page.loadAsync();
      var pageComponents = page.findAllWithCriteria({ types: ["COMPONENT"] });
      for (var j = 0; j < pageComponents.length; j++) {
        var component = pageComponents[j];
        allComponents.push({
          id: component.id,
          name: component.name,
          key: "key" in component ? component.key : null
        });
      }
      var progress = Math.round((i + 1) / totalPages * 100);
      await sendProgressUpdate(
        commandId,
        "get_local_components",
        "in_progress",
        progress,
        totalPages,
        i + 1,
        "Scanned " + page.name + ": " + pageComponents.length + " components (total so far: " + allComponents.length + ")",
        null
      );
    }
    await sendProgressUpdate(
      commandId,
      "get_local_components",
      "completed",
      100,
      totalPages,
      totalPages,
      "Found " + allComponents.length + " components across " + totalPages + " pages",
      null
    );
    return {
      count: allComponents.length,
      components: allComponents
    };
  }
  async function createComponentInstance(params) {
    const { componentKey, componentId, x = 0, y = 0, parentId } = params || {};
    if (!componentKey && !componentId) {
      throw new Error("Missing componentKey or componentId parameter. Use componentId for local components (from get_local_components), or componentKey for published library components.");
    }
    try {
      let component;
      if (componentId) {
        const node = await figma.getNodeByIdAsync(componentId);
        if (!node) {
          throw new Error(`Component node not found with id: ${componentId}`);
        }
        if (node.type !== "COMPONENT") {
          throw new Error(`Node ${componentId} is not a COMPONENT (got type: ${node.type}). Use get_local_components to find valid component IDs.`);
        }
        component = node;
      } else {
        component = await figma.importComponentByKeyAsync(componentKey);
      }
      const instance = component.createInstance();
      instance.x = x;
      instance.y = y;
      if (parentId) {
        const parent = await figma.getNodeByIdAsync(parentId);
        if (parent && "appendChild" in parent) {
          parent.appendChild(instance);
        } else {
          figma.currentPage.appendChild(instance);
        }
      } else {
        figma.currentPage.appendChild(instance);
      }
      const mainComponent = await instance.getMainComponentAsync();
      return {
        id: instance.id,
        name: instance.name,
        x: instance.x,
        y: instance.y,
        width: instance.width,
        height: instance.height,
        mainComponentId: mainComponent ? mainComponent.id : void 0
      };
    } catch (error) {
      throw new Error(`Error creating component instance: ${error.message}`);
    }
  }
  async function exportNodeAsImage(params) {
    const { nodeId, scale = 1 } = params || {};
    const format = "PNG";
    if (!nodeId) {
      throw new Error("Missing nodeId parameter");
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error(`Node not found with ID: ${nodeId}`);
    }
    if (!("exportAsync" in node)) {
      throw new Error(`Node does not support exporting: ${nodeId}`);
    }
    try {
      const settings = {
        format,
        constraint: { type: "SCALE", value: scale }
      };
      const bytes = await node.exportAsync(settings);
      let mimeType;
      switch (format) {
        case "PNG":
          mimeType = "image/png";
          break;
        case "JPG":
          mimeType = "image/jpeg";
          break;
        case "SVG":
          mimeType = "image/svg+xml";
          break;
        case "PDF":
          mimeType = "application/pdf";
          break;
        default:
          mimeType = "application/octet-stream";
      }
      const base64 = customBase64Encode(bytes);
      return {
        nodeId,
        format,
        scale,
        mimeType,
        imageData: base64
      };
    } catch (error) {
      throw new Error(`Error exporting node as image: ${error.message}`);
    }
  }
  function customBase64Encode(bytes) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let base64 = "";
    const byteLength = bytes.byteLength;
    const byteRemainder = byteLength % 3;
    const mainLength = byteLength - byteRemainder;
    let a, b, c, d;
    let chunk;
    for (let i = 0; i < mainLength; i = i + 3) {
      chunk = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
      a = (chunk & 16515072) >> 18;
      b = (chunk & 258048) >> 12;
      c = (chunk & 4032) >> 6;
      d = chunk & 63;
      base64 += chars[a] + chars[b] + chars[c] + chars[d];
    }
    if (byteRemainder === 1) {
      chunk = bytes[mainLength];
      a = (chunk & 252) >> 2;
      b = (chunk & 3) << 4;
      base64 += chars[a] + chars[b] + "==";
    } else if (byteRemainder === 2) {
      chunk = bytes[mainLength] << 8 | bytes[mainLength + 1];
      a = (chunk & 64512) >> 10;
      b = (chunk & 1008) >> 4;
      c = (chunk & 15) << 2;
      base64 += chars[a] + chars[b] + chars[c] + "=";
    }
    return base64;
  }
  async function setCornerRadius(params) {
    const { nodeId, radius, corners } = params || {};
    if (!nodeId) {
      throw new Error("Missing nodeId parameter");
    }
    if (radius === void 0) {
      throw new Error("Missing radius parameter");
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error(`Node not found with ID: ${nodeId}`);
    }
    if (!("cornerRadius" in node)) {
      throw new Error(`Node does not support corner radius: ${nodeId}`);
    }
    if (corners && Array.isArray(corners) && corners.length === 4) {
      if ("topLeftRadius" in node) {
        if (corners[0]) node.topLeftRadius = radius;
        if (corners[1]) node.topRightRadius = radius;
        if (corners[2]) node.bottomRightRadius = radius;
        if (corners[3]) node.bottomLeftRadius = radius;
      } else {
        node.cornerRadius = radius;
      }
    } else {
      node.cornerRadius = radius;
    }
    return {
      id: node.id,
      name: node.name,
      cornerRadius: "cornerRadius" in node ? node.cornerRadius : void 0,
      topLeftRadius: "topLeftRadius" in node ? node.topLeftRadius : void 0,
      topRightRadius: "topRightRadius" in node ? node.topRightRadius : void 0,
      bottomRightRadius: "bottomRightRadius" in node ? node.bottomRightRadius : void 0,
      bottomLeftRadius: "bottomLeftRadius" in node ? node.bottomLeftRadius : void 0
    };
  }
  async function setTextContent(params) {
    const { nodeId, text } = params || {};
    if (!nodeId) {
      throw new Error("Missing nodeId parameter");
    }
    if (text === void 0) {
      throw new Error("Missing text parameter");
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error(`Node not found with ID: ${nodeId}`);
    }
    if (node.type !== "TEXT") {
      throw new Error(`Node is not a text node: ${nodeId}`);
    }
    try {
      await figma.loadFontAsync(node.fontName);
      await setCharacters(node, text);
      return {
        id: node.id,
        name: node.name,
        characters: node.characters,
        fontName: node.fontName
      };
    } catch (error) {
      throw new Error(`Error setting text content: ${error.message}`);
    }
  }
  function uniqBy(arr, predicate) {
    const cb = typeof predicate === "function" ? predicate : (o) => o[predicate];
    return [
      ...arr.reduce((map, item) => {
        const key = item === null || item === void 0 ? item : cb(item);
        map.has(key) || map.set(key, item);
        return map;
      }, /* @__PURE__ */ new Map()).values()
    ];
  }
  const setCharacters = async (node, characters, options) => {
    const fallbackFont = options && options.fallbackFont || {
      family: "Inter",
      style: "Regular"
    };
    try {
      if (node.fontName === figma.mixed) {
        if (options && options.smartStrategy === "prevail") {
          const fontHashTree = {};
          for (let i = 1; i < node.characters.length; i++) {
            const charFont = node.getRangeFontName(i - 1, i);
            const key = `${charFont.family}::${charFont.style}`;
            fontHashTree[key] = fontHashTree[key] ? fontHashTree[key] + 1 : 1;
          }
          const prevailedTreeItem = Object.entries(fontHashTree).sort(
            (a, b) => b[1] - a[1]
          )[0];
          const [family, style] = prevailedTreeItem[0].split("::");
          const prevailedFont = {
            family,
            style
          };
          await figma.loadFontAsync(prevailedFont);
          node.fontName = prevailedFont;
        } else if (options && options.smartStrategy === "strict") {
          return setCharactersWithStrictMatchFont(node, characters, fallbackFont);
        } else if (options && options.smartStrategy === "experimental") {
          return setCharactersWithSmartMatchFont(node, characters, fallbackFont);
        } else {
          const firstCharFont = node.getRangeFontName(0, 1);
          await figma.loadFontAsync(firstCharFont);
          node.fontName = firstCharFont;
        }
      } else {
        await figma.loadFontAsync({
          family: node.fontName.family,
          style: node.fontName.style
        });
      }
    } catch (err) {
      console.warn(
        `Failed to load "${node.fontName["family"]} ${node.fontName["style"]}" font and replaced with fallback "${fallbackFont.family} ${fallbackFont.style}"`,
        err
      );
      await figma.loadFontAsync(fallbackFont);
      node.fontName = fallbackFont;
    }
    try {
      node.characters = characters;
      return true;
    } catch (err) {
      console.warn(`Failed to set characters. Skipped.`, err);
      return false;
    }
  };
  const setCharactersWithStrictMatchFont = async (node, characters, fallbackFont) => {
    const fontHashTree = {};
    for (let i = 1; i < node.characters.length; i++) {
      const startIdx = i - 1;
      const startCharFont = node.getRangeFontName(startIdx, i);
      const startCharFontVal = `${startCharFont.family}::${startCharFont.style}`;
      while (i < node.characters.length) {
        i++;
        const charFont = node.getRangeFontName(i - 1, i);
        if (startCharFontVal !== `${charFont.family}::${charFont.style}`) {
          break;
        }
      }
      fontHashTree[`${startIdx}_${i}`] = startCharFontVal;
    }
    await figma.loadFontAsync(fallbackFont);
    node.fontName = fallbackFont;
    node.characters = characters;
    console.log(fontHashTree);
    await Promise.all(
      Object.keys(fontHashTree).map(async (range) => {
        console.log(range, fontHashTree[range]);
        const [start, end] = range.split("_");
        const [family, style] = fontHashTree[range].split("::");
        const matchedFont = {
          family,
          style
        };
        await figma.loadFontAsync(matchedFont);
        return node.setRangeFontName(Number(start), Number(end), matchedFont);
      })
    );
    return true;
  };
  const getDelimiterPos = (str, delimiter, startIdx = 0, endIdx = str.length) => {
    const indices = [];
    let temp = startIdx;
    for (let i = startIdx; i < endIdx; i++) {
      if (str[i] === delimiter && i + startIdx !== endIdx && temp !== i + startIdx) {
        indices.push([temp, i + startIdx]);
        temp = i + startIdx + 1;
      }
    }
    temp !== endIdx && indices.push([temp, endIdx]);
    return indices.filter(Boolean);
  };
  const buildLinearOrder = (node) => {
    const fontTree = [];
    const newLinesPos = getDelimiterPos(node.characters, "\n");
    newLinesPos.forEach(([newLinesRangeStart, newLinesRangeEnd], n) => {
      const newLinesRangeFont = node.getRangeFontName(
        newLinesRangeStart,
        newLinesRangeEnd
      );
      if (newLinesRangeFont === figma.mixed) {
        const spacesPos = getDelimiterPos(
          node.characters,
          " ",
          newLinesRangeStart,
          newLinesRangeEnd
        );
        spacesPos.forEach(([spacesRangeStart, spacesRangeEnd], s) => {
          const spacesRangeFont = node.getRangeFontName(
            spacesRangeStart,
            spacesRangeEnd
          );
          if (spacesRangeFont === figma.mixed) {
            const spacesRangeFont2 = node.getRangeFontName(
              spacesRangeStart,
              spacesRangeStart[0]
            );
            fontTree.push({
              start: spacesRangeStart,
              delimiter: " ",
              family: spacesRangeFont2.family,
              style: spacesRangeFont2.style
            });
          } else {
            fontTree.push({
              start: spacesRangeStart,
              delimiter: " ",
              family: spacesRangeFont.family,
              style: spacesRangeFont.style
            });
          }
        });
      } else {
        fontTree.push({
          start: newLinesRangeStart,
          delimiter: "\n",
          family: newLinesRangeFont.family,
          style: newLinesRangeFont.style
        });
      }
    });
    return fontTree.sort((a, b) => +a.start - +b.start).map(({ family, style, delimiter }) => ({ family, style, delimiter }));
  };
  const setCharactersWithSmartMatchFont = async (node, characters, fallbackFont) => {
    const rangeTree = buildLinearOrder(node);
    const fontsToLoad = uniqBy(
      rangeTree,
      ({ family, style }) => `${family}::${style}`
    ).map(({ family, style }) => ({
      family,
      style
    }));
    await Promise.all([...fontsToLoad, fallbackFont].map(figma.loadFontAsync));
    node.fontName = fallbackFont;
    node.characters = characters;
    let prevPos = 0;
    rangeTree.forEach(({ family, style, delimiter }) => {
      if (prevPos < node.characters.length) {
        const delimeterPos = node.characters.indexOf(delimiter, prevPos);
        const endPos = delimeterPos > prevPos ? delimeterPos : node.characters.length;
        const matchedFont = {
          family,
          style
        };
        node.setRangeFontName(prevPos, endPos, matchedFont);
        prevPos = endPos + 1;
      }
    });
    return true;
  };
  async function cloneNode(params) {
    const { nodeId, x, y } = params || {};
    if (!nodeId) {
      throw new Error("Missing nodeId parameter");
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error(`Node not found with ID: ${nodeId}`);
    }
    const clone = node.clone();
    if (x !== void 0 && y !== void 0) {
      if (!("x" in clone) || !("y" in clone)) {
        throw new Error(`Cloned node does not support position: ${nodeId}`);
      }
      clone.x = x;
      clone.y = y;
    }
    if (node.parent) {
      node.parent.appendChild(clone);
    } else {
      figma.currentPage.appendChild(clone);
    }
    return {
      id: clone.id,
      name: clone.name,
      x: "x" in clone ? clone.x : void 0,
      y: "y" in clone ? clone.y : void 0,
      width: "width" in clone ? clone.width : void 0,
      height: "height" in clone ? clone.height : void 0
    };
  }
  async function scanTextNodes(params) {
    console.log(`Starting to scan text nodes from node ID: ${params.nodeId}`);
    const {
      nodeId,
      useChunking = true,
      chunkSize = 10,
      commandId = generateCommandId()
    } = params || {};
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      console.error(`Node with ID ${nodeId} not found`);
      sendProgressUpdate(
        commandId,
        "scan_text_nodes",
        "error",
        0,
        0,
        0,
        `Node with ID ${nodeId} not found`,
        { error: `Node not found: ${nodeId}` }
      );
      throw new Error(`Node with ID ${nodeId} not found`);
    }
    if (!useChunking) {
      const textNodes = [];
      try {
        sendProgressUpdate(
          commandId,
          "scan_text_nodes",
          "started",
          0,
          1,
          // Not known yet how many nodes there are
          0,
          `Starting scan of node "${node.name || nodeId}" without chunking`,
          null
        );
        await findTextNodes(node, [], 0, textNodes);
        sendProgressUpdate(
          commandId,
          "scan_text_nodes",
          "completed",
          100,
          textNodes.length,
          textNodes.length,
          `Scan complete. Found ${textNodes.length} text nodes.`,
          { textNodes }
        );
        return {
          success: true,
          message: `Scanned ${textNodes.length} text nodes.`,
          count: textNodes.length,
          textNodes,
          commandId
        };
      } catch (error) {
        console.error("Error scanning text nodes:", error);
        sendProgressUpdate(
          commandId,
          "scan_text_nodes",
          "error",
          0,
          0,
          0,
          `Error scanning text nodes: ${error.message}`,
          { error: error.message }
        );
        throw new Error(`Error scanning text nodes: ${error.message}`);
      }
    }
    console.log(`Using chunked scanning with chunk size: ${chunkSize}`);
    const nodesToProcess = [];
    sendProgressUpdate(
      commandId,
      "scan_text_nodes",
      "started",
      0,
      0,
      // Not known yet how many nodes there are
      0,
      `Starting chunked scan of node "${node.name || nodeId}"`,
      { chunkSize }
    );
    await collectNodesToProcess(node, [], 0, nodesToProcess);
    const totalNodes = nodesToProcess.length;
    console.log(`Found ${totalNodes} total nodes to process`);
    const totalChunks = Math.ceil(totalNodes / chunkSize);
    console.log(`Will process in ${totalChunks} chunks`);
    sendProgressUpdate(
      commandId,
      "scan_text_nodes",
      "in_progress",
      5,
      // 5% progress for collection phase
      totalNodes,
      0,
      `Found ${totalNodes} nodes to scan. Will process in ${totalChunks} chunks.`,
      {
        totalNodes,
        totalChunks,
        chunkSize
      }
    );
    const allTextNodes = [];
    let processedNodes = 0;
    let chunksProcessed = 0;
    for (let i = 0; i < totalNodes; i += chunkSize) {
      const chunkEnd = Math.min(i + chunkSize, totalNodes);
      console.log(
        `Processing chunk ${chunksProcessed + 1}/${totalChunks} (nodes ${i} to ${chunkEnd - 1})`
      );
      sendProgressUpdate(
        commandId,
        "scan_text_nodes",
        "in_progress",
        Math.round(5 + chunksProcessed / totalChunks * 90),
        // 5-95% for processing
        totalNodes,
        processedNodes,
        `Processing chunk ${chunksProcessed + 1}/${totalChunks}`,
        {
          currentChunk: chunksProcessed + 1,
          totalChunks,
          textNodesFound: allTextNodes.length
        }
      );
      const chunkNodes = nodesToProcess.slice(i, chunkEnd);
      const chunkTextNodes = [];
      for (const nodeInfo of chunkNodes) {
        if (nodeInfo.node.type === "TEXT") {
          try {
            const textNodeInfo = await processTextNode(
              nodeInfo.node,
              nodeInfo.parentPath,
              nodeInfo.depth
            );
            if (textNodeInfo) {
              chunkTextNodes.push(textNodeInfo);
            }
          } catch (error) {
            console.error(`Error processing text node: ${error.message}`);
          }
        }
        await delay(5);
      }
      allTextNodes.push(...chunkTextNodes);
      processedNodes += chunkNodes.length;
      chunksProcessed++;
      sendProgressUpdate(
        commandId,
        "scan_text_nodes",
        "in_progress",
        Math.round(5 + chunksProcessed / totalChunks * 90),
        // 5-95% for processing
        totalNodes,
        processedNodes,
        `Processed chunk ${chunksProcessed}/${totalChunks}. Found ${allTextNodes.length} text nodes so far.`,
        {
          currentChunk: chunksProcessed,
          totalChunks,
          processedNodes,
          textNodesFound: allTextNodes.length,
          chunkResult: chunkTextNodes
        }
      );
      if (i + chunkSize < totalNodes) {
        await delay(50);
      }
    }
    sendProgressUpdate(
      commandId,
      "scan_text_nodes",
      "completed",
      100,
      totalNodes,
      processedNodes,
      `Scan complete. Found ${allTextNodes.length} text nodes.`,
      {
        textNodes: allTextNodes,
        processedNodes,
        chunks: chunksProcessed
      }
    );
    return {
      success: true,
      message: `Chunked scan complete. Found ${allTextNodes.length} text nodes.`,
      totalNodes: allTextNodes.length,
      processedNodes,
      chunks: chunksProcessed,
      textNodes: allTextNodes,
      commandId
    };
  }
  async function collectNodesToProcess(node, parentPath = [], depth = 0, nodesToProcess = []) {
    if (node.visible === false) return;
    const nodePath = [...parentPath, node.name || `Unnamed ${node.type}`];
    nodesToProcess.push({
      node,
      parentPath: nodePath,
      depth
    });
    if ("children" in node) {
      for (const child of node.children) {
        await collectNodesToProcess(child, nodePath, depth + 1, nodesToProcess);
      }
    }
  }
  async function processTextNode(node, parentPath, depth) {
    if (node.type !== "TEXT") return null;
    try {
      let fontFamily = "";
      let fontStyle = "";
      if (node.fontName) {
        if (typeof node.fontName === "object") {
          if ("family" in node.fontName) fontFamily = node.fontName.family;
          if ("style" in node.fontName) fontStyle = node.fontName.style;
        }
      }
      const safeTextNode = {
        id: node.id,
        name: node.name || "Text",
        type: node.type,
        characters: node.characters,
        fontSize: typeof node.fontSize === "number" ? node.fontSize : 0,
        fontFamily,
        fontStyle,
        x: typeof node.x === "number" ? node.x : 0,
        y: typeof node.y === "number" ? node.y : 0,
        width: typeof node.width === "number" ? node.width : 0,
        height: typeof node.height === "number" ? node.height : 0,
        path: parentPath.join(" > "),
        depth
      };
      try {
        const originalFills = JSON.parse(JSON.stringify(node.fills));
        node.fills = [
          {
            type: "SOLID",
            color: { r: 1, g: 0.5, b: 0 },
            opacity: 0.3
          }
        ];
        await delay(100);
        try {
          node.fills = originalFills;
        } catch (err) {
          console.error("Error resetting fills:", err);
        }
      } catch (highlightErr) {
        console.error("Error highlighting text node:", highlightErr);
      }
      return safeTextNode;
    } catch (nodeErr) {
      console.error("Error processing text node:", nodeErr);
      return null;
    }
  }
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  async function findTextNodes(node, parentPath = [], depth = 0, textNodes = []) {
    if (node.visible === false) return;
    const nodePath = [...parentPath, node.name || `Unnamed ${node.type}`];
    if (node.type === "TEXT") {
      try {
        let fontFamily = "";
        let fontStyle = "";
        if (node.fontName) {
          if (typeof node.fontName === "object") {
            if ("family" in node.fontName) fontFamily = node.fontName.family;
            if ("style" in node.fontName) fontStyle = node.fontName.style;
          }
        }
        const safeTextNode = {
          id: node.id,
          name: node.name || "Text",
          type: node.type,
          characters: node.characters,
          fontSize: typeof node.fontSize === "number" ? node.fontSize : 0,
          fontFamily,
          fontStyle,
          x: typeof node.x === "number" ? node.x : 0,
          y: typeof node.y === "number" ? node.y : 0,
          width: typeof node.width === "number" ? node.width : 0,
          height: typeof node.height === "number" ? node.height : 0,
          path: nodePath.join(" > "),
          depth
        };
        try {
          const originalFills = JSON.parse(JSON.stringify(node.fills));
          node.fills = [
            {
              type: "SOLID",
              color: { r: 1, g: 0.5, b: 0 },
              opacity: 0.3
            }
          ];
          await delay(500);
          try {
            node.fills = originalFills;
          } catch (err) {
            console.error("Error resetting fills:", err);
          }
        } catch (highlightErr) {
          console.error("Error highlighting text node:", highlightErr);
        }
        textNodes.push(safeTextNode);
      } catch (nodeErr) {
        console.error("Error processing text node:", nodeErr);
      }
    }
    if ("children" in node) {
      for (const child of node.children) {
        await findTextNodes(child, nodePath, depth + 1, textNodes);
      }
    }
  }
  async function setMultipleTextContents(params) {
    const { nodeId, text } = params || {};
    const commandId = params.commandId || generateCommandId();
    if (!nodeId || !text || !Array.isArray(text)) {
      const errorMsg = "Missing required parameters: nodeId and text array";
      sendProgressUpdate(
        commandId,
        "set_multiple_text_contents",
        "error",
        0,
        0,
        0,
        errorMsg,
        { error: errorMsg }
      );
      throw new Error(errorMsg);
    }
    console.log(
      `Starting text replacement for node: ${nodeId} with ${text.length} text replacements`
    );
    sendProgressUpdate(
      commandId,
      "set_multiple_text_contents",
      "started",
      0,
      text.length,
      0,
      `Starting text replacement for ${text.length} nodes`,
      { totalReplacements: text.length }
    );
    const results = [];
    let successCount = 0;
    let failureCount = 0;
    const CHUNK_SIZE = 5;
    const chunks = [];
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
      chunks.push(text.slice(i, i + CHUNK_SIZE));
    }
    console.log(`Split ${text.length} replacements into ${chunks.length} chunks`);
    sendProgressUpdate(
      commandId,
      "set_multiple_text_contents",
      "in_progress",
      5,
      // 5% progress for planning phase
      text.length,
      0,
      `Preparing to replace text in ${text.length} nodes using ${chunks.length} chunks`,
      {
        totalReplacements: text.length,
        chunks: chunks.length,
        chunkSize: CHUNK_SIZE
      }
    );
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex];
      console.log(
        `Processing chunk ${chunkIndex + 1}/${chunks.length} with ${chunk.length} replacements`
      );
      sendProgressUpdate(
        commandId,
        "set_multiple_text_contents",
        "in_progress",
        Math.round(5 + chunkIndex / chunks.length * 90),
        // 5-95% for processing
        text.length,
        successCount + failureCount,
        `Processing text replacements chunk ${chunkIndex + 1}/${chunks.length}`,
        {
          currentChunk: chunkIndex + 1,
          totalChunks: chunks.length,
          successCount,
          failureCount
        }
      );
      const chunkPromises = chunk.map(async (replacement) => {
        if (!replacement.nodeId || replacement.text === void 0) {
          console.error(`Missing nodeId or text for replacement`);
          return {
            success: false,
            nodeId: replacement.nodeId || "unknown",
            error: "Missing nodeId or text in replacement entry"
          };
        }
        try {
          console.log(
            `Attempting to replace text in node: ${replacement.nodeId}`
          );
          const textNode = await figma.getNodeByIdAsync(replacement.nodeId);
          if (!textNode) {
            console.error(`Text node not found: ${replacement.nodeId}`);
            return {
              success: false,
              nodeId: replacement.nodeId,
              error: `Node not found: ${replacement.nodeId}`
            };
          }
          if (textNode.type !== "TEXT") {
            console.error(
              `Node is not a text node: ${replacement.nodeId} (type: ${textNode.type})`
            );
            return {
              success: false,
              nodeId: replacement.nodeId,
              error: `Node is not a text node: ${replacement.nodeId} (type: ${textNode.type})`
            };
          }
          const originalText = textNode.characters;
          console.log(`Original text: "${originalText}"`);
          console.log(`Will translate to: "${replacement.text}"`);
          let originalFills;
          try {
            originalFills = JSON.parse(JSON.stringify(textNode.fills));
            textNode.fills = [
              {
                type: "SOLID",
                color: { r: 1, g: 0.5, b: 0 },
                opacity: 0.3
              }
            ];
          } catch (highlightErr) {
            console.error(
              `Error highlighting text node: ${highlightErr.message}`
            );
          }
          await setTextContent({
            nodeId: replacement.nodeId,
            text: replacement.text
          });
          if (originalFills) {
            try {
              await delay(500);
              textNode.fills = originalFills;
            } catch (restoreErr) {
              console.error(`Error restoring fills: ${restoreErr.message}`);
            }
          }
          console.log(
            `Successfully replaced text in node: ${replacement.nodeId}`
          );
          return {
            success: true,
            nodeId: replacement.nodeId,
            originalText,
            translatedText: replacement.text
          };
        } catch (error) {
          console.error(
            `Error replacing text in node ${replacement.nodeId}: ${error.message}`
          );
          return {
            success: false,
            nodeId: replacement.nodeId,
            error: `Error applying replacement: ${error.message}`
          };
        }
      });
      const chunkResults = await Promise.all(chunkPromises);
      chunkResults.forEach((result) => {
        if (result.success) {
          successCount++;
        } else {
          failureCount++;
        }
        results.push(result);
      });
      sendProgressUpdate(
        commandId,
        "set_multiple_text_contents",
        "in_progress",
        Math.round(5 + (chunkIndex + 1) / chunks.length * 90),
        // 5-95% for processing
        text.length,
        successCount + failureCount,
        `Completed chunk ${chunkIndex + 1}/${chunks.length}. ${successCount} successful, ${failureCount} failed so far.`,
        {
          currentChunk: chunkIndex + 1,
          totalChunks: chunks.length,
          successCount,
          failureCount,
          chunkResults
        }
      );
      if (chunkIndex < chunks.length - 1) {
        console.log("Pausing between chunks to avoid overloading Figma...");
        await delay(1e3);
      }
    }
    console.log(
      `Replacement complete: ${successCount} successful, ${failureCount} failed`
    );
    sendProgressUpdate(
      commandId,
      "set_multiple_text_contents",
      "completed",
      100,
      text.length,
      successCount + failureCount,
      `Text replacement complete: ${successCount} successful, ${failureCount} failed`,
      {
        totalReplacements: text.length,
        replacementsApplied: successCount,
        replacementsFailed: failureCount,
        completedInChunks: chunks.length,
        results
      }
    );
    return {
      success: successCount > 0,
      nodeId,
      replacementsApplied: successCount,
      replacementsFailed: failureCount,
      totalReplacements: text.length,
      results,
      completedInChunks: chunks.length,
      commandId
    };
  }
  function generateCommandId() {
    return "cmd_" + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }
  async function getAnnotations(params) {
    try {
      const { nodeId, includeCategories = true } = params;
      let categoriesMap = {};
      if (includeCategories) {
        const categories = await figma.annotations.getAnnotationCategoriesAsync();
        categoriesMap = categories.reduce((map, category) => {
          map[category.id] = {
            id: category.id,
            label: category.label,
            color: category.color,
            isPreset: category.isPreset
          };
          return map;
        }, {});
      }
      if (nodeId) {
        const node = await figma.getNodeByIdAsync(nodeId);
        if (!node) {
          throw new Error(`Node not found: ${nodeId}`);
        }
        if (!("annotations" in node)) {
          throw new Error(`Node type ${node.type} does not support annotations`);
        }
        const mergedAnnotations = [];
        const collect = async (n) => {
          if ("annotations" in n && n.annotations && n.annotations.length > 0) {
            for (const a of n.annotations) {
              mergedAnnotations.push({ nodeId: n.id, annotation: a });
            }
          }
          if ("children" in n) {
            for (const child of n.children) {
              await collect(child);
            }
          }
        };
        await collect(node);
        const result = {
          nodeId: node.id,
          name: node.name,
          annotations: mergedAnnotations
        };
        if (includeCategories) {
          result.categories = Object.values(categoriesMap);
        }
        return result;
      } else {
        const annotations = [];
        const processNode = async (node) => {
          if ("annotations" in node && node.annotations && node.annotations.length > 0) {
            annotations.push({
              nodeId: node.id,
              name: node.name,
              annotations: node.annotations
            });
          }
          if ("children" in node) {
            for (const child of node.children) {
              await processNode(child);
            }
          }
        };
        await processNode(figma.currentPage);
        const result = {
          annotatedNodes: annotations
        };
        if (includeCategories) {
          result.categories = Object.values(categoriesMap);
        }
        return result;
      }
    } catch (error) {
      console.error("Error in getAnnotations:", error);
      throw error;
    }
  }
  async function setAnnotation(params) {
    try {
      console.log("=== setAnnotation Debug Start ===");
      console.log("Input params:", JSON.stringify(params, null, 2));
      const { nodeId, annotationId, labelMarkdown, categoryId, properties } = params;
      if (!nodeId) {
        console.error("Validation failed: Missing nodeId");
        return { success: false, error: "Missing nodeId" };
      }
      if (!labelMarkdown) {
        console.error("Validation failed: Missing labelMarkdown");
        return { success: false, error: "Missing labelMarkdown" };
      }
      console.log("Attempting to get node:", nodeId);
      const node = await figma.getNodeByIdAsync(nodeId);
      console.log("Node lookup result:", {
        id: nodeId,
        found: !!node,
        type: node ? node.type : void 0,
        name: node ? node.name : void 0,
        hasAnnotations: node ? "annotations" in node : false
      });
      if (!node) {
        console.error("Node lookup failed:", nodeId);
        return { success: false, error: `Node not found: ${nodeId}` };
      }
      if (!("annotations" in node)) {
        console.error("Node annotation support check failed:", {
          nodeType: node.type,
          nodeId: node.id
        });
        return {
          success: false,
          error: `Node type ${node.type} does not support annotations`
        };
      }
      const newAnnotation = {
        labelMarkdown
      };
      if (categoryId) {
        console.log("Adding categoryId to annotation:", categoryId);
        newAnnotation.categoryId = categoryId;
      }
      if (properties && Array.isArray(properties) && properties.length > 0) {
        console.log(
          "Adding properties to annotation:",
          JSON.stringify(properties, null, 2)
        );
        newAnnotation.properties = properties;
      }
      console.log("Current node annotations:", node.annotations);
      console.log(
        "Setting new annotation:",
        JSON.stringify(newAnnotation, null, 2)
      );
      node.annotations = [newAnnotation];
      console.log("Updated node annotations:", node.annotations);
      console.log("=== setAnnotation Debug End ===");
      return {
        success: true,
        nodeId: node.id,
        name: node.name,
        annotations: node.annotations
      };
    } catch (error) {
      console.error("=== setAnnotation Error ===");
      console.error("Error details:", {
        message: error.message,
        stack: error.stack,
        params: JSON.stringify(params, null, 2)
      });
      return { success: false, error: error.message };
    }
  }
  async function scanNodesByTypes(params) {
    console.log(`Starting to scan nodes by types from node ID: ${params.nodeId}`);
    const { nodeId, types = [] } = params || {};
    if (!types || types.length === 0) {
      throw new Error("No types specified to search for");
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error(`Node with ID ${nodeId} not found`);
    }
    const matchingNodes = [];
    const commandId = generateCommandId();
    sendProgressUpdate(
      commandId,
      "scan_nodes_by_types",
      "started",
      0,
      1,
      0,
      `Starting scan of node "${node.name || nodeId}" for types: ${types.join(
        ", "
      )}`,
      null
    );
    await findNodesByTypes(node, types, matchingNodes);
    sendProgressUpdate(
      commandId,
      "scan_nodes_by_types",
      "completed",
      100,
      matchingNodes.length,
      matchingNodes.length,
      `Scan complete. Found ${matchingNodes.length} matching nodes.`,
      { matchingNodes }
    );
    return {
      success: true,
      message: `Found ${matchingNodes.length} matching nodes.`,
      count: matchingNodes.length,
      matchingNodes,
      searchedTypes: types
    };
  }
  async function findNodesByTypes(node, types, matchingNodes = []) {
    if (node.visible === false) return;
    if (types.includes(node.type)) {
      matchingNodes.push({
        id: node.id,
        name: node.name || `Unnamed ${node.type}`,
        type: node.type,
        // Basic bounding box info
        bbox: {
          x: typeof node.x === "number" ? node.x : 0,
          y: typeof node.y === "number" ? node.y : 0,
          width: typeof node.width === "number" ? node.width : 0,
          height: typeof node.height === "number" ? node.height : 0
        }
      });
    }
    if ("children" in node) {
      for (const child of node.children) {
        await findNodesByTypes(child, types, matchingNodes);
      }
    }
  }
  async function setMultipleAnnotations(params) {
    console.log("=== setMultipleAnnotations Debug Start ===");
    console.log("Input params:", JSON.stringify(params, null, 2));
    const { nodeId, annotations } = params;
    if (!annotations || annotations.length === 0) {
      console.error("Validation failed: No annotations provided");
      return { success: false, error: "No annotations provided" };
    }
    console.log(
      `Processing ${annotations.length} annotations for node ${nodeId}`
    );
    const results = [];
    let successCount = 0;
    let failureCount = 0;
    for (let i = 0; i < annotations.length; i++) {
      const annotation = annotations[i];
      console.log(
        `
Processing annotation ${i + 1}/${annotations.length}:`,
        JSON.stringify(annotation, null, 2)
      );
      try {
        console.log("Calling setAnnotation with params:", {
          nodeId: annotation.nodeId,
          labelMarkdown: annotation.labelMarkdown,
          categoryId: annotation.categoryId,
          properties: annotation.properties
        });
        const result = await setAnnotation({
          nodeId: annotation.nodeId,
          labelMarkdown: annotation.labelMarkdown,
          categoryId: annotation.categoryId,
          properties: annotation.properties
        });
        console.log("setAnnotation result:", JSON.stringify(result, null, 2));
        if (result.success) {
          successCount++;
          results.push({ success: true, nodeId: annotation.nodeId });
          console.log(`\u2713 Annotation ${i + 1} applied successfully`);
        } else {
          failureCount++;
          results.push({
            success: false,
            nodeId: annotation.nodeId,
            error: result.error
          });
          console.error(`\u2717 Annotation ${i + 1} failed:`, result.error);
        }
      } catch (error) {
        failureCount++;
        const errorResult = {
          success: false,
          nodeId: annotation.nodeId,
          error: error.message
        };
        results.push(errorResult);
        console.error(`\u2717 Annotation ${i + 1} failed with error:`, error);
        console.error("Error details:", {
          message: error.message,
          stack: error.stack
        });
      }
    }
    const summary = {
      success: successCount > 0,
      annotationsApplied: successCount,
      annotationsFailed: failureCount,
      totalAnnotations: annotations.length,
      results
    };
    console.log("\n=== setMultipleAnnotations Summary ===");
    console.log(JSON.stringify(summary, null, 2));
    console.log("=== setMultipleAnnotations Debug End ===");
    return summary;
  }
  async function deleteMultipleNodes(params) {
    const { nodeIds } = params || {};
    const commandId = generateCommandId();
    if (!nodeIds || !Array.isArray(nodeIds) || nodeIds.length === 0) {
      const errorMsg = "Missing or invalid nodeIds parameter";
      sendProgressUpdate(
        commandId,
        "delete_multiple_nodes",
        "error",
        0,
        0,
        0,
        errorMsg,
        { error: errorMsg }
      );
      throw new Error(errorMsg);
    }
    console.log(`Starting deletion of ${nodeIds.length} nodes`);
    sendProgressUpdate(
      commandId,
      "delete_multiple_nodes",
      "started",
      0,
      nodeIds.length,
      0,
      `Starting deletion of ${nodeIds.length} nodes`,
      { totalNodes: nodeIds.length }
    );
    const results = [];
    let successCount = 0;
    let failureCount = 0;
    const CHUNK_SIZE = 5;
    const chunks = [];
    for (let i = 0; i < nodeIds.length; i += CHUNK_SIZE) {
      chunks.push(nodeIds.slice(i, i + CHUNK_SIZE));
    }
    console.log(`Split ${nodeIds.length} deletions into ${chunks.length} chunks`);
    sendProgressUpdate(
      commandId,
      "delete_multiple_nodes",
      "in_progress",
      5,
      nodeIds.length,
      0,
      `Preparing to delete ${nodeIds.length} nodes using ${chunks.length} chunks`,
      {
        totalNodes: nodeIds.length,
        chunks: chunks.length,
        chunkSize: CHUNK_SIZE
      }
    );
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex];
      console.log(
        `Processing chunk ${chunkIndex + 1}/${chunks.length} with ${chunk.length} nodes`
      );
      sendProgressUpdate(
        commandId,
        "delete_multiple_nodes",
        "in_progress",
        Math.round(5 + chunkIndex / chunks.length * 90),
        nodeIds.length,
        successCount + failureCount,
        `Processing deletion chunk ${chunkIndex + 1}/${chunks.length}`,
        {
          currentChunk: chunkIndex + 1,
          totalChunks: chunks.length,
          successCount,
          failureCount
        }
      );
      const chunkPromises = chunk.map(async (nodeId) => {
        try {
          const node = await figma.getNodeByIdAsync(nodeId);
          if (!node) {
            console.error(`Node not found: ${nodeId}`);
            return {
              success: false,
              nodeId,
              error: `Node not found: ${nodeId}`
            };
          }
          const nodeInfo = {
            id: node.id,
            name: node.name,
            type: node.type
          };
          node.remove();
          console.log(`Successfully deleted node: ${nodeId}`);
          return {
            success: true,
            nodeId,
            nodeInfo
          };
        } catch (error) {
          console.error(`Error deleting node ${nodeId}: ${error.message}`);
          return {
            success: false,
            nodeId,
            error: error.message
          };
        }
      });
      const chunkResults = await Promise.all(chunkPromises);
      chunkResults.forEach((result) => {
        if (result.success) {
          successCount++;
        } else {
          failureCount++;
        }
        results.push(result);
      });
      sendProgressUpdate(
        commandId,
        "delete_multiple_nodes",
        "in_progress",
        Math.round(5 + (chunkIndex + 1) / chunks.length * 90),
        nodeIds.length,
        successCount + failureCount,
        `Completed chunk ${chunkIndex + 1}/${chunks.length}. ${successCount} successful, ${failureCount} failed so far.`,
        {
          currentChunk: chunkIndex + 1,
          totalChunks: chunks.length,
          successCount,
          failureCount,
          chunkResults
        }
      );
      if (chunkIndex < chunks.length - 1) {
        console.log("Pausing between chunks...");
        await delay(1e3);
      }
    }
    console.log(
      `Deletion complete: ${successCount} successful, ${failureCount} failed`
    );
    sendProgressUpdate(
      commandId,
      "delete_multiple_nodes",
      "completed",
      100,
      nodeIds.length,
      successCount + failureCount,
      `Node deletion complete: ${successCount} successful, ${failureCount} failed`,
      {
        totalNodes: nodeIds.length,
        nodesDeleted: successCount,
        nodesFailed: failureCount,
        completedInChunks: chunks.length,
        results
      }
    );
    return {
      success: successCount > 0,
      nodesDeleted: successCount,
      nodesFailed: failureCount,
      totalNodes: nodeIds.length,
      results,
      completedInChunks: chunks.length,
      commandId
    };
  }
  async function getInstanceOverrides(instanceNode = null) {
    console.log("=== getInstanceOverrides called ===");
    let sourceInstance = null;
    if (instanceNode) {
      console.log("Using provided instance node");
      if (instanceNode.type !== "INSTANCE") {
        console.error("Provided node is not an instance");
        figma.notify("Provided node is not a component instance");
        return { success: false, message: "Provided node is not a component instance" };
      }
      sourceInstance = instanceNode;
    } else {
      console.log("No node provided, using current selection");
      const selection = figma.currentPage.selection;
      if (selection.length === 0) {
        console.log("No nodes selected");
        figma.notify("Please select at least one instance");
        return { success: false, message: "No nodes selected" };
      }
      const instances = selection.filter((node) => node.type === "INSTANCE");
      if (instances.length === 0) {
        console.log("No instances found in selection");
        figma.notify("Please select at least one component instance");
        return { success: false, message: "No instances found in selection" };
      }
      sourceInstance = instances[0];
    }
    try {
      console.log(`Getting instance information:`);
      console.log(sourceInstance);
      const overrides = sourceInstance.overrides || [];
      console.log(`  Raw Overrides:`, overrides);
      const mainComponent = await sourceInstance.getMainComponentAsync();
      if (!mainComponent) {
        console.error("Failed to get main component");
        figma.notify("Failed to get main component");
        return { success: false, message: "Failed to get main component" };
      }
      const returnData = {
        success: true,
        message: `Got component information from "${sourceInstance.name}" for overrides.length: ${overrides.length}`,
        sourceInstanceId: sourceInstance.id,
        mainComponentId: mainComponent.id,
        overridesCount: overrides.length
      };
      console.log("Data to return to MCP server:", returnData);
      figma.notify(`Got component information from "${sourceInstance.name}"`);
      return returnData;
    } catch (error) {
      console.error("Error in getInstanceOverrides:", error);
      figma.notify(`Error: ${error.message}`);
      return {
        success: false,
        message: `Error: ${error.message}`
      };
    }
  }
  async function getValidTargetInstances(targetNodeIds) {
    let targetInstances = [];
    if (Array.isArray(targetNodeIds)) {
      if (targetNodeIds.length === 0) {
        return { success: false, message: "No instances provided" };
      }
      for (const targetNodeId of targetNodeIds) {
        const targetNode = await figma.getNodeByIdAsync(targetNodeId);
        if (targetNode && targetNode.type === "INSTANCE") {
          targetInstances.push(targetNode);
        }
      }
      if (targetInstances.length === 0) {
        return { success: false, message: "No valid instances provided" };
      }
    } else {
      return { success: false, message: "Invalid target node IDs provided" };
    }
    return { success: true, message: "Valid target instances provided", targetInstances };
  }
  async function getSourceInstanceData(sourceInstanceId) {
    if (!sourceInstanceId) {
      return { success: false, message: "Missing source instance ID" };
    }
    const sourceInstance = await figma.getNodeByIdAsync(sourceInstanceId);
    if (!sourceInstance) {
      return {
        success: false,
        message: "Source instance not found. The original instance may have been deleted."
      };
    }
    if (sourceInstance.type !== "INSTANCE") {
      return {
        success: false,
        message: "Source node is not a component instance."
      };
    }
    const mainComponent = await sourceInstance.getMainComponentAsync();
    if (!mainComponent) {
      return {
        success: false,
        message: "Failed to get main component from source instance."
      };
    }
    return {
      success: true,
      sourceInstance,
      mainComponent,
      overrides: sourceInstance.overrides || []
    };
  }
  async function setInstanceOverrides(targetInstances, sourceResult) {
    try {
      const { sourceInstance, mainComponent, overrides } = sourceResult;
      console.log(`Processing ${targetInstances.length} instances with ${overrides.length} overrides`);
      console.log(`Source instance: ${sourceInstance.id}, Main component: ${mainComponent.id}`);
      console.log(`Overrides:`, overrides);
      const results = [];
      let totalAppliedCount = 0;
      for (const targetInstance of targetInstances) {
        try {
          try {
            targetInstance.swapComponent(mainComponent);
            console.log(`Swapped component for instance "${targetInstance.name}"`);
          } catch (error) {
            console.error(`Error swapping component for instance "${targetInstance.name}":`, error);
            results.push({
              success: false,
              instanceId: targetInstance.id,
              instanceName: targetInstance.name,
              message: `Error: ${error.message}`
            });
          }
          let appliedCount = 0;
          for (const override of overrides) {
            if (!override.id || !override.overriddenFields || override.overriddenFields.length === 0) {
              continue;
            }
            const overrideNodeId = override.id.replace(sourceInstance.id, targetInstance.id);
            const overrideNode = await figma.getNodeByIdAsync(overrideNodeId);
            if (!overrideNode) {
              console.log(`Override node not found: ${overrideNodeId}`);
              continue;
            }
            const sourceNode = await figma.getNodeByIdAsync(override.id);
            if (!sourceNode) {
              console.log(`Source node not found: ${override.id}`);
              continue;
            }
            let fieldApplied = false;
            for (const field of override.overriddenFields) {
              try {
                if (field === "componentProperties") {
                  if (sourceNode.componentProperties && overrideNode.componentProperties) {
                    const properties = {};
                    for (const key in sourceNode.componentProperties) {
                      if (sourceNode.componentProperties[key].type === "INSTANCE_SWAP") {
                        properties[key] = sourceNode.componentProperties[key].value;
                      } else {
                        properties[key] = sourceNode.componentProperties[key].value;
                      }
                    }
                    overrideNode.setProperties(properties);
                    fieldApplied = true;
                  }
                } else if (field === "characters" && overrideNode.type === "TEXT") {
                  await figma.loadFontAsync(overrideNode.fontName);
                  overrideNode.characters = sourceNode.characters;
                  fieldApplied = true;
                } else if (field in overrideNode) {
                  overrideNode[field] = sourceNode[field];
                  fieldApplied = true;
                }
              } catch (fieldError) {
                console.error(`Error applying field ${field}:`, fieldError);
              }
            }
            if (fieldApplied) {
              appliedCount++;
            }
          }
          if (appliedCount > 0) {
            totalAppliedCount += appliedCount;
            results.push({
              success: true,
              instanceId: targetInstance.id,
              instanceName: targetInstance.name,
              appliedCount
            });
            console.log(`Applied ${appliedCount} overrides to "${targetInstance.name}"`);
          } else {
            results.push({
              success: false,
              instanceId: targetInstance.id,
              instanceName: targetInstance.name,
              message: "No overrides were applied"
            });
          }
        } catch (instanceError) {
          console.error(`Error processing instance "${targetInstance.name}":`, instanceError);
          results.push({
            success: false,
            instanceId: targetInstance.id,
            instanceName: targetInstance.name,
            message: `Error: ${instanceError.message}`
          });
        }
      }
      if (totalAppliedCount > 0) {
        const instanceCount = results.filter((r) => r.success).length;
        const message = `Applied ${totalAppliedCount} overrides to ${instanceCount} instances`;
        figma.notify(message);
        return {
          success: true,
          message,
          totalCount: totalAppliedCount,
          results
        };
      } else {
        const message = "No overrides applied to any instance";
        figma.notify(message);
        return { success: false, message, results };
      }
    } catch (error) {
      console.error("Error in setInstanceOverrides:", error);
      const message = `Error: ${error.message}`;
      figma.notify(message);
      return { success: false, message };
    }
  }
  async function setLayoutMode(params) {
    const { nodeId, layoutMode = "NONE", layoutWrap = "NO_WRAP" } = params || {};
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error(`Node with ID ${nodeId} not found`);
    }
    if (node.type !== "FRAME" && node.type !== "COMPONENT" && node.type !== "COMPONENT_SET" && node.type !== "INSTANCE") {
      throw new Error(`Node type ${node.type} does not support layoutMode`);
    }
    node.layoutMode = layoutMode;
    if (layoutMode !== "NONE") {
      node.layoutWrap = layoutWrap;
    }
    return {
      id: node.id,
      name: node.name,
      layoutMode: node.layoutMode,
      layoutWrap: node.layoutWrap
    };
  }
  async function setPadding(params) {
    const { nodeId, paddingTop, paddingRight, paddingBottom, paddingLeft } = params || {};
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error(`Node with ID ${nodeId} not found`);
    }
    if (node.type !== "FRAME" && node.type !== "COMPONENT" && node.type !== "COMPONENT_SET" && node.type !== "INSTANCE") {
      throw new Error(`Node type ${node.type} does not support padding`);
    }
    if (node.layoutMode === "NONE") {
      throw new Error(
        "Padding can only be set on auto-layout frames (layoutMode must not be NONE)"
      );
    }
    if (paddingTop !== void 0) node.paddingTop = paddingTop;
    if (paddingRight !== void 0) node.paddingRight = paddingRight;
    if (paddingBottom !== void 0) node.paddingBottom = paddingBottom;
    if (paddingLeft !== void 0) node.paddingLeft = paddingLeft;
    return {
      id: node.id,
      name: node.name,
      paddingTop: node.paddingTop,
      paddingRight: node.paddingRight,
      paddingBottom: node.paddingBottom,
      paddingLeft: node.paddingLeft
    };
  }
  async function setAxisAlign(params) {
    const { nodeId, primaryAxisAlignItems, counterAxisAlignItems } = params || {};
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error(`Node with ID ${nodeId} not found`);
    }
    if (node.type !== "FRAME" && node.type !== "COMPONENT" && node.type !== "COMPONENT_SET" && node.type !== "INSTANCE") {
      throw new Error(`Node type ${node.type} does not support axis alignment`);
    }
    if (node.layoutMode === "NONE") {
      throw new Error(
        "Axis alignment can only be set on auto-layout frames (layoutMode must not be NONE)"
      );
    }
    if (primaryAxisAlignItems !== void 0) {
      if (!["MIN", "MAX", "CENTER", "SPACE_BETWEEN"].includes(primaryAxisAlignItems)) {
        throw new Error(
          "Invalid primaryAxisAlignItems value. Must be one of: MIN, MAX, CENTER, SPACE_BETWEEN"
        );
      }
      node.primaryAxisAlignItems = primaryAxisAlignItems;
    }
    if (counterAxisAlignItems !== void 0) {
      if (!["MIN", "MAX", "CENTER", "BASELINE"].includes(counterAxisAlignItems)) {
        throw new Error(
          "Invalid counterAxisAlignItems value. Must be one of: MIN, MAX, CENTER, BASELINE"
        );
      }
      if (counterAxisAlignItems === "BASELINE" && node.layoutMode !== "HORIZONTAL") {
        throw new Error(
          "BASELINE alignment is only valid for horizontal auto-layout frames"
        );
      }
      node.counterAxisAlignItems = counterAxisAlignItems;
    }
    return {
      id: node.id,
      name: node.name,
      primaryAxisAlignItems: node.primaryAxisAlignItems,
      counterAxisAlignItems: node.counterAxisAlignItems,
      layoutMode: node.layoutMode
    };
  }
  async function setLayoutSizing(params) {
    const { nodeId, layoutSizingHorizontal, layoutSizingVertical } = params || {};
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error(`Node with ID ${nodeId} not found`);
    }
    if (node.type !== "FRAME" && node.type !== "COMPONENT" && node.type !== "COMPONENT_SET" && node.type !== "INSTANCE") {
      throw new Error(`Node type ${node.type} does not support layout sizing`);
    }
    if (node.layoutMode === "NONE") {
      throw new Error(
        "Layout sizing can only be set on auto-layout frames (layoutMode must not be NONE)"
      );
    }
    if (layoutSizingHorizontal !== void 0) {
      if (!["FIXED", "HUG", "FILL"].includes(layoutSizingHorizontal)) {
        throw new Error(
          "Invalid layoutSizingHorizontal value. Must be one of: FIXED, HUG, FILL"
        );
      }
      if (layoutSizingHorizontal === "HUG" && !["FRAME", "TEXT"].includes(node.type)) {
        throw new Error(
          "HUG sizing is only valid on auto-layout frames and text nodes"
        );
      }
      if (layoutSizingHorizontal === "FILL" && (!node.parent || node.parent.layoutMode === "NONE")) {
        throw new Error("FILL sizing is only valid on auto-layout children");
      }
      node.layoutSizingHorizontal = layoutSizingHorizontal;
    }
    if (layoutSizingVertical !== void 0) {
      if (!["FIXED", "HUG", "FILL"].includes(layoutSizingVertical)) {
        throw new Error(
          "Invalid layoutSizingVertical value. Must be one of: FIXED, HUG, FILL"
        );
      }
      if (layoutSizingVertical === "HUG" && !["FRAME", "TEXT"].includes(node.type)) {
        throw new Error(
          "HUG sizing is only valid on auto-layout frames and text nodes"
        );
      }
      if (layoutSizingVertical === "FILL" && (!node.parent || node.parent.layoutMode === "NONE")) {
        throw new Error("FILL sizing is only valid on auto-layout children");
      }
      node.layoutSizingVertical = layoutSizingVertical;
    }
    return {
      id: node.id,
      name: node.name,
      layoutSizingHorizontal: node.layoutSizingHorizontal,
      layoutSizingVertical: node.layoutSizingVertical,
      layoutMode: node.layoutMode
    };
  }
  async function setItemSpacing(params) {
    const { nodeId, itemSpacing, counterAxisSpacing } = params || {};
    if (itemSpacing === void 0 && counterAxisSpacing === void 0) {
      throw new Error("At least one of itemSpacing or counterAxisSpacing must be provided");
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      throw new Error(`Node with ID ${nodeId} not found`);
    }
    if (node.type !== "FRAME" && node.type !== "COMPONENT" && node.type !== "COMPONENT_SET" && node.type !== "INSTANCE") {
      throw new Error(`Node type ${node.type} does not support item spacing`);
    }
    if (node.layoutMode === "NONE") {
      throw new Error(
        "Item spacing can only be set on auto-layout frames (layoutMode must not be NONE)"
      );
    }
    if (itemSpacing !== void 0) {
      if (typeof itemSpacing !== "number") {
        throw new Error("Item spacing must be a number");
      }
      node.itemSpacing = itemSpacing;
    }
    if (counterAxisSpacing !== void 0) {
      if (typeof counterAxisSpacing !== "number") {
        throw new Error("Counter axis spacing must be a number");
      }
      if (node.layoutWrap !== "WRAP") {
        throw new Error(
          "Counter axis spacing can only be set on frames with layoutWrap set to WRAP"
        );
      }
      node.counterAxisSpacing = counterAxisSpacing;
    }
    return {
      id: node.id,
      name: node.name,
      itemSpacing: node.itemSpacing || void 0,
      counterAxisSpacing: node.counterAxisSpacing || void 0,
      layoutMode: node.layoutMode,
      layoutWrap: node.layoutWrap
    };
  }
  async function setDefaultConnector(params) {
    const { connectorId } = params || {};
    if (connectorId) {
      const node = await figma.getNodeByIdAsync(connectorId);
      if (!node) {
        throw new Error(`Connector node not found with ID: ${connectorId}`);
      }
      if (node.type !== "CONNECTOR") {
        throw new Error(`Node is not a connector: ${connectorId}`);
      }
      await figma.clientStorage.setAsync("defaultConnectorId", connectorId);
      return {
        success: true,
        message: `Default connector set to: ${connectorId}`,
        connectorId
      };
    } else {
      try {
        const existingConnectorId = await figma.clientStorage.getAsync("defaultConnectorId");
        if (existingConnectorId) {
          try {
            const existingConnector = await figma.getNodeByIdAsync(existingConnectorId);
            if (existingConnector && existingConnector.type === "CONNECTOR") {
              return {
                success: true,
                message: `Default connector is already set to: ${existingConnectorId}`,
                connectorId: existingConnectorId,
                exists: true
              };
            } else {
              console.log(`Stored connector ID ${existingConnectorId} is no longer valid, finding a new connector...`);
            }
          } catch (error) {
            console.log(`Error finding stored connector: ${error.message}. Will try to set a new one.`);
          }
        }
      } catch (error) {
        console.log(`Error checking for existing connector: ${error.message}`);
      }
      try {
        const currentPageConnectors = figma.currentPage.findAllWithCriteria({ types: ["CONNECTOR"] });
        if (currentPageConnectors && currentPageConnectors.length > 0) {
          const foundConnector = currentPageConnectors[0];
          const autoFoundId = foundConnector.id;
          await figma.clientStorage.setAsync("defaultConnectorId", autoFoundId);
          return {
            success: true,
            message: `Automatically found and set default connector to: ${autoFoundId}`,
            connectorId: autoFoundId,
            autoSelected: true
          };
        } else {
          throw new Error("No connector found in the current page. Please create a connector in Figma first or specify a connector ID.");
        }
      } catch (error) {
        throw new Error(`Failed to find a connector: ${error.message}`);
      }
    }
  }
  async function createCursorNode(targetNodeId) {
    const svgString = `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M16 8V35.2419L22 28.4315L27 39.7823C27 39.7823 28.3526 40.2722 29 39.7823C29.6474 39.2924 30.2913 38.3057 30 37.5121C28.6247 33.7654 25 26.1613 25 26.1613H32L16 8Z" fill="#202125" />
  </svg>`;
    try {
      const targetNode = await figma.getNodeByIdAsync(targetNodeId);
      if (!targetNode) throw new Error("Target node not found");
      let parentNodeId = targetNodeId.includes(";") ? targetNodeId.split(";")[0] : targetNodeId;
      if (!parentNodeId) throw new Error("Could not determine parent node ID");
      let parentNode = await figma.getNodeByIdAsync(parentNodeId);
      if (!parentNode) throw new Error("Parent node not found");
      if (parentNode.type === "INSTANCE" || parentNode.type === "COMPONENT" || parentNode.type === "COMPONENT_SET") {
        parentNode = parentNode.parent;
        if (!parentNode) throw new Error("Parent node not found");
      }
      const importedNode = await figma.createNodeFromSvg(svgString);
      if (!importedNode || !importedNode.id) {
        throw new Error("Failed to create imported cursor node");
      }
      importedNode.name = "TTF_Connector / Mouse Cursor";
      importedNode.resize(48, 48);
      const cursorNode = importedNode.findOne((node) => node.type === "VECTOR");
      if (cursorNode) {
        cursorNode.fills = [{
          type: "SOLID",
          color: { r: 0, g: 0, b: 0 },
          opacity: 1
        }];
        cursorNode.strokes = [{
          type: "SOLID",
          color: { r: 1, g: 1, b: 1 },
          opacity: 1
        }];
        cursorNode.strokeWeight = 2;
        cursorNode.strokeAlign = "OUTSIDE";
        cursorNode.effects = [{
          type: "DROP_SHADOW",
          color: { r: 0, g: 0, b: 0, a: 0.3 },
          offset: { x: 1, y: 1 },
          radius: 2,
          spread: 0,
          visible: true,
          blendMode: "NORMAL"
        }];
      }
      parentNode.appendChild(importedNode);
      if ("layoutMode" in parentNode && parentNode.layoutMode !== "NONE") {
        importedNode.layoutPositioning = "ABSOLUTE";
      }
      if (targetNode.absoluteBoundingBox && parentNode.absoluteBoundingBox) {
        console.log("targetNode.absoluteBoundingBox", targetNode.absoluteBoundingBox);
        console.log("parentNode.absoluteBoundingBox", parentNode.absoluteBoundingBox);
        importedNode.x = targetNode.absoluteBoundingBox.x - parentNode.absoluteBoundingBox.x + targetNode.absoluteBoundingBox.width / 2 - 48 / 2;
        importedNode.y = targetNode.absoluteBoundingBox.y - parentNode.absoluteBoundingBox.y + targetNode.absoluteBoundingBox.height / 2 - 48 / 2;
      } else if ("x" in targetNode && "y" in targetNode && "width" in targetNode && "height" in targetNode) {
        console.log("targetNode.x/y/width/height", targetNode.x, targetNode.y, targetNode.width, targetNode.height);
        importedNode.x = targetNode.x + targetNode.width / 2 - 48 / 2;
        importedNode.y = targetNode.y + targetNode.height / 2 - 48 / 2;
      } else {
        if ("x" in targetNode && "y" in targetNode) {
          console.log("Fallback to targetNode x/y");
          importedNode.x = targetNode.x;
          importedNode.y = targetNode.y;
        } else {
          console.log("Fallback to (0,0)");
          importedNode.x = 0;
          importedNode.y = 0;
        }
      }
      console.log("importedNode", importedNode);
      return { id: importedNode.id, node: importedNode };
    } catch (error) {
      console.error("Error creating cursor from SVG:", error);
      return { id: null, node: null, error: error.message };
    }
  }
  async function createConnections(params) {
    if (!params || !params.connections || !Array.isArray(params.connections)) {
      throw new Error("Missing or invalid connections parameter");
    }
    const { connections } = params;
    const commandId = generateCommandId();
    sendProgressUpdate(
      commandId,
      "create_connections",
      "started",
      0,
      connections.length,
      0,
      `Starting to create ${connections.length} connections`
    );
    const defaultConnectorId = await figma.clientStorage.getAsync("defaultConnectorId");
    if (!defaultConnectorId) {
      throw new Error('No default connector set. Please try one of the following options to create connections:\n1. Create a connector in FigJam and copy/paste it to your current page, then run the "set_default_connector" command.\n2. Select an existing connector on the current page, then run the "set_default_connector" command.');
    }
    const defaultConnector = await figma.getNodeByIdAsync(defaultConnectorId);
    if (!defaultConnector) {
      throw new Error(`Default connector not found with ID: ${defaultConnectorId}`);
    }
    if (defaultConnector.type !== "CONNECTOR") {
      throw new Error(`Node is not a connector: ${defaultConnectorId}`);
    }
    const results = [];
    let processedCount = 0;
    const totalCount = connections.length;
    let fontLoaded = false;
    for (let i = 0; i < connections.length; i++) {
      try {
        const { startNodeId: originalStartId, endNodeId: originalEndId, text } = connections[i];
        let startId = originalStartId;
        let endId = originalEndId;
        if (startId.includes(";")) {
          console.log(`Nested start node detected: ${startId}. Creating cursor node.`);
          const cursorResult = await createCursorNode(startId);
          if (!cursorResult || !cursorResult.id) {
            throw new Error(`Failed to create cursor node for nested start node: ${startId}`);
          }
          startId = cursorResult.id;
        }
        const startNode = await figma.getNodeByIdAsync(startId);
        if (!startNode) throw new Error(`Start node not found with ID: ${startId}`);
        if (endId.includes(";")) {
          console.log(`Nested end node detected: ${endId}. Creating cursor node.`);
          const cursorResult = await createCursorNode(endId);
          if (!cursorResult || !cursorResult.id) {
            throw new Error(`Failed to create cursor node for nested end node: ${endId}`);
          }
          endId = cursorResult.id;
        }
        const endNode = await figma.getNodeByIdAsync(endId);
        if (!endNode) throw new Error(`End node not found with ID: ${endId}`);
        const clonedConnector = defaultConnector.clone();
        clonedConnector.name = `TTF_Connector/${startNode.id}/${endNode.id}`;
        clonedConnector.connectorStart = {
          endpointNodeId: startId,
          magnet: "AUTO"
        };
        clonedConnector.connectorEnd = {
          endpointNodeId: endId,
          magnet: "AUTO"
        };
        if (text) {
          try {
            try {
              if (defaultConnector.text && defaultConnector.text.fontName) {
                const fontName = defaultConnector.text.fontName;
                await figma.loadFontAsync(fontName);
                clonedConnector.text.fontName = fontName;
              } else {
                await figma.loadFontAsync({ family: "Inter", style: "Regular" });
              }
            } catch (fontError) {
              try {
                await figma.loadFontAsync({ family: "Inter", style: "Medium" });
              } catch (mediumFontError) {
                try {
                  await figma.loadFontAsync({ family: "System", style: "Regular" });
                } catch (systemFontError) {
                  throw new Error(`Failed to load any font: ${fontError.message}`);
                }
              }
            }
            clonedConnector.text.characters = text;
          } catch (textError) {
            console.error("Error setting text:", textError);
            results.push({
              id: clonedConnector.id,
              startNodeId,
              endNodeId,
              text: "",
              textError: textError.message
            });
            continue;
          }
        }
        results.push({
          id: clonedConnector.id,
          originalStartNodeId: originalStartId,
          originalEndNodeId: originalEndId,
          usedStartNodeId: startId,
          // ID actually used for connection
          usedEndNodeId: endId,
          // ID actually used for connection
          text: text || ""
        });
        processedCount++;
        sendProgressUpdate(
          commandId,
          "create_connections",
          "in_progress",
          processedCount / totalCount,
          totalCount,
          processedCount,
          `Created connection ${processedCount}/${totalCount}`
        );
      } catch (error) {
        console.error("Error creating connection", error);
        processedCount++;
        sendProgressUpdate(
          commandId,
          "create_connections",
          "in_progress",
          processedCount / totalCount,
          totalCount,
          processedCount,
          `Error creating connection: ${error.message}`
        );
        results.push({
          error: error.message,
          connectionInfo: connections[i]
        });
      }
    }
    sendProgressUpdate(
      commandId,
      "create_connections",
      "completed",
      1,
      totalCount,
      totalCount,
      `Completed creating ${results.length} connections`
    );
    return {
      success: true,
      count: results.length,
      connections: results
    };
  }
  async function setFocus(params) {
    if (!params || !params.nodeId) {
      throw new Error("Missing nodeId parameter");
    }
    const node = await figma.getNodeByIdAsync(params.nodeId);
    if (!node) {
      throw new Error(`Node with ID ${params.nodeId} not found`);
    }
    figma.currentPage.selection = [node];
    figma.viewport.scrollAndZoomIntoView([node]);
    return {
      success: true,
      name: node.name,
      id: node.id,
      message: `Focused on node "${node.name}"`
    };
  }
  async function setSelections(params) {
    if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
      throw new Error("Missing or invalid nodeIds parameter");
    }
    if (params.nodeIds.length === 0) {
      throw new Error("nodeIds array cannot be empty");
    }
    const nodes = [];
    const notFoundIds = [];
    for (const nodeId of params.nodeIds) {
      const node = await figma.getNodeByIdAsync(nodeId);
      if (node) {
        nodes.push(node);
      } else {
        notFoundIds.push(nodeId);
      }
    }
    if (nodes.length === 0) {
      throw new Error(`No valid nodes found for the provided IDs: ${params.nodeIds.join(", ")}`);
    }
    figma.currentPage.selection = nodes;
    figma.viewport.scrollAndZoomIntoView(nodes);
    const selectedNodes = nodes.map((node) => ({
      name: node.name,
      id: node.id
    }));
    return {
      success: true,
      count: nodes.length,
      selectedNodes,
      notFoundIds,
      message: `Selected ${nodes.length} nodes${notFoundIds.length > 0 ? ` (${notFoundIds.length} not found)` : ""}`
    };
  }
  return { execute: handleCommand };
})();
