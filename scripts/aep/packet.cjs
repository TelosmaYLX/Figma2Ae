'use strict';

// Share the production geometry parser; this module never loads ExtendScript or AE.
const parser = require('../../host/figma/svgParser.js');
const AE_VERSIONS = ['24.0', '25.0', '26.0'];
function layerError(node, message, cause) {
  const error = new Error(message, {cause});
  error.nodeId = node.sourceId || null;
  return error;
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
  return {
    name: packet.name || 'Figma', aeVersion, width, height, frameRate: 30, duration: 10,
    shapes: model.shapes, texts: packet.texts || [], images: packet.images || [],
    containers: packet.organize ? packet.containers || [] : [], effects: packet.effects || []
  };
}

module.exports = {normalize, AE_VERSIONS};
