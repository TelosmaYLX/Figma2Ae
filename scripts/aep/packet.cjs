'use strict';

// Share the production geometry parser; this module never loads ExtendScript or AE.
const parser = require('../../host/figma/svgParser.js');

function normalize(packet) {
  if (typeof packet.svg !== 'string' || !packet.svg.includes('<svg')) throw new Error('缺少 Figma 导出数据');
  const viewport = parser.parse(packet.svg);
  const frame = packet.frame || viewport;
  const width = Math.ceil(frame.width), height = Math.ceil(frame.height);
  if (!(width >= 4 && height >= 4 && width <= 30000 && height <= 30000)) {
    throw new Error('画框尺寸须在 4–30000 像素之间');
  }
  const model = packet.nodes ? parser.fromNodes(packet.nodes, width, height) : viewport;
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
    name: packet.name || 'Figma', width, height, frameRate: 30, duration: 10,
    shapes: model.shapes, texts: packet.texts || [], images: packet.images || [],
    containers: packet.organize ? packet.containers || [] : [], effects: packet.effects || []
  };
}

module.exports = {normalize};
