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
  var image = false, crop = false, adjusted = false, translucent = false;
  try {
    var paints = n.fills || [];
    for (var i = 0; i < paints.length; i++) {
      var p = paints[i];
      if (p.visible === false || p.type !== 'IMAGE') continue;
      image = true;
      adjusted = adjusted || _hasImageAdjustments(p);
      translucent = translucent || (typeof p.opacity === 'number' && p.opacity !== 1);
      // AE's centred cover-fit is NOT Figma CROP: imageTransform carries the user's crop/zoom.
      // Export just this leaf as rendered by Figma, retaining its own layer and full-resolution
      // appearance instead of silently discarding that transform.
      if (p.scaleMode === 'CROP' || p.imageTransform) crop = true;
    }
  } catch (e) { return false; }
  if (image && (adjusted || translucent)) {
    _requireRasterOption(n, 'effects', adjusted ? '的图片调色（曝光、对比度等）或填充不透明度需要转为图片' : '的图片填充不透明度需要转为图片');
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
    if (!n.children || n.clipsContent) return false;
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
      var needed = atoms[end].bounds, start = -1, maskedBackdrop = false;
      if (_blendBoundary(atoms[end].node) && end > 0 && !_blendBoundary(atoms[end - 1].node) &&
          !_subtreeFlags(atoms[end - 1].node).marked && !atoms[end - 1].blend &&
          opaque(atoms[end - 1].node, needed)) maskedBackdrop = true;
      for (var back = end - 1; back >= 0; back--) {
        if (_subtreeFlags(atoms[back].node).marked) break;
        if (_blendBoundary(atoms[back].node)) {
          // A mask cannot be its own external backdrop. It may only be absorbed when the
          // immediately preceding normal atom is opaque and closes the burn/overlay stack.
          var previous = back - 1;
          if (previous >= 0 && !_blendBoundary(atoms[previous].node) &&
              !_subtreeFlags(atoms[previous].node).marked && !atoms[previous].blend &&
              opaque(atoms[previous].node, needed)) maskedBackdrop = true;
          if (!maskedBackdrop) break;
          continue;
        }
        if (atoms[back].blend) needed = union(needed, atoms[back].bounds);
        if (masksClose(ctx, needed) && !atoms[back].blend && opaque(atoms[back].node, needed)) { start = back; break; }
      }
      if (start < 0 && isolated) start = 0;
      if (start < 0) continue;
      if (!maskedBackdrop && atoms.slice(start, end + 1).some(function (a) { return _blendBoundary(a.node) || _subtreeFlags(a.node).marked || !!_maskByNode[a.node.id]; })) continue;
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
  if (_exporting) {
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
            scaleMode: mode, opacity: organize && _isContainer(n) ? 1 : _opacityChain(n, organize, rootId), hidden: _isHidden(n),
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
