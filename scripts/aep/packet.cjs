'use strict';

// Share the production geometry parser; this module never loads ExtendScript or AE.
const parser = require('../../host/figma/svgParser.js');
const AE_VERSIONS = ['24.0', '25.0', '26.0'];
function layerError(node, message, cause) {
  const error = new Error(message, {cause});
  error.nodeId = node.sourceId || null;
  return error;
}

// 「保留背景模糊」requests are shipped next to the layer model. Validate the few
// values the writer depends on and parse the fill silhouette once here, so the
// Python side only has to feed the geometry into a mask atom.
function invalid(node, message) {
  return layerError(node, '图层「' + (node.name || '未知') + '」的背景模糊无法导出：' + message);
}

function pair(node, value, label) {
  if (!Array.isArray(value) || value.length < 2 ||
      typeof value[0] !== 'number' || typeof value[1] !== 'number' ||
      !Number.isFinite(value[0]) || !Number.isFinite(value[1])) {
    throw invalid(node, label + '无效');
  }
  return [value[0], value[1]];
}

function backgroundBlurs(packet) {
  if (packet.backgroundBlurs == null) return [];
  if (!Array.isArray(packet.backgroundBlurs)) throw new Error('背景模糊数据无效');
  return packet.backgroundBlurs.map(value => {
    const request = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    if (typeof request.name !== 'string' || !request.name) throw invalid(request, '缺少图层名称');
    if (typeof request.container !== 'string' || !request.container) throw invalid(request, '缺少源图层容器');
    const size = pair(request, request.size, '尺寸');
    const position = pair(request, request.position, '位置');
    if (typeof request.rotation !== 'number' || !Number.isFinite(request.rotation)) throw invalid(request, '旋转角度无效');
    const scale = pair(request, request.scale, '缩放');
    if (typeof request.radius !== 'number' || !Number.isFinite(request.radius)) throw invalid(request, '模糊半径无效');
    if (request.mode !== 'uniform' && request.mode !== 'progressive') throw invalid(request, '模糊模式无效');
    const mask = request.mask;
    if (!mask || typeof mask !== 'object') throw invalid(request, '缺少遮罩路径');
    let subpaths = null;
    if (mask.kind === 'path') {
      if (typeof mask.d !== 'string' || !mask.d) throw invalid(request, '遮罩路径为空');
      try { subpaths = parser.parsePathData(mask.d); } catch (error) { throw invalid(request, '遮罩路径无法解析'); }
      // The writer models one mask atom, so holes would silently lose their subtraction.
      if (subpaths.length !== 1 || !subpaths[0].verts.length) throw invalid(request, '遮罩路径必须只有一条子路径');
    } else if (mask.kind !== 'rect' && mask.kind !== 'ellipse') {
      throw invalid(request, '不支持的遮罩类型 ' + mask.kind);
    }
    return {...request, size, position, scale, mask: {...mask, subpaths}};
  });
}

function normalize(packet) {
  const aeVersion = packet.aeVersion ?? '26.0';
  if (!AE_VERSIONS.includes(aeVersion)) throw new Error('请选择 AE 2024、2025 或 2026 工程版本');
  if (typeof packet.svg !== 'string' || !packet.svg.includes('<svg')) throw new Error('缺少 Figma 导出数据');
  const viewport = parser.parse(packet.svg);
  const frame = packet.frame || viewport;
  const width = Math.ceil(frame.width), height = Math.ceil(frame.height);
  if (!(width >= 4 && height >= 4 && width <= 30000 && height <= 30000)) {
    throw new Error('画框尺寸须在 4–30000 像素之间');
  }
  let model = viewport;
  if (packet.nodes) {
    try { model = parser.fromNodes(packet.nodes, width, height); }
    catch (error) {
      for (const node of packet.nodes) {
        try { parser.fromNodes([node], width, height); }
        catch { throw layerError(node, '图层「' + node.name + '」的路径无法解析', error); }
      }
      throw error;
    }
  }
  if (packet.imageCount != null && packet.imageCount !== (packet.images || []).length) throw new Error('图片数据不完整，已取消导出');
  if (packet.nodes) {
    const emitted = new Set(model.shapes.map(shape => shape.srcIndex));
    packet.nodes.forEach((node, index) => {
      if (!emitted.has(index)) throw layerError(node, '图层「' + node.name + '」的路径无法解析');
    });
    for (const shape of model.shapes) shape.sourceId = packet.nodes[shape.srcIndex].sourceId || null;
  }
  // Editable-node geometry is already frame-relative. SVG geometry uses the render origin.
  if (!packet.nodes) {
    const dx = packet.shift?.x || 0, dy = packet.shift?.y || 0;
    for (const shape of model.shapes) {
      for (const sub of shape.subpaths) for (const v of sub.verts) { v[0] -= dx; v[1] -= dy; }
      if (shape.prim) { shape.prim.cx -= dx; shape.prim.cy -= dy; }
      for (const g of [shape.gradient, shape.strokeGradient]) if (g) {
        g.start[0] -= dx; g.start[1] -= dy; g.end[0] -= dx; g.end[1] -= dy;
      }
    }
  }
  const duration = packet.duration == null ? 10 : Number(packet.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 10800) {
    throw new Error('合成时长须在 0–10800 秒之间');
  }
  const frameRate = packet.frameRate == null ? 30 : Number(packet.frameRate);
  if (!Number.isFinite(frameRate) || frameRate < 1 || frameRate > 999) {
    throw new Error('帧率须在 1–999 fps 之间');
  }
  return {
    name: packet.name || 'Figma', aeVersion, width, height, frameRate, duration,
    shapes: model.shapes, texts: packet.texts || [], images: packet.images || [],
    containers: packet.organize ? packet.containers || [] : [], effects: packet.effects || [],
    imageGradeEffect: packet.imageGradeEffect === true,
    backgroundBlurs: backgroundBlurs(packet),
  };
}

module.exports = {normalize, AE_VERSIONS};
