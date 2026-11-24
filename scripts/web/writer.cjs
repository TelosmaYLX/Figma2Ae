'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {normalize} = require('../aep/packet.cjs');
const {controls: gradeControls} = require('../../client/figmaImageGrade.js');

const BLEND_CSS = {
  DARKEN: 'darken',
  MULTIPLY: 'multiply',
  LINEAR_BURN: 'color-burn',
  COLOR_BURN: 'color-burn',
  LIGHTEN: 'lighten',
  SCREEN: 'screen',
  LINEAR_DODGE: 'plus-lighter',
  COLOR_DODGE: 'color-dodge',
  OVERLAY: 'overlay',
  SOFT_LIGHT: 'soft-light',
  HARD_LIGHT: 'hard-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

const VALID_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

// Align SVG outer CSS boxes to 4-CSS-px multiples so every standard DPI scale (100%, 125%,
// 150%, 175%, 200%, 225%, 250%, 300%) maps them to exact integer physical pixels. Otherwise
// Blink pixel-snaps odd coordinates/sizes by up to +/-0.4 CSS px on fractional-DPI displays.
const PIXEL_GRID = 4;
function floorGrid(value) {
  return Math.floor(value / PIXEL_GRID) * PIXEL_GRID;
}
function ceilGrid(value) {
  return Math.ceil(value / PIXEL_GRID) * PIXEL_GRID;
}
function isGridAligned(value) {
  return Math.abs(value - Math.round(value / PIXEL_GRID) * PIXEL_GRID) < 1e-4;
}

function rotatedBounds(cx, cy, w, h, rotDeg) {
  const hw = w / 2, hh = h / 2;
  if (!rotDeg) return {minX: cx - hw, minY: cy - hh, maxX: cx + hw, maxY: cy + hh};
  const rad = rotDeg * Math.PI / 180;
  const c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
  const ex = hw * c + hh * s, ey = hw * s + hh * c;
  return {minX: cx - ex, minY: cy - ey, maxX: cx + ex, maxY: cy + ey};
}

function roundedRectSvgGeom(x, y, w, h, radii, r, extraAttrs = '') {
  const maxR = Math.max(0, Math.min(w / 2, h / 2));
  if (Array.isArray(radii) && radii.length === 4) {
    const [tl, tr, br, bl] = radii.map(v => Math.max(0, Math.min(Number(v) || 0, maxR)));
    if (tl === tr && tr === br && br === bl) {
      const rx = tl > 0 ? ` rx="${num(tl)}" ry="${num(tl)}"` : '';
      return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"${rx}${extraAttrs}/>`;
    }
    const x2 = x + w, y2 = y + h;
    const d =
      `M${num(x + tl)} ${num(y)}H${num(x2 - tr)}` +
      (tr > 0 ? `A${num(tr)} ${num(tr)} 0 0 1 ${num(x2)} ${num(y + tr)}` : '') +
      `V${num(y2 - br)}` +
      (br > 0 ? `A${num(br)} ${num(br)} 0 0 1 ${num(x2 - br)} ${num(y2)}` : '') +
      `H${num(x + bl)}` +
      (bl > 0 ? `A${num(bl)} ${num(bl)} 0 0 1 ${num(x)} ${num(y2 - bl)}` : '') +
      `V${num(y + tl)}` +
      (tl > 0 ? `A${num(tl)} ${num(tl)} 0 0 1 ${num(x + tl)} ${num(y)}` : '') +
      'Z';
    return `<path d="${d}"${extraAttrs}/>`;
  }
  const single = Math.max(0, Math.min(Number(r) || 0, maxR));
  const rx = single > 0 ? ` rx="${num(single)}" ry="${num(single)}"` : '';
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"${rx}${extraAttrs}/>`;
}

function num(value) {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.abs(value) < 1e-6 ? 0 : Math.round(value * 10000) / 10000;
  return String(rounded);
}

function px(value) {
  return num(value) + 'px';
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeCssComment(value) {
  return String(value == null ? '' : value).replaceAll('*/', '* /');
}

function colorHex(rgb) {
  const c = rgb || [0, 0, 0];
  return '#' + [0, 1, 2].map(i => Math.round(clamp01(c[i]) * 255).toString(16).padStart(2, '0')).join('');
}

function colorCss(rgb, opacity = 1) {
  const c = rgb || [0, 0, 0];
  const a = clamp01(opacity == null ? 1 : opacity);
  const r = Math.round(clamp01(c[0]) * 255);
  const g = Math.round(clamp01(c[1]) * 255);
  const b = Math.round(clamp01(c[2]) * 255);
  if (a >= 0.9995) return colorHex(c);
  return `rgba(${r}, ${g}, ${b}, ${num(a)})`;
}

function fontWeightFromStyle(style = 'Regular') {
  const s = String(style).toLowerCase();
  if (/thin|hairline|\bw1\b|极细|超细/.test(s)) return 100;
  if (/extra\s*light|ultra\s*light|\bw2\b|\b35\b|特细/.test(s)) return 200;
  if (/light|\bw3\b|\b45\b|细体|纤细/.test(s)) return 300;
  if (/medium|\bw5\b|\b65\b|中等|中黑|中粗/.test(s)) return 500;
  if (/semi\s*bold|demi\s*bold|\bw6\b|\b75\b|半粗|准粗/.test(s)) return 600;
  if (/extra\s*bold|ultra\s*bold|\bw8\b|\b95\b|特粗|超粗/.test(s)) return 800;
  if (/black|heavy|\bw9\b|\b105\b|\b115\b|极粗|浓黑/.test(s)) return 900;
  if (/bold|\bw7\b|\b85\b|粗体|加粗/.test(s)) return 700;
  if (/regular|normal|book|roman|\bw4\b|\b55\b|常规|标准|正常/.test(s)) return 400;
  const numMatch = s.match(/\b([1-9]00)\b/);
  if (numMatch) return Number(numMatch[1]);
  return 400;
}

function fontStyleFromStyle(style = 'Regular') {
  return /italic|oblique/i.test(String(style)) ? 'italic' : 'normal';
}

function fontStretchFromStyle(style = 'Regular') {
  const s = String(style).replace(/\s+/g, '').toLowerCase();
  if (s.includes('ultracondensed')) return 'ultra-condensed';
  if (s.includes('extracondensed')) return 'extra-condensed';
  if (s.includes('semicondensed')) return 'semi-condensed';
  if (s.includes('condensed') || s.includes('narrow')) return 'condensed';
  if (s.includes('ultraexpanded')) return 'ultra-expanded';
  if (s.includes('extraexpanded')) return 'extra-expanded';
  if (s.includes('semiexpanded')) return 'semi-expanded';
  if (s.includes('expanded') || s.includes('extended') || s.includes('wide')) return 'expanded';
  return 'normal';
}

function textDecorationCss(decoration) {
  if (decoration === 'UNDERLINE') return 'underline';
  if (decoration === 'STRIKETHROUGH') return 'line-through';
  return null;
}

function cssFontFamily(family) {
  const clean = String(family || 'sans-serif').replaceAll('"', '\\"');
  return `"${clean}", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`;
}

function cssBorderRadius(radii, r, w, h) {
  const maxR = Math.max(0, Math.min(w / 2, h / 2));
  if (Array.isArray(radii) && radii.length === 4) {
    const vals = radii.map(v => Math.max(0, Math.min(Number(v) || 0, maxR)));
    if (vals.every(v => v <= 0)) return null;
    if (vals[0] === vals[1] && vals[1] === vals[2] && vals[2] === vals[3]) return px(vals[0]);
    return vals.map(px).join(' ');
  }
  const single = Math.max(0, Math.min(Number(r) || 0, maxR));
  return single > 0 ? px(single) : null;
}

function imageDimensions(buffer, ext) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 10) return null;
    if (ext === 'png' && buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
      return {width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20)};
    }
    if (ext === 'gif' && buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49) {
      return {width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8)};
    }
    if ((ext === 'jpg' || ext === 'jpeg') && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset + 8 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset++; continue; }
        const marker = buffer[offset + 1];
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2; continue;
        }
        const length = buffer.readUInt16BE(offset + 2);
        if (length < 2) break;
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return {height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7)};
        }
        offset += 2 + length;
      }
    }
    if (ext === 'webp' && buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buffer.toString('ascii', 12, 16);
      if (chunk === 'VP8X') {
        const width = 1 + buffer.readUIntLE(24, 3);
        const height = 1 + buffer.readUIntLE(27, 3);
        return {width, height};
      }
      if (chunk === 'VP8 ' && buffer.length >= 30) {
        return {width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff};
      }
      if (chunk === 'VP8L' && buffer.length >= 25) {
        const bits = buffer.readUInt32LE(21);
        return {width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1};
      }
    }
  } catch {}
  return null;
}

function compBounds(item) {
  let x = item.x, y = item.y, right = item.x + item.w, bottom = item.y + item.h;
  const content = item.cb;
  if (!item.clip && content) {
    x = Math.min(x, content.x);
    y = Math.min(y, content.y);
    right = Math.max(right, content.x + content.w);
    bottom = Math.max(bottom, content.y + content.h);
  }
  const left = Math.floor(x + 1e-6);
  const top = Math.floor(y + 1e-6);
  return {
    x: left,
    y: top,
    w: Math.max(1, Math.ceil(right - 1e-6) - left),
    h: Math.max(1, Math.ceil(bottom - 1e-6) - top),
  };
}

function cubicExtrema1D(p0, p1, p2, p3) {
  let min = Math.min(p0, p3);
  let max = Math.max(p0, p3);
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const evalAt = t => {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
  };
  const roots = [];
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      roots.push((-b - s) / (2 * a), (-b + s) / (2 * a));
    }
  }
  for (const t of roots) {
    if (t > 0 && t < 1) {
      const v = evalAt(t);
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return [min, max];
}

function shapeRect(item) {
  const outlined = (item.extraPaints || []).filter(paint => paint.subpaths && paint.subpaths.length);
  if (outlined.length) {
    const boxes = outlined.map(paint => shapeRect(paint));
    if (item.fill != null || item.gradient || item.stroke != null || item.strokeGradient || item.layerStroke) {
      boxes.push(shapeRect({...item, extraPaints: null}));
    }
    const left = Math.min(...boxes.map(b => b.left));
    const top = Math.min(...boxes.map(b => b.top));
    const right = Math.max(...boxes.map(b => b.left + b.width));
    const bottom = Math.max(...boxes.map(b => b.top + b.height));
    return {left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top)};
  }
  if (item.prim) {
    const width = item.prim.k === 'rect' ? item.prim.w : item.prim.rx * 2;
    const height = item.prim.k === 'rect' ? item.prim.h : item.prim.ry * 2;
    return {left: item.prim.cx - width / 2, top: item.prim.cy - height / 2, width, height};
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sub of item.subpaths || []) {
    const verts = sub.verts || [];
    if (!verts.length) continue;
    for (const [x, y] of verts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const segCount = sub.closed ? verts.length : Math.max(0, verts.length - 1);
    for (let i = 0; i < segCount; i++) {
      const j = (i + 1) % verts.length;
      const p0 = verts[i], p3 = verts[j];
      const outT = (sub.outT && sub.outT[i]) || [0, 0];
      const inT = (sub.inT && sub.inT[j]) || [0, 0];
      if (!outT[0] && !outT[1] && !inT[0] && !inT[1]) continue;
      const [bx0, bx1] = cubicExtrema1D(p0[0], p0[0] + outT[0], p3[0] + inT[0], p3[0]);
      const [by0, by1] = cubicExtrema1D(p0[1], p0[1] + outT[1], p3[1] + inT[1], p3[1]);
      if (bx0 < minX) minX = bx0;
      if (bx1 > maxX) maxX = bx1;
      if (by0 < minY) minY = by0;
      if (by1 > maxY) maxY = by1;
    }
  }
  if (!Number.isFinite(minX)) return {left: 0, top: 0, width: 0, height: 0};
  return {left: minX, top: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY)};
}

function subpathsToSvgD(subpaths) {
  const parts = [];
  for (const sub of subpaths || []) {
    const verts = sub.verts || [];
    if (!verts.length) continue;
    parts.push(`M${num(verts[0][0])} ${num(verts[0][1])}`);
    const segCount = sub.closed ? verts.length : Math.max(0, verts.length - 1);
    for (let i = 0; i < segCount; i++) {
      const j = (i + 1) % verts.length;
      const p0 = verts[i], p3 = verts[j];
      const outT = (sub.outT && sub.outT[i]) || [0, 0];
      const inT = (sub.inT && sub.inT[j]) || [0, 0];
      if (!outT[0] && !outT[1] && !inT[0] && !inT[1]) {
        if (sub.closed && i === segCount - 1) continue;
        parts.push(`L${num(p3[0])} ${num(p3[1])}`);
      } else {
        parts.push(`C${num(p0[0] + outT[0])} ${num(p0[1] + outT[1])} ${num(p3[0] + inT[0])} ${num(p3[1] + inT[1])} ${num(p3[0])} ${num(p3[1])}`);
      }
    }
    if (sub.closed) parts.push('Z');
  }
  return parts.join('');
}

function geometryPathGroups(item) {
  const subs = item.subpaths || [];
  if (!subs.length) return [];
  if (subs.some(s => typeof s.pathGroup === 'number')) {
    const groups = new Map();
    for (const s of subs) {
      const key = typeof s.pathGroup === 'number' ? s.pathGroup : -1;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    return [...groups.values()].map(list => ({
      subs: list,
      evenOdd: list.some(s => s.evenOdd === true),
    }));
  }
  if (subs.some(s => typeof s.evenOdd === 'boolean')) {
    const nzSubs = subs.filter(s => s.evenOdd !== true);
    const eoSubs = subs.filter(s => s.evenOdd === true);
    const out = [];
    if (nzSubs.length) out.push({subs: nzSubs, evenOdd: false});
    if (eoSubs.length) out.push({subs: eoSubs, evenOdd: true});
    return out;
  }
  return [{subs, evenOdd: item.fillRule === 2}];
}

function geometryTag(item, extraAttrs = '', options = {}) {
  if (item.prim) {
    if (item.prim.k === 'rect') {
      const x = item.prim.cx - item.prim.w / 2;
      const y = item.prim.cy - item.prim.h / 2;
      const r = Math.max(0, Math.min(item.prim.r || 0, item.prim.w / 2, item.prim.h / 2));
      const rx = r > 0 ? ` rx="${num(r)}" ry="${num(r)}"` : '';
      return `<rect x="${num(x)}" y="${num(y)}" width="${num(item.prim.w)}" height="${num(item.prim.h)}"${rx}${extraAttrs}/>`;
    }
    return `<ellipse cx="${num(item.prim.cx)}" cy="${num(item.prim.cy)}" rx="${num(item.prim.rx)}" ry="${num(item.prim.ry)}"${extraAttrs}/>`;
  }
  const groups = geometryPathGroups(item);
  if (!groups.length) return '';
  const ruleAttrName = options.clipRule ? 'clip-rule' : 'fill-rule';
  const emitRule = options.applyRule === true;
  const parts = [];
  for (const g of groups) {
    const d = subpathsToSvgD(g.subs);
    if (!d) continue;
    const eoAttr = (emitRule && g.evenOdd) ? ` ${ruleAttrName}="evenodd"` : '';
    parts.push(`<path d="${d}"${eoAttr}${extraAttrs}/>`);
  }
  return parts.join('');
}

function strokeCapCss(cap) {
  if (cap === 2 || cap === 'ROUND' || cap === 'round') return 'round';
  if (cap === 3 || cap === 'SQUARE' || cap === 'square') return 'square';
  return 'butt';
}

function strokeJoinCss(join) {
  if (join === 2 || join === 'ROUND' || join === 'round') return 'round';
  if (join === 3 || join === 'BEVEL' || join === 'bevel') return 'bevel';
  return 'miter';
}

function strokeDashAttr(dash, dashOffset) {
  let attr = '';
  if (Array.isArray(dash) && dash.length) {
    attr += ` stroke-dasharray="${dash.map(num).join(' ')}"`;
  } else if (typeof dash === 'string' && dash.trim() && dash.trim() !== 'none') {
    attr += ` stroke-dasharray="${escapeHtml(dash.trim())}"`;
  }
  if (dashOffset != null && Number.isFinite(Number(dashOffset)) && Number(dashOffset) !== 0) {
    attr += ` stroke-dashoffset="${num(Number(dashOffset))}"`;
  }
  return attr;
}

function svgGradientDef(id, gradient) {
  const stops = (gradient.stops || []).map(s => {
    const offset = `${num(clamp01(s.offset) * 100)}%`;
    const op = s.opacity == null ? 1 : clamp01(s.opacity);
    const opAttr = op < 0.9995 ? ` stop-opacity="${num(op)}"` : '';
    return `<stop offset="${offset}" stop-color="${colorHex(s.color)}"${opAttr}/>`;
  }).join('');
  if (gradient.type === 'radial') {
    const cx = gradient.start[0], cy = gradient.start[1];
    if (gradient.p2) {
      const ux = gradient.end[0] - cx, uy = gradient.end[1] - cy;
      const vx = gradient.p2[0] - cx, vy = gradient.p2[1] - cy;
      if (Math.hypot(ux, uy) > 1e-4 && Math.hypot(vx, vy) > 1e-4) {
        return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="matrix(${num(ux)} ${num(uy)} ${num(vx)} ${num(vy)} ${num(cx)} ${num(cy)})">${stops}</radialGradient>`;
      }
    }
    const r = Math.max(0.001, Math.hypot(gradient.end[0] - cx, gradient.end[1] - cy));
    return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}">${stops}</radialGradient>`;
  }
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(gradient.start[0])}" y1="${num(gradient.start[1])}" x2="${num(gradient.end[0])}" y2="${num(gradient.end[1])}">${stops}</linearGradient>`;
}

function textGradientCss(item, grad, boxLeft, boxTop) {
  const left = boxLeft != null ? boxLeft : item.x;
  const top = boxTop != null ? boxTop : item.y;
  const w = item.lw || item.w || 1;
  const h = item.lh || item.h || 1;
  const p0 = grad.p0 || [left + (grad.h0 ? grad.h0.x : 0) * w, top + (grad.h0 ? grad.h0.y : 0) * h];
  const p1 = grad.p1 || [left + (grad.h1 ? grad.h1.x : 1) * w, top + (grad.h1 ? grad.h1.y : 0) * h];
  const paintOpacity = grad.opacity == null ? 1 : clamp01(grad.opacity);
  const stops = (grad.stops || []).map(s => {
    const a = (s.opacity == null ? 1 : clamp01(s.opacity)) * paintOpacity;
    return `${colorCss(s.color, a)} ${num(clamp01(s.offset) * 100)}%`;
  }).join(', ');
  if (grad.type === 'radial') {
    const pos = grad.h0 ? `${num(grad.h0.x * 100)}% ${num(grad.h0.y * 100)}%` : `${px(p0[0] - left)} ${px(p0[1] - top)}`;
    const rx = Math.max(1, Math.hypot(p1[0] - p0[0], p1[1] - p0[1]));
    if (grad.p2) {
      const ry = Math.max(1, Math.hypot(grad.p2[0] - p0[0], grad.p2[1] - p0[1]));
      return `radial-gradient(${px(rx)} ${px(ry)} at ${pos}, ${stops})`;
    }
    return `radial-gradient(circle ${px(rx)} at ${pos}, ${stops})`;
  }
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return `linear-gradient(${stops})`;
  // CSS stretches percentage stops over its own gradient line (through the box centre, long
  // enough to touch the far corners), so percentages ignore where Figma's handles sit. Place
  // every stop in px on that line instead, at the projection of p0 + t * (p1 - p0).
  const ux = dx / len, uy = dy / len;
  const lineLen = Math.abs(w * ux) + Math.abs(h * uy);
  const cx = left + w / 2, cy = top + h / 2;
  const base = (p0[0] - cx) * ux + (p0[1] - cy) * uy + lineLen / 2;
  const pxStops = (grad.stops || []).map(s => {
    const a = (s.opacity == null ? 1 : clamp01(s.opacity)) * paintOpacity;
    return `${colorCss(s.color, a)} ${px(base + clamp01(s.offset) * len)}`;
  }).join(', ');
  const cssAngle = Math.atan2(dx, -dy) * 180 / Math.PI;
  return `linear-gradient(${num(cssAngle)}deg, ${pxStops})`;
}

function needsSvgEffectFilter(item) {
  const fxList = item.fx || [];
  return fxList.some(fx => fx.kind === 'inner' || (fx.kind === 'drop' && Math.abs(fx.spread || 0) > 1e-4));
}

function buildSvgEffectFilter(id, fxList, viewBox) {
  const drops = fxList.filter(fx => fx.kind === 'drop');
  const inners = fxList.filter(fx => fx.kind === 'inner');
  if (!drops.length && !inners.length) return '';
  let pad = 24;
  for (const fx of fxList) {
    if (fx.kind === 'drop' || fx.kind === 'inner') {
      pad = Math.max(pad, Math.ceil((fx.blur || 0) * 2 + Math.abs(fx.spread || 0) + Math.max(Math.abs(fx.dx || 0), Math.abs(fx.dy || 0))) + 8);
    }
  }
  const primitives = [];
  const dropNodes = [];
  drops.forEach((fx, i) => {
    const spread = fx.spread || 0;
    let alphaSrc = 'SourceAlpha';
    if (Math.abs(spread) > 1e-4) {
      const op = spread > 0 ? 'dilate' : 'erode';
      const morphId = `d_m${i}`;
      primitives.push(`<feMorphology in="SourceAlpha" operator="${op}" radius="${num(Math.abs(spread))}" result="${morphId}"/>`);
      alphaSrc = morphId;
    }
    const offId = `d_o${i}`;
    primitives.push(`<feOffset in="${alphaSrc}" dx="${num(fx.dx || 0)}" dy="${num(fx.dy || 0)}" result="${offId}"/>`);
    const blurId = `d_b${i}`;
    const std = Math.max(0, (fx.blur || 0) / 2);
    if (std > 1e-4) {
      primitives.push(`<feGaussianBlur in="${offId}" stdDeviation="${num(std)}" result="${blurId}"/>`);
    }
    const floodId = `d_f${i}`;
    const col = colorHex(fx.color || [0, 0, 0]);
    const alpha = clamp01(fx.alpha == null ? 1 : fx.alpha);
    primitives.push(`<feFlood flood-color="${col}" flood-opacity="${num(alpha)}" result="${floodId}"/>`);
    const outId = `d_r${i}`;
    primitives.push(`<feComposite in="${floodId}" in2="${std > 1e-4 ? blurId : offId}" operator="in" result="${outId}"/>`);
    dropNodes.push(`<feMergeNode in="${outId}"/>`);
  });

  const innerNodes = [];
  inners.forEach((fx, i) => {
    const spread = fx.spread || 0;
    const invFlood = `i_w${i}`;
    const invAlpha = `i_inv${i}`;
    primitives.push(`<feFlood flood-color="#ffffff" flood-opacity="1" result="${invFlood}"/>`);
    primitives.push(`<feComposite in="${invFlood}" in2="SourceAlpha" operator="out" result="${invAlpha}"/>`);
    let src = invAlpha;
    if (Math.abs(spread) > 1e-4) {
      const op = spread > 0 ? 'dilate' : 'erode';
      const morphId = `i_m${i}`;
      primitives.push(`<feMorphology in="${src}" operator="${op}" radius="${num(Math.abs(spread))}" result="${morphId}"/>`);
      src = morphId;
    }
    const offId = `i_o${i}`;
    primitives.push(`<feOffset in="${src}" dx="${num(fx.dx || 0)}" dy="${num(fx.dy || 0)}" result="${offId}"/>`);
    const blurId = `i_b${i}`;
    const std = Math.max(0, (fx.blur || 0) / 2);
    if (std > 1e-4) {
      primitives.push(`<feGaussianBlur in="${offId}" stdDeviation="${num(std)}" result="${blurId}"/>`);
    }
    const floodId = `i_f${i}`;
    const col = colorHex(fx.color || [0, 0, 0]);
    const alpha = clamp01(fx.alpha == null ? 1 : fx.alpha);
    primitives.push(`<feFlood flood-color="${col}" flood-opacity="${num(alpha)}" result="${floodId}"/>`);
    const tintedId = `i_t${i}`;
    primitives.push(`<feComposite in="${floodId}" in2="${std > 1e-4 ? blurId : offId}" operator="in" result="${tintedId}"/>`);
    const clippedId = `i_r${i}`;
    primitives.push(`<feComposite in="${tintedId}" in2="SourceAlpha" operator="in" result="${clippedId}"/>`);
    innerNodes.push(`<feMergeNode in="${clippedId}"/>`);
  });

  primitives.push(`<feMerge>${dropNodes.join('')}<feMergeNode in="SourceGraphic"/>${innerNodes.join('')}</feMerge>`);
  return `<filter id="${id}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB" x="${num(viewBox.x - pad)}" y="${num(viewBox.y - pad)}" width="${num(viewBox.w + pad * 2)}" height="${num(viewBox.h + pad * 2)}">${primitives.join('')}</filter>`;
}

function effectsToCss(item, isCssBox = false, options = {}) {
  const filters = [];
  const boxShadows = [];
  const textShadows = [];
  const skipShadows = !!options.skipShadows;
  const useTextShadow = !!options.useTextShadow;
  let bgBlur = item.bgBlur || 0;
  let fxBgBlur = 0;
  let fxLayerBlur = 0;
  for (const fx of item.fx || []) {
    if (fx.kind === 'blur' && (fx.radius || 0) > fxLayerBlur) fxLayerBlur = fx.radius;
    else if (fx.kind === 'bgblur' && (fx.radius || 0) > fxBgBlur) fxBgBlur = fx.radius;
    else if (!skipShadows && fx.kind === 'drop') {
      const col = colorCss(fx.color, fx.alpha == null ? 1 : fx.alpha);
      if (isCssBox) {
        boxShadows.push(`${px(fx.dx || 0)} ${px(fx.dy || 0)} ${px(fx.blur || 0)} ${px(fx.spread || 0)} ${col}`);
      } else if (useTextShadow) {
        textShadows.push(`${px(fx.dx || 0)} ${px(fx.dy || 0)} ${px(fx.blur || 0)} ${col}`);
      } else {
        filters.push(`drop-shadow(${px(fx.dx || 0)} ${px(fx.dy || 0)} ${px((fx.blur || 0) / 2)} ${col})`);
      }
    } else if (!skipShadows && fx.kind === 'inner' && isCssBox) {
      const col = colorCss(fx.color, fx.alpha == null ? 1 : fx.alpha);
      boxShadows.push(`inset ${px(fx.dx || 0)} ${px(fx.dy || 0)} ${px(fx.blur || 0)} ${px(fx.spread || 0)} ${col}`);
    }
  }
  bgBlur = Math.max(bgBlur, fxBgBlur);
  // svgParser folds fx bgblur into item.blur for AE; avoid double-applying it as filter: blur().
  const rawBlur = item.blur || 0;
  const layerBlur = fxBgBlur > 0 && rawBlur <= fxBgBlur ? fxLayerBlur : Math.max(rawBlur, fxLayerBlur);
  if (layerBlur > 0) filters.push(`blur(${px(layerBlur / 2)})`);
  const decls = [];
  if (filters.length) decls.push(`filter: ${filters.join(' ')};`);
  if (textShadows.length) decls.push(`text-shadow: ${textShadows.join(', ')};`);
  if (bgBlur > 0) {
    decls.push(`backdrop-filter: blur(${px(bgBlur / 2)});`);
    decls.push(`-webkit-backdrop-filter: blur(${px(bgBlur / 2)});`);
  }
  return {decls, boxShadows, textShadows};
}

function maxShapeStrokeWidth(item) {
  let maxW = 0;
  if ((item.stroke != null || item.strokeGradient) && item.strokeWidth > 0) maxW = Math.max(maxW, item.strokeWidth);
  if (item.layerStroke && item.layerStroke.width > 0) maxW = Math.max(maxW, item.layerStroke.width);
  for (const p of item.extraPaints || []) {
    if (p.kind === 'stroke' && p.width > 0) maxW = Math.max(maxW, p.width);
  }
  return maxW;
}

function isSimpleCssPrim(item) {
  if (!item.prim) return false;
  if (item.gradient || item.strokeGradient) return false;
  if (item.extraPaints && item.extraPaints.length) return false;
  if (item.strokeDash && item.strokeDash.length) return false;
  const stroke = item.layerStroke || (item.stroke && item.strokeWidth > 0
    ? {color: item.stroke, width: item.strokeWidth, opacity: item.strokeOpacity, align: item.strokeAlign || 'CENTER'}
    : null);
  if (stroke && stroke.align !== 'INSIDE' && stroke.align !== 'OUTSIDE') return false;
  return true;
}

function buildWebModel(packet) {
  const data = normalize(packet);
  const warnings = [];
  const counts = {containers: 0, minimal: 0, shapes: 0, texts: 0, images: 0, masks: 0};
  const assets = [];
  const cssRules = [];
  const fontFaceRules = [];
  const seenFontFaces = new Map();
  const rootDefs = [];
  let seq = 0;
  let defSeq = 0;

  const nextId = (prefix = 'f2a-n') => prefix + (++seq);
  const nextDef = (prefix = 'f2a-d') => prefix + (++defSeq);

  function fontFamilyWithAlias(family, style) {
    const fam = String(family || 'sans-serif').trim();
    const sty = String(style || 'Regular').trim();
    const weight = fontWeightFromStyle(sty);
    const fStyle = fontStyleFromStyle(sty);
    const key = `${fam}\0${sty}`;
    if (fam && !/^(sans-serif|serif|monospace|system-ui)$/i.test(fam) && !/^regular$/i.test(sty)) {
      let alias = seenFontFaces.get(key);
      if (!alias) {
        alias = `f2a-font-${seenFontFaces.size + 1}`;
        seenFontFaces.set(key, alias);
        const famNoSpace = fam.replace(/\s+/g, '');
        const styNoSpace = sty.replace(/\s+/g, '');
        const candidates = [...new Set([
          `${fam} ${sty}`,
          `${fam}-${sty}`,
          `${famNoSpace}-${styNoSpace}`,
          `${famNoSpace}${styNoSpace}`,
          `${fam} ${styNoSpace}`,
        ])].map(name => `local("${name.replaceAll('"', '\\"')}")`).join(', ');
        fontFaceRules.push(
          `@font-face { font-family: "${alias}"; font-weight: ${weight}; font-style: ${fStyle}; src: ${candidates}; }`
        );
      }
      return `"${alias}", ${cssFontFamily(fam)}`;
    }
    return cssFontFamily(fam);
  }

  // Decode all images once and reserve clean filenames
  const decodedImages = new Map();
  let referenceAsset = null;
  data.images.forEach((im, index) => {
    if (im.shadowBase) {
      const error = new Error('图层「' + (im.name || '图片') + '」无法导出：投影图片未完成处理');
      error.nodeId = im.sourceId || null;
      throw error;
    }
    const ext = String(im.ext || 'png').toLowerCase();
    if (!VALID_IMAGE_EXTS.has(ext)) {
      const error = new Error('不支持的图片格式：' + ext);
      error.nodeId = im.sourceId || null;
      throw error;
    }
    if (im.imageFilters) gradeControls(im.imageFilters);
    const raw = String(im.data || '');
    if (!raw || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 !== 0) {
      const error = new Error('图片「' + (im.name || 'image') + '」的 base64 数据无效');
      error.nodeId = im.sourceId || null;
      throw error;
    }
    const bytes = Buffer.from(raw, 'base64');
    const dims = imageDimensions(bytes, ext);
    const natW = (dims && dims.width) || im.natW || im.cw || im.w || 1;
    const natH = (dims && dims.height) || im.natH || im.ch || im.h || 1;
    const file = im.reference ? `assets/reference.${ext}` : `assets/${String(index).padStart(4, '0')}.${ext}`;
    assets.push({file, bytes});
    const record = {file, ext, bytes, base64: raw, natW, natH, item: im};
    if (im.reference) referenceAsset = record;
    decodedImages.set(index, record);
  });

  // Index masks (vector & image masks)
  const maskDefs = new Map();
  const imageMaskDefs = new Map();
  for (const shape of data.shapes) {
    if (shape.maskSource) {
      if (!maskDefs.has(shape.maskSource)) maskDefs.set(shape.maskSource, []);
      maskDefs.get(shape.maskSource).push(shape);
    }
  }
  data.images.forEach((image, index) => {
    if (image.maskSource) imageMaskDefs.set(image.maskSource, {image, index});
  });

  // Build container hierarchy
  const rootContext = {
    id: null,
    domId: 'f2a-stage',
    name: data.name,
    pathNames: [],
    x: 0,
    y: 0,
    w: data.width,
    h: data.height,
    entries: [],
  };
  const contexts = new Map([[null, rootContext]]);
  const sortedContainers = [...data.containers].sort((a, b) => (a.path || []).length - (b.path || []).length);

  function parentOf(item) {
    const p = item.path || [];
    for (let i = p.length - 1; i >= 0; i--) {
      if (contexts.has(p[i])) return contexts.get(p[i]);
    }
    return rootContext;
  }

  for (const container of sortedContainers) {
    const parent = parentOf(container);
    const bounds = compBounds(container);
    const domId = nextId();
    const pathNames = parent.pathNames.concat([container.name || 'Group']);
    const ctx = {
      id: container.id,
      domId,
      name: container.name || 'Group',
      pathNames,
      container,
      x: bounds.x,
      y: bounds.y,
      w: bounds.w,
      h: bounds.h,
      entries: [],
    };
    contexts.set(container.id, ctx);
    parent.entries.push({z: container.z || 0, tie: 4, kind: 'container', item: container, ctx});
  }

  for (const shape of data.shapes) {
    if (shape.maskSource) continue;
    const effFillOp = shape.layerStroke ? (shape.layerFillOpacity == null ? 1 : shape.layerFillOpacity) : (shape.fillOpacity == null ? 1 : shape.fillOpacity);
    const hasFill = (shape.fill != null && effFillOp > 0) || !!shape.gradient;
    const hasStroke = shape.stroke != null || !!shape.strokeGradient || !!shape.layerStroke;
    const hasExtra = !!(shape.extraPaints && shape.extraPaints.length);
    const hasFx = !!(shape.fx && shape.fx.length) || !!shape.blur || !!shape.bgBlur;
    if (shape.imageSlot && !hasFill && !hasStroke && !hasExtra && !hasFx) continue;
    const tie = (shape.imageSlot && !hasFill) ? 2 : 0;
    parentOf(shape).entries.push({z: shape.z || 0, tie, kind: 'shape', item: shape});
  }
  for (const text of data.texts) {
    parentOf(text).entries.push({z: text.z || 0, tie: 3, kind: 'text', item: text});
  }
  data.images.forEach((image, index) => {
    if (image.maskSource || image.reference) return;
    parentOf(image).entries.push({z: image.z || 0, tie: 1, kind: 'image', item: image, index});
  });

  function createMaskDef(maskId, parentCtx) {
    const imageMask = imageMaskDefs.get(maskId);
    const vectorMasks = maskDefs.get(maskId);
    if (!imageMask && (!vectorMasks || !vectorMasks.length)) {
      const error = new Error('缺少 Figma 蒙版：' + maskId);
      throw error;
    }
    const defId = nextDef('f2a-mask-');
    let luma = false;
    let inner = '';
    if (imageMask) {
      const {image, index} = imageMask;
      const asset = decodedImages.get(index);
      luma = image.maskType === 'LUMINANCE';
      const nw = asset.natW, nh = asset.natH;
      const w = image.cw ?? image.w, h = image.ch ?? image.h;
      const cx = image.cx ?? (image.x + image.w / 2);
      const cy = image.cy ?? (image.y + image.h / 2);
      const rot = image.rotation || 0;
      const opacity = image.opacity == null ? 1 : clamp01(image.opacity);
      const mime = asset.ext === 'jpg' ? 'jpeg' : asset.ext;
      const maskHref = `data:image/${mime};base64,${asset.base64}`;
      let imgTag;
      if (image.imageMatrix) {
        const m = image.imageMatrix;
        const a = m[0] / nw, b = m[1] / nw, c = m[2] / nh, d = m[3] / nh;
        imgTag = `<image href="${maskHref}" preserveAspectRatio="none" width="${num(nw)}" height="${num(nh)}" opacity="${num(opacity)}" transform="matrix(${num(a)} ${num(b)} ${num(c)} ${num(d)} ${num(m[4])} ${num(m[5])})"/>`;
      } else {
        const scale = image.rasterScale ? (1 / image.rasterScale) : (image.scaleMode === 'FIT' ? Math.min(w / nw, h / nh) : Math.max(w / nw, h / nh));
        const dw = nw * scale, dh = nh * scale;
        const tf = rot
          ? ` transform="translate(${num(cx)} ${num(cy)}) rotate(${num(rot)}) translate(${num(-dw / 2)} ${num(-dh / 2)})"`
          : ` x="${num(cx - dw / 2)}" y="${num(cy - dh / 2)}"`;
        imgTag = `<image href="${maskHref}" preserveAspectRatio="none" width="${num(dw)}" height="${num(dh)}" opacity="${num(opacity)}"${tf}/>`;
      }
      if (image.matte) {
        const clipId = nextDef('f2a-mclip-');
        const mattePrim = image.matte.kind === 'ellipse'
          ? {k: 'ellipse', cx: 0, cy: 0, rx: w / 2, ry: h / 2}
          : {k: 'rect', cx: 0, cy: 0, w, h, r: image.matte.r || 0};
        const matteTf = rot ? `translate(${num(cx)} ${num(cy)}) rotate(${num(rot)})` : `translate(${num(cx)} ${num(cy)})`;
        rootDefs.push(`<clipPath id="${clipId}">${geometryTag({prim: mattePrim}, ` transform="${matteTf}"`)}</clipPath>`);
        imgTag = `<g clip-path="url(#${clipId})">${imgTag}</g>`;
      }
      inner = imgTag;
    } else {
      luma = vectorMasks[0].maskType === 'LUMINANCE';
      const parts = [];
      for (const def of vectorMasks) {
        const op = (def.opacity == null ? 1 : clamp01(def.opacity)) * (luma ? (def.fillOpacity == null ? 1 : clamp01(def.fillOpacity)) : 1);
        let fillValue = '#ffffff';
        if (luma) {
          if (def.gradient) {
            const gid = nextDef('f2a-mgrad-');
            rootDefs.push(svgGradientDef(gid, def.gradient));
            fillValue = `url(#${gid})`;
          } else {
            fillValue = colorHex(def.fill || [1, 1, 1]);
          }
        }
        const multiPath = geometryPathGroups(def).length > 1;
        let geom;
        if (multiPath && op < 0.9995) {
          const innerPaths = geometryTag({subpaths: def.subpaths, fillRule: def.fillRule}, ` fill="${fillValue}"`, {applyRule: true});
          geom = innerPaths ? `<g opacity="${num(op)}">${innerPaths}</g>` : '';
        } else {
          geom = geometryTag({subpaths: def.subpaths, fillRule: def.fillRule}, ` fill="${fillValue}" fill-opacity="${num(op)}"`, {applyRule: true});
        }
        if (geom) parts.push(geom);
      }
      inner = parts.join('');
    }
    const mode = luma ? 'luminance' : 'alpha';
    const shift = (parentCtx.x || parentCtx.y) ? ` transform="translate(${num(-parentCtx.x)} ${num(-parentCtx.y)})"` : '';
    const maskX = Math.min(0, -parentCtx.x);
    const maskY = Math.min(0, -parentCtx.y);
    const maskW = Math.max(parentCtx.w, data.width - parentCtx.x) - maskX;
    const maskH = Math.max(parentCtx.h, data.height - parentCtx.y) - maskY;
    rootDefs.push(
      `<mask id="${defId}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" style="mask-type:${mode}" x="${num(maskX)}" y="${num(maskY)}" width="${num(maskW)}" height="${num(maskH)}"><g${shift}>${inner}</g></mask>`
    );
    counts.masks++;
    return {defId, mode};
  }

  function wrapMaskIfNeeded(html, item, parentCtx, indent) {
    if (!item.maskId) return html;
    const {defId, mode} = createMaskDef(item.maskId, parentCtx);
    const hostId = nextId('f2a-mh');
    const blend = BLEND_CSS[item.blend];
    const blendDecl = blend ? ` mix-blend-mode: ${blend};` : '';
    cssRules.push(
      `#${hostId} { mask-image: url(#${defId}); -webkit-mask-image: url(#${defId}); mask-mode: ${mode}; -webkit-mask-mode: ${mode};${blendDecl} }`
    );
    return `${indent}<div id="${hostId}" class="f2a-mask-host" data-mask-id="${escapeHtml(item.maskId)}">\n${html}\n${indent}</div>`;
  }

  function commonDecls(item, {isCssBox = false, allowOpacity = true, skipShadows = false, useTextShadow = false} = {}) {
    const decls = [];
    if (allowOpacity && item.opacity != null && item.opacity < 0.9995) {
      decls.push(`opacity: ${num(clamp01(item.opacity))};`);
    }
    const blend = !item.maskId && BLEND_CSS[item.blend];
    if (blend) decls.push(`mix-blend-mode: ${blend};`);
    const fx = effectsToCss(item, isCssBox, {skipShadows, useTextShadow});
    decls.push(...fx.decls);
    return {decls, boxShadows: fx.boxShadows, textShadows: fx.textShadows};
  }

  function dataAttrs(domId, item, pathNames, kind, extra = '') {
    const attrs = [
      `id="${domId}"`,
      `data-layer-name="${escapeHtml(item.name || 'Layer')}"`,
      `data-layer-path="${escapeHtml(pathNames.join('/'))}"`,
      `data-layer-kind="${kind}"`,
    ];
    if (item.sourceId) attrs.push(`data-source-id="${escapeHtml(item.sourceId)}"`);
    if (item.singleLayer) attrs.push('data-minimal="true"');
    if (item.hidden) attrs.push('data-hidden="true"');
    if (extra) attrs.push(extra);
    return attrs.join(' ');
  }

  function renderSvgStroke(item, strokeColor, strokeGrad, strokeOpacity, width, align, cap, join, miter, dash, dashOffset, viewBox, localDefs) {
    if (!width || width <= 0) return '';
    let strokePaint;
    if (strokeGrad) {
      const gid = nextDef('f2a-sg-');
      localDefs.push(svgGradientDef(gid, strokeGrad));
      strokePaint = `url(#${gid})`;
    } else {
      strokePaint = colorHex(strokeColor || [0, 0, 0]);
    }
    const op = clamp01(strokeOpacity == null ? 1 : strokeOpacity);
    const multiPath = !item.prim && geometryPathGroups(item).length > 1;
    const isolateOp = multiPath && op < 0.9995;
    const miterAttr = miter != null ? ` stroke-miterlimit="${num(miter)}"` : '';
    const baseAttrs =
      ` fill="none" stroke="${strokePaint}"` +
      (!isolateOp && op < 0.9995 ? ` stroke-opacity="${num(op)}"` : '') +
      ` stroke-linecap="${strokeCapCss(cap)}" stroke-linejoin="${strokeJoinCss(join)}"${miterAttr}` +
      strokeDashAttr(dash, dashOffset);

    let stroked;
    if (align === 'INSIDE') {
      const clipId = nextDef('f2a-ic-');
      localDefs.push(`<clipPath id="${clipId}">${geometryTag(item, '', {applyRule: true, clipRule: true})}</clipPath>`);
      stroked = geometryTag(item, `${baseAttrs} stroke-width="${num(width * 2)}" clip-path="url(#${clipId})"`);
    } else if (align === 'OUTSIDE') {
      const maskId = nextDef('f2a-om-');
      localDefs.push(
        `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="${num(viewBox.x)}" y="${num(viewBox.y)}" width="${num(viewBox.w)}" height="${num(viewBox.h)}">` +
        `<rect x="${num(viewBox.x)}" y="${num(viewBox.y)}" width="${num(viewBox.w)}" height="${num(viewBox.h)}" fill="#ffffff"/>` +
        `${geometryTag(item, ' fill="#000000"', {applyRule: true})}</mask>`
      );
      stroked = geometryTag(item, `${baseAttrs} stroke-width="${num(width * 2)}" mask="url(#${maskId})"`);
    } else {
      stroked = geometryTag(item, `${baseAttrs} stroke-width="${num(width)}"`);
    }
    return (isolateOp && stroked) ? `<g opacity="${num(op)}">${stroked}</g>` : stroked;
  }

  function renderShape(item, parentCtx, indent) {
    const domId = nextId();
    const pathNames = parentCtx.pathNames.concat([item.name || 'Shape']);
    counts.shapes++;

    // Chromium pixel-snaps CSS boxes to physical pixels (shifting fractional OR odd coords on
    // 125%/150%/175% displays). Only 4px-grid-aligned primitives (or backdrop-blur cards, which
    // need CSS backdrop-filter) stay CSS boxes; everything else goes through 4px-aligned SVG.
    const primRect = item.prim ? shapeRect(item) : null;
    const backdrop = !!item.bgBlur || (item.fx || []).some(fx => fx.kind === 'bgblur');
    const cssBoxOk = !!primRect && (backdrop || [
      primRect.left, primRect.top, primRect.left + primRect.width, primRect.top + primRect.height,
    ].every(isGridAligned));
    if (isSimpleCssPrim(item) && cssBoxOk) {
      const rect = primRect;
      const {decls, boxShadows} = commonDecls(item, {isCssBox: true});
      const fillOpacity = item.layerStroke ? (item.layerFillOpacity == null ? 1 : item.layerFillOpacity) : (item.fillOpacity == null ? 1 : item.fillOpacity);
      if (item.fill != null && fillOpacity > 0) {
        decls.push(`background: ${colorCss(item.fill, fillOpacity)};`);
      }
      if (item.prim.k === 'ellipse') {
        decls.push('border-radius: 50%;');
      } else if (item.prim.r > 0) {
        decls.push(`border-radius: ${px(Math.min(item.prim.r, rect.width / 2, rect.height / 2))};`);
      }
      const stroke = item.layerStroke || (item.stroke && item.strokeWidth > 0
        ? {color: item.stroke, width: item.strokeWidth, opacity: item.strokeOpacity, align: item.strokeAlign || 'CENTER'}
        : null);
      if (stroke && stroke.width > 0) {
        const sc = colorCss(stroke.color, stroke.opacity == null ? 1 : stroke.opacity);
        if (stroke.align === 'INSIDE') boxShadows.unshift(`inset 0 0 0 ${px(stroke.width)} ${sc}`);
        else if (stroke.align === 'OUTSIDE') boxShadows.push(`0 0 0 ${px(stroke.width)} ${sc}`);
      }
      if (boxShadows.length) decls.push(`box-shadow: ${boxShadows.join(', ')};`);
      decls.unshift(
        `left: ${px(rect.left - parentCtx.x)};`,
        `top: ${px(rect.top - parentCtx.y)};`,
        `width: ${px(rect.width)};`,
        `height: ${px(rect.height)};`
      );
      cssRules.push(`/* ${escapeCssComment(pathNames.join(' / '))} */\n#${domId} { ${decls.join(' ')} }`);
      const html = `${indent}<div ${dataAttrs(domId, item, pathNames, 'shape', 'class="f2a-shape f2a-prim"')}></div>`;
      return {
        html: wrapMaskIfNeeded(html, item, parentCtx, indent),
        meta: {
          id: domId, sourceId: item.sourceId || null, name: item.name || 'Shape', path: pathNames.join('/'),
          kind: 'shape', singleLayer: false, hidden: !!item.hidden, hasMask: !!item.maskId,
          bounds: {x: rect.left, y: rect.top, w: rect.width, h: rect.height},
        },
      };
    }

    // Inline SVG for arbitrary paths, gradients, center strokes, multi-paints, dashes
    const rect = shapeRect(item);
    const strokePad = Math.ceil(maxShapeStrokeWidth(item) * 2) + 2;
    const vx = floorGrid(rect.left - strokePad);
    const vy = floorGrid(rect.top - strokePad);
    const vw = Math.max(PIXEL_GRID, ceilGrid(rect.left + rect.width + strokePad) - vx);
    const vh = Math.max(PIXEL_GRID, ceilGrid(rect.top + rect.height + strokePad) - vy);
    const viewBox = {x: vx, y: vy, w: vw, h: vh};

    const localDefs = [];
    const layers = [];

    function emitFill(geomItem, color, gradient, opacity) {
      const op = clamp01(opacity == null ? 1 : opacity);
      if (op <= 0) return;
      let fillPaint;
      if (gradient) {
        const gid = nextDef('f2a-fg-');
        localDefs.push(svgGradientDef(gid, gradient));
        fillPaint = `url(#${gid})`;
      } else if (color != null) {
        fillPaint = colorHex(color);
      } else {
        return;
      }
      const multiPath = !geomItem.prim && geometryPathGroups(geomItem).length > 1;
      if (multiPath && op < 0.9995) {
        const tag = geometryTag(geomItem, ` fill="${fillPaint}"`, {applyRule: true});
        if (tag) layers.push(`<g opacity="${num(op)}">${tag}</g>`);
      } else {
        const opAttr = op < 0.9995 ? ` fill-opacity="${num(op)}"` : '';
        const tag = geometryTag(geomItem, ` fill="${fillPaint}"${opAttr}`, {applyRule: true});
        if (tag) layers.push(tag);
      }
    }

    // 1. Extra under-fills
    for (const paint of item.extraPaints || []) {
      if (paint.under) emitFill(item, paint.color, paint.gradient, paint.opacity);
    }
    // 2. Primary fill
    const primaryFillOpacity = item.layerStroke ? (item.layerFillOpacity == null ? 1 : item.layerFillOpacity) : (item.fillOpacity == null ? 1 : item.fillOpacity);
    if (item.fill != null || item.gradient) {
      emitFill(item, item.fill, item.gradient, primaryFillOpacity);
    }
    // 3. Primary stroke
    if (item.layerStroke && item.layerStroke.width > 0) {
      const s = item.layerStroke;
      const tag = renderSvgStroke(item, s.color, null, s.opacity, s.width, s.align || 'CENTER',
        item.strokeCap, item.strokeJoin, item.strokeMiter, null, null, viewBox, localDefs);
      if (tag) layers.push(tag);
    } else if ((item.stroke != null || item.strokeGradient) && item.strokeWidth > 0) {
      const tag = renderSvgStroke(item, item.stroke, item.strokeGradient, item.strokeOpacity, item.strokeWidth,
        item.strokeAlign || 'CENTER', item.strokeCap, item.strokeJoin, item.strokeMiter, item.strokeDash, item.strokeDashOffset, viewBox, localDefs);
      if (tag) layers.push(tag);
    }
    // 4. Extra top paints (additional strokes or outlined stroke subpaths)
    for (const paint of item.extraPaints || []) {
      if (paint.under) continue;
      if (paint.subpaths && paint.subpaths.length) {
        emitFill({subpaths: paint.subpaths, fillRule: paint.fillRule}, paint.color, paint.gradient, paint.opacity);
      } else if (paint.kind === 'stroke') {
        const tag = renderSvgStroke(item, paint.color, paint.gradient, paint.opacity, paint.width ?? item.strokeWidth,
          paint.align || item.strokeAlign || 'CENTER', paint.cap || item.strokeCap, paint.join || item.strokeJoin,
          paint.miter ?? item.strokeMiter, paint.dash || item.strokeDash, paint.dashOffset ?? item.strokeDashOffset, viewBox, localDefs);
        if (tag) layers.push(tag);
      } else {
        emitFill(item, paint.color, paint.gradient, paint.opacity);
      }
    }

    let svgFilterId = null;
    if (needsSvgEffectFilter(item)) {
      const fid = nextDef('f2a-fx-');
      const filterDef = buildSvgEffectFilter(fid, item.fx || [], viewBox);
      if (filterDef) {
        localDefs.push(filterDef);
        svgFilterId = fid;
      }
    }

    const {decls} = commonDecls(item, {isCssBox: false, skipShadows: !!svgFilterId});
    decls.unshift(
      `left: ${px(vx - parentCtx.x)};`,
      `top: ${px(vy - parentCtx.y)};`,
      `width: ${px(vw)};`,
      `height: ${px(vh)};`
    );
    cssRules.push(`/* ${escapeCssComment(pathNames.join(' / '))} */\n#${domId} { ${decls.join(' ')} }`);
    const defsMarkup = localDefs.length ? `<defs>${localDefs.join('')}</defs>` : '';
    const bodyMarkup = svgFilterId ? `<g filter="url(#${svgFilterId})">${layers.join('')}</g>` : layers.join('');
    const html = `${indent}<svg ${dataAttrs(domId, item, pathNames, 'shape', 'class="f2a-svg"')} viewBox="${num(vx)} ${num(vy)} ${num(vw)} ${num(vh)}" width="${num(vw)}" height="${num(vh)}" overflow="visible">${defsMarkup}${bodyMarkup}</svg>`;
    return {
      html: wrapMaskIfNeeded(html, item, parentCtx, indent),
      meta: {
        id: domId, sourceId: item.sourceId || null, name: item.name || 'Shape', path: pathNames.join('/'),
        kind: 'shape', singleLayer: false, hidden: !!item.hidden, hasMask: !!item.maskId,
        bounds: {x: rect.left, y: rect.top, w: rect.width, h: rect.height},
      },
    };
  }

  function renderText(item, parentCtx, indent) {
    const domId = nextId();
    const pathNames = parentCtx.pathNames.concat([item.name || 'Text']);
    counts.texts++;

    const boxW = (typeof item.lw === 'number' && item.lw > 0) ? item.lw : item.w;
    const boxH = (typeof item.lh === 'number' && item.lh > 0) ? item.lh : item.h;
    const boxLeft = (typeof item.cx === 'number') ? (item.cx - boxW / 2) : item.x;
    const boxTop = (typeof item.cy === 'number') ? (item.cy - boxH / 2) : item.y;

    const baseStyle = (item.segs && item.segs[0]) || item;
    const baseFontSize = baseStyle.fontSize || 16;
    const autoResize = item.autoResize || (item.box ? 'HEIGHT' : 'WIDTH_AND_HEIGHT');
    const truncate = item.truncation === 'ENDING' || autoResize === 'TRUNCATE';
    const wraps = Boolean(item.box || ((autoResize === 'HEIGHT' || autoResize === 'NONE' || autoResize === 'TRUNCATE') && truncate));
    const trackingPx = baseStyle.tracking ? (baseStyle.tracking / 1000) * baseFontSize : 0;
    // Slight trailing buffer on wrapping non-truncated boxes prevents premature line breaks from OS font metric differences.
    const widthSlack = (wraps && !truncate) ? Math.max(1, trackingPx > 0 ? trackingPx : 0) : 0;

    const alignMap = {LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify'};
    const justifyMap = {LEFT: 'flex-start', CENTER: 'center', RIGHT: 'flex-end', JUSTIFIED: 'flex-start'};
    const vAlignMap = {TOP: 'flex-start', CENTER: 'center', BOTTOM: 'flex-end'};
    const hAlign = alignMap[item.align] || 'left';
    const vAlign = vAlignMap[item.vAlign] || 'flex-start';

    const hasGradient = Boolean(item.grad || (item.segs && item.segs.some(s => !!s.grad)));
    const {decls} = commonDecls(item, {isCssBox: false, useTextShadow: !hasGradient});
    decls.unshift(
      `left: ${px(boxLeft - parentCtx.x)};`,
      `top: ${px(boxTop - parentCtx.y)};`,
      `width: ${px(boxW + widthSlack)};`,
      `height: ${px(boxH)};`,
      'display: flex;',
      `align-items: ${vAlign};`,
      `justify-content: ${justifyMap[item.align] || 'flex-start'};`
    );

    decls.push(`text-align: ${hAlign};`);
    decls.push(`font-family: ${fontFamilyWithAlias(baseStyle.family, baseStyle.style)};`);
    decls.push(`font-size: ${px(baseFontSize)};`);
    decls.push(`font-weight: ${fontWeightFromStyle(baseStyle.style)};`);
    const fStyle = fontStyleFromStyle(baseStyle.style);
    if (fStyle !== 'normal') decls.push(`font-style: ${fStyle};`);
    const fStretch = fontStretchFromStyle(baseStyle.style);
    if (fStretch !== 'normal') decls.push(`font-stretch: ${fStretch};`);
    const lineHeightPx = item.leading != null ? item.leading : baseStyle.leading;
    if (lineHeightPx != null) decls.push(`line-height: ${px(lineHeightPx)};`);
    if (baseStyle.tracking) decls.push(`letter-spacing: ${num(baseStyle.tracking / 1000)}em;`);
    if (item.paragraphIndent) decls.push(`text-indent: ${px(item.paragraphIndent)};`);
    const baseDec = textDecorationCss(item.decoration);
    if (baseDec && (!item.segs || !item.segs.length)) decls.push(`text-decoration: ${baseDec};`);

    const hasStroke = !!(item.stroke && item.stroke.width > 0);
    const fillOpacity = item.fillOpacity == null ? 1 : clamp01(item.fillOpacity);
    const layeredStroke = hasStroke && item.stroke.align === 'OUTSIDE' && (!!item.grad || fillOpacity < 0.9995);

    const contentDecls = [];
    if (wraps) {
      contentDecls.push('display: block;', 'width: 100%;', 'min-width: 0;', 'white-space: pre-wrap;', 'overflow-wrap: break-word;', 'word-break: break-word;');
    } else {
      contentDecls.push('display: inline-block;', 'white-space: pre;');
    }
    if (truncate) {
      const clampLines = item.maxLines || (lineHeightPx && boxH ? Math.max(1, Math.floor(boxH / lineHeightPx)) : 1);
      if (clampLines <= 1) {
        contentDecls.push('overflow: hidden;', 'text-overflow: ellipsis;', 'white-space: nowrap;', 'max-width: 100%;');
      } else {
        contentDecls.push('display: -webkit-box;', '-webkit-box-orient: vertical;', `-webkit-line-clamp: ${clampLines};`, 'overflow: hidden;', 'text-overflow: ellipsis;');
      }
    }

    const fillDecls = [];
    if (item.grad) {
      // Unstroked gradient text clips on the OUTER box: its size and position are exactly the
      // Figma text box the gradient handles refer to, whereas the inner span shrinks to the run.
      const target = hasStroke ? fillDecls : decls;
      target.push(`background: ${textGradientCss(item, item.grad, boxLeft, boxTop)};`);
      target.push('-webkit-background-clip: text;', 'background-clip: text;', '-webkit-text-fill-color: transparent;', 'color: transparent;');
    } else if (!item.segs || !item.segs.length) {
      decls.push(`color: ${colorCss(item.color || [0, 0, 0], fillOpacity)};`);
    }

    if (hasStroke && !layeredStroke) {
      const sw = item.stroke.align === 'OUTSIDE' ? item.stroke.width * 2 : item.stroke.width;
      const sc = colorCss(item.stroke.color, item.stroke.opacity == null ? 1 : item.stroke.opacity);
      (item.grad ? fillDecls : decls).push(`-webkit-text-stroke: ${px(sw)} ${sc};`, 'paint-order: stroke fill;');
    }

    const transforms = [];
    if (item.rotation) transforms.push(`rotate(${num(item.rotation)}deg)`);
    if (item.skewX) transforms.push(`skewX(${num(item.skewX)}deg)`);
    if (transforms.length) decls.push(`transform: ${transforms.join(' ')};`);

    cssRules.push(`/* ${escapeCssComment(pathNames.join(' / '))} */\n#${domId} { ${decls.join(' ')} }`);

    function buildInnerContent(forStrokeBack) {
      if (item.segs && item.segs.length) {
        return item.segs.map(seg => {
          const sd = [
            `font-family:${fontFamilyWithAlias(seg.family, seg.style)}`,
            `font-size:${px(seg.fontSize || 16)}`,
            `font-weight:${fontWeightFromStyle(seg.style)}`,
          ];
          const sfStyle = fontStyleFromStyle(seg.style);
          if (sfStyle !== 'normal') sd.push(`font-style:${sfStyle}`);
          const sfStretch = fontStretchFromStyle(seg.style);
          if (sfStretch !== 'normal') sd.push(`font-stretch:${sfStretch}`);
          const sDec = textDecorationCss(seg.decoration);
          if (sDec) sd.push(`text-decoration:${sDec}`);
          if (!forStrokeBack) {
            if (seg.grad && !item.grad) {
              sd.push(`background:${textGradientCss(item, seg.grad, boxLeft, boxTop)}`, '-webkit-background-clip:text', 'background-clip:text', '-webkit-text-fill-color:transparent', 'color:transparent');
            } else if (!item.grad) {
              sd.push(`color:${colorCss(seg.color || [0, 0, 0], seg.opacity == null ? 1 : seg.opacity)}`);
            }
          }
          if (seg.tracking) sd.push(`letter-spacing:${num(seg.tracking / 1000)}em`);
          if (seg.leading != null) sd.push(`line-height:${px(seg.leading)}`);
          return `<span style="${escapeHtml(sd.join(';'))}">${escapeHtml(seg.characters)}</span>`;
        }).join('');
      }
      if (item.paragraphSpacing) {
        const paras = String(item.characters || '').split(/\r?\n/);
        return paras.map((line, i) => {
          const mb = i < paras.length - 1 ? ` style="margin-bottom:${px(item.paragraphSpacing)}"` : '';
          return `<p class="f2a-p"${mb}>${escapeHtml(line) || '&nbsp;'}</p>`;
        }).join('');
      }
      return escapeHtml(item.characters || '');
    }

    let bodyHtml;
    if (layeredStroke) {
      const stackId = nextId('f2a-ts');
      const backId = nextId('f2a-tb');
      const frontId = nextId('f2a-tf');
      const sc = colorCss(item.stroke.color, item.stroke.opacity == null ? 1 : item.stroke.opacity);
      cssRules.push(`#${stackId} { position: relative; ${contentDecls.join(' ')} }`);
      cssRules.push(`#${backId} { position: absolute; inset: 0; color: transparent; -webkit-text-fill-color: transparent; -webkit-text-stroke: ${px(item.stroke.width * 2)} ${sc}; pointer-events: none; }`);
      cssRules.push(`#${frontId} { position: relative; display: ${wraps ? 'block' : 'inline-block'}; ${fillDecls.join(' ')} }`);
      bodyHtml = `<span id="${stackId}" class="f2a-text-stack"><span id="${backId}" class="f2a-text-stroke" aria-hidden="true">${buildInnerContent(true)}</span><span id="${frontId}" class="f2a-text-fill">${buildInnerContent(false)}</span></span>`;
    } else {
      const contentId = nextId('f2a-tc');
      cssRules.push(`#${contentId} { ${contentDecls.concat(fillDecls).join(' ')} }`);
      bodyHtml = `<span id="${contentId}" class="f2a-text-content">${buildInnerContent(false)}</span>`;
    }

    const html = `${indent}<div ${dataAttrs(domId, item, pathNames, 'text', 'class="f2a-text"')}>${bodyHtml}</div>`;
    return {
      html: wrapMaskIfNeeded(html, item, parentCtx, indent),
      meta: {
        id: domId, sourceId: item.sourceId || null, name: item.name || 'Text', path: pathNames.join('/'),
        kind: 'text', singleLayer: false, hidden: !!item.hidden, hasMask: !!item.maskId,
        bounds: {x: boxLeft, y: boxTop, w: boxW, h: boxH},
      },
    };
  }

  function renderImage(item, index, parentCtx, indent) {
    const domId = nextId();
    const pathNames = parentCtx.pathNames.concat([item.name || 'Image']);
    const asset = decodedImages.get(index);
    counts.images++;

    const nw = asset.natW, nh = asset.natH;
    const width = item.cw ?? item.w;
    const height = item.ch ?? item.h;
    const cx = item.cx ?? (item.x + item.w / 2);
    const cy = item.cy ?? (item.y + item.h / 2);
    const rot = item.rotation || 0;

    const gradeAttrs = item.imageFilters
      ? ` data-image-filters="${escapeHtml(JSON.stringify(item.imageFilters))}" data-grade-src="data:image/${asset.ext === 'jpg' ? 'jpeg' : asset.ext};base64,${asset.base64}"`
      : '';

    const scale = item.rasterScale ? (1 / item.rasterScale) : (item.scaleMode === 'FIT' ? Math.min(width / nw, height / nh) : Math.max(width / nw, height / nh));
    const dw = nw * scale, dh = nh * scale;
    const imgLeft = cx - dw / 2, imgTop = cy - dh / 2;
    const plainGridImg = !item.matte && !item.imageMatrix && !rot && !needsSvgEffectFilter(item) &&
      [imgLeft, imgTop, imgLeft + dw, imgTop + dh].every(isGridAligned);

    let html;
    if (plainGridImg) {
      const {decls} = commonDecls(item, {isCssBox: false});
      decls.unshift(
        `left: ${px(imgLeft - parentCtx.x)};`,
        `top: ${px(imgTop - parentCtx.y)};`,
        `width: ${px(dw)};`,
        `height: ${px(dh)};`
      );
      cssRules.push(`/* ${escapeCssComment(pathNames.join(' / '))} */\n#${domId} { ${decls.join(' ')} }`);
      html = `${indent}<img ${dataAttrs(domId, item, pathNames, 'image', 'class="f2a-image"')} src="${escapeHtml(asset.file)}" alt="${escapeHtml(item.name || '')}" draggable="false"${gradeAttrs}>`;
    } else {
      // Render through a 4px-grid-aligned inline SVG so Blink never pixel-snaps odd/fractional
      // image positions or dimensions on 125%/150%/175% displays.
      let b;
      if (item.matte) {
        b = rotatedBounds(cx, cy, width, height, rot);
      } else if (item.imageMatrix) {
        const m = item.imageMatrix;
        const xs = [m[4], m[4] + m[0], m[4] + m[2], m[4] + m[0] + m[2]];
        const ys = [m[5], m[5] + m[1], m[5] + m[3], m[5] + m[1] + m[3]];
        b = {minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys)};
      } else {
        b = rotatedBounds(cx, cy, dw, dh, rot);
      }
      const vx = floorGrid(b.minX);
      const vy = floorGrid(b.minY);
      const vw = Math.max(PIXEL_GRID, ceilGrid(b.maxX) - vx);
      const vh = Math.max(PIXEL_GRID, ceilGrid(b.maxY) - vy);
      const viewBox = {x: vx, y: vy, w: vw, h: vh};

      const localDefs = [];
      let imgTag;
      if (item.imageMatrix) {
        const m = item.imageMatrix;
        const a = m[0] / nw, b1 = m[1] / nw, c = m[2] / nh, d = m[3] / nh;
        imgTag = `<image href="${escapeHtml(asset.file)}" width="${num(nw)}" height="${num(nh)}" preserveAspectRatio="none" transform="matrix(${num(a)} ${num(b1)} ${num(c)} ${num(d)} ${num(m[4])} ${num(m[5])})"${gradeAttrs}/>`;
      } else {
        const rotAttr = rot ? ` transform="rotate(${num(rot)} ${num(cx)} ${num(cy)})"` : '';
        imgTag = `<image href="${escapeHtml(asset.file)}" x="${num(imgLeft)}" y="${num(imgTop)}" width="${num(dw)}" height="${num(dh)}" preserveAspectRatio="none"${rotAttr}${gradeAttrs}/>`;
      }

      let body = imgTag;
      if (item.matte) {
        const clipId = nextDef('f2a-iclip-');
        const rotAttr = rot ? ` transform="rotate(${num(rot)} ${num(cx)} ${num(cy)})"` : '';
        const matteGeom = item.matte.kind === 'ellipse'
          ? `<ellipse cx="${num(cx)}" cy="${num(cy)}" rx="${num(width / 2)}" ry="${num(height / 2)}"${rotAttr}/>`
          : roundedRectSvgGeom(cx - width / 2, cy - height / 2, width, height, item.matte.radii, item.matte.r, rotAttr);
        localDefs.push(`<clipPath id="${clipId}">${matteGeom}</clipPath>`);
        body = `<g clip-path="url(#${clipId})">${imgTag}</g>`;
      }

      let svgFilterId = null;
      if (needsSvgEffectFilter(item)) {
        const fid = nextDef('f2a-fx-');
        const filterDef = buildSvgEffectFilter(fid, item.fx || [], viewBox);
        if (filterDef) {
          localDefs.push(filterDef);
          svgFilterId = fid;
          body = `<g filter="url(#${svgFilterId})">${body}</g>`;
        }
      }

      const {decls} = commonDecls(item, {isCssBox: false, skipShadows: !!svgFilterId});
      decls.unshift(
        `left: ${px(vx - parentCtx.x)};`,
        `top: ${px(vy - parentCtx.y)};`,
        `width: ${px(vw)};`,
        `height: ${px(vh)};`
      );
      cssRules.push(`/* ${escapeCssComment(pathNames.join(' / '))} */\n#${domId} { ${decls.join(' ')} }`);
      const defsMarkup = localDefs.length ? `<defs>${localDefs.join('')}</defs>` : '';
      html = `${indent}<svg ${dataAttrs(domId, item, pathNames, 'image', 'class="f2a-svg f2a-image-svg"')} viewBox="${num(vx)} ${num(vy)} ${num(vw)} ${num(vh)}" width="${num(vw)}" height="${num(vh)}" overflow="visible">${defsMarkup}${body}</svg>`;
    }

    return {
      html: wrapMaskIfNeeded(html, item, parentCtx, indent),
      meta: {
        id: domId, sourceId: item.sourceId || null, name: item.name || 'Image', path: pathNames.join('/'),
        kind: 'image', singleLayer: false, hidden: !!item.hidden, hasMask: !!item.maskId,
        hasFilters: !!item.imageFilters, asset: asset.file,
        bounds: {x: item.x, y: item.y, w: item.w, h: item.h},
      },
    };
  }

  function renderEntries(ctx, indent) {
    const sorted = [...ctx.entries].sort((a, b) => (a.z - b.z) || ((a.tie || 0) - (b.tie || 0)));
    const htmlParts = [];
    const childMetas = [];
    for (const entry of sorted) {
      if (entry.kind === 'container') {
        const c = entry.item;
        const childCtx = entry.ctx;
        counts.containers++;
        if (c.singleLayer) counts.minimal++;

        let clipDecls = null;
        let clipRadius = null;
        let exactBoxClip = false;
        if (c.clip) {
          const topInset = Math.max(0, c.y - childCtx.y);
          const leftInset = Math.max(0, c.x - childCtx.x);
          const rightInset = Math.max(0, (childCtx.x + childCtx.w) - (c.x + c.w));
          const bottomInset = Math.max(0, (childCtx.y + childCtx.h) - (c.y + c.h));
          clipRadius = cssBorderRadius(c.radii, c.r, c.w, c.h);
          exactBoxClip = topInset < 1e-4 && leftInset < 1e-4 && rightInset < 1e-4 && bottomInset < 1e-4;
          if (exactBoxClip) {
            clipDecls = ['overflow: hidden;'];
            if (clipRadius) clipDecls.push(`border-radius: ${clipRadius};`);
          } else {
            const round = clipRadius ? ` round ${clipRadius}` : '';
            clipDecls = [`clip-path: inset(${px(topInset)} ${px(rightInset)} ${px(bottomInset)} ${px(leftInset)}${round});`];
          }
        }
        const {decls, boxShadows} = commonDecls(c, {isCssBox: exactBoxClip});
        if (boxShadows.length) decls.push(`box-shadow: ${boxShadows.join(', ')};`);
        decls.unshift(
          `left: ${px(childCtx.x - ctx.x)};`,
          `top: ${px(childCtx.y - ctx.y)};`,
          `width: ${px(childCtx.w)};`,
          `height: ${px(childCtx.h)};`
        );
        // Preserve Figma NORMAL isolation unless collapseForBlends lets inner blends pass through.
        // Synthetic singleLayer wrappers never introduce an extra isolation/backdrop root.
        if (!c.singleLayer && !c.collapseForBlends && c.blend !== 'PASS_THROUGH') {
          decls.push('isolation: isolate;');
        }

        // In Figma, clipsContent clips a frame's children, not the frame's own outside stroke.
        const ownEntries = c.clip && c.sourceId && !c.singleLayer
          ? childCtx.entries.filter(e => e.item.sourceId === c.sourceId)
          : [];
        const splitClip = !!(clipDecls && ownEntries.length && ownEntries.length < childCtx.entries.length);
        if (clipDecls && !splitClip) decls.push(...clipDecls);
        else if (splitClip && exactBoxClip && clipRadius) decls.push(`border-radius: ${clipRadius};`);
        cssRules.push(`/* ${escapeCssComment(childCtx.pathNames.join(' / '))} */\n#${childCtx.domId} { ${decls.join(' ')} }`);

        let innerHtml = '';
        let innerMetas = [];
        if (splitClip) {
          const ownSet = new Set(ownEntries);
          const ownRendered = renderEntries({...childCtx, entries: ownEntries}, indent + '  ');
          const restEntries = childCtx.entries.filter(e => !ownSet.has(e));
          const restRendered = renderEntries({...childCtx, entries: restEntries}, indent + '    ');
          const clipId = nextId('f2a-clip');
          cssRules.push(`#${clipId} { position: absolute; left: 0; top: 0; width: 100%; height: 100%; ${clipDecls.join(' ')} }`);
          innerHtml = `${ownRendered.html}\n${indent}  <div id="${clipId}" class="f2a-clip">\n${restRendered.html}\n${indent}  </div>`;
          innerMetas = ownRendered.metas.concat(restRendered.metas);
        } else {
          const inner = renderEntries(childCtx, indent + '  ');
          innerHtml = inner.html;
          innerMetas = inner.metas;
        }
        const cls = c.singleLayer ? 'f2a-layer' : 'f2a-group';
        const kind = c.singleLayer ? 'minimal' : 'group';
        const innerBlock = innerHtml ? `\n${innerHtml}\n${indent}` : '';
        const boxHtml = `${indent}<div ${dataAttrs(childCtx.domId, c, childCtx.pathNames, kind, `class="${cls}"`)}>${innerBlock}</div>`;
        htmlParts.push(wrapMaskIfNeeded(boxHtml, c, ctx, indent));
        childMetas.push({
          id: childCtx.domId,
          sourceId: c.sourceId || null,
          name: c.name || 'Group',
          path: childCtx.pathNames.join('/'),
          kind,
          singleLayer: !!c.singleLayer,
          hidden: !!c.hidden,
          hasMask: !!c.maskId,
          bounds: {x: childCtx.x, y: childCtx.y, w: childCtx.w, h: childCtx.h},
          children: innerMetas,
        });
      } else if (entry.kind === 'shape') {
        const res = renderShape(entry.item, ctx, indent);
        htmlParts.push(res.html);
        childMetas.push(res.meta);
      } else if (entry.kind === 'text') {
        const res = renderText(entry.item, ctx, indent);
        htmlParts.push(res.html);
        childMetas.push(res.meta);
      } else {
        const res = renderImage(entry.item, entry.index, ctx, indent);
        htmlParts.push(res.html);
        childMetas.push(res.meta);
      }
    }
    return {html: htmlParts.join('\n'), metas: childMetas};
  }

  const rendered = renderEntries(rootContext, '      ');
  const layerTree = {
    name: data.name,
    width: data.width,
    height: data.height,
    duration: data.duration,
    frameRate: data.frameRate,
    reference: referenceAsset ? referenceAsset.file : null,
    counts,
    layers: rendered.metas,
  };

  let referenceRect = null;
  if (referenceAsset) {
    const rItem = referenceAsset.item;
    const rScale = rItem.rasterScale ? (1 / rItem.rasterScale) : 1;
    const rW = referenceAsset.natW * rScale;
    const rH = referenceAsset.natH * rScale;
    const rCx = rItem.cx ?? ((rItem.x || 0) + (rItem.w || rW) / 2);
    const rCy = rItem.cy ?? ((rItem.y || 0) + (rItem.h || rH) / 2);
    referenceRect = {left: rCx - rW / 2, top: rCy - rH / 2, width: rW, height: rH};
  }

  return {data, layerTree, renderedHtml: rendered.html, rootDefs, cssRules, fontFaceRules, assets, referenceAsset, referenceRect, counts, warnings};
}

function buildStyleCss(model, options = {}) {
  const {data, cssRules, fontFaceRules} = model;
  const animations = !!options.animations;
  const headerComment = animations
    ? '/* Generated by F2A Web Export (Form A — Pixel-Accurate Interactive Page) */'
    : '/* Generated by F2A Web Export (Form A — Pixel-Accurate Page) */';
  const fontBlock = fontFaceRules && fontFaceRules.length
    ? `\n/* Local font weight aliases */\n${fontFaceRules.join('\n')}\n`
    : '';
  const transformRule = animations
    ? `\n[data-transformed="true"] {\n  transform: translate(var(--tx, 0px), var(--ty, 0px)) rotate(var(--rotate, 0deg)) scale(var(--scale-x, 1), var(--scale-y, 1));\n}\n`
    : '';
  return `${headerComment}${fontBlock}
:root {
  --f2a-width: ${num(data.width)}px;
  --f2a-height: ${num(data.height)}px;
  --f2a-scale: 1;
  --f2a-backdrop: #111215;
}

*, *::before, *::after {
  box-sizing: border-box;
}

html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--f2a-backdrop);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.f2a-viewport {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

html[data-fit="actual"] .f2a-viewport {
  overflow: auto;
  align-items: safe center;
  justify-content: safe center;
}

.f2a-stage-shell {
  position: relative;
  width: calc(var(--f2a-width) * var(--f2a-scale));
  height: calc(var(--f2a-height) * var(--f2a-scale));
  flex: 0 0 auto;
}

.f2a-stage {
  position: relative;
  width: var(--f2a-width);
  height: var(--f2a-height);
  transform-origin: 0 0;
  transform: scale(var(--f2a-scale));
  overflow: hidden;
  isolation: isolate;
}

.f2a-defs {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
  pointer-events: none;
}

.f2a-group,
.f2a-layer,
.f2a-shape,
.f2a-svg,
.f2a-text,
.f2a-image,
.f2a-image-matte {
  position: absolute;
  transform-origin: 50% 50%;
}

.f2a-mask-host {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.f2a-mask-host > * {
  pointer-events: auto;
}

.f2a-svg {
  display: block;
  pointer-events: none;
}

.f2a-svg path,
.f2a-svg rect,
.f2a-svg ellipse,
.f2a-svg image {
  pointer-events: auto;
}

.f2a-image,
.f2a-image-media {
  display: block;
  max-width: none;
  user-select: none;
}

.f2a-text {
  margin: 0;
  padding: 0;
}

.f2a-p {
  margin: 0;
}

[data-hidden="true"] {
  display: none !important;
}
${transformRule}
.f2a-reference {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  pointer-events: none;
  z-index: 9999;
  opacity: 0.5;
  /* Figma renders transparent frames as a transparent PNG; flatten it on the same backdrop as
     the page so overlay / difference compare like with like instead of blending alpha twice. */
  background: var(--f2a-backdrop);
}

.f2a-reference-svg {
  position: absolute;
  left: 0;
  top: 0;
  display: block;
  user-select: none;
}

.f2a-reference[data-diff="true"] {
  opacity: 1;
  mix-blend-mode: difference;
}

html[data-ref-diff="true"] .f2a-stage {
  background: var(--f2a-backdrop);
}

/* Optional Dev Inspector (toggle via Shift+I or ?inspector=1) */
html[data-outlines="true"] .f2a-group {
  outline: 1px dashed rgba(167, 139, 250, 0.55);
}

html[data-outlines="true"] .f2a-layer[data-minimal="true"] {
  outline: 1px solid rgba(234, 179, 8, 0.85);
}

.f2a-inspector {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 10000;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(24, 24, 28, 0.92);
  backdrop-filter: blur(12px);
  color: #e8e8ec;
  font: 12px/1.4 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}

.f2a-inspector[hidden] {
  display: none;
}

.f2a-inspector button {
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.08);
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.f2a-inspector button[aria-pressed="true"] {
  background: #a78bfa;
  border-color: #a78bfa;
  color: #16161a;
  font-weight: 600;
}

.f2a-inspector input[type="range"] {
  width: 72px;
  accent-color: #a78bfa;
}

.f2a-inspector-tip {
  position: fixed;
  left: 16px;
  bottom: 16px;
  z-index: 10000;
  padding: 5px 10px;
  border-radius: 6px;
  background: rgba(24, 24, 28, 0.92);
  border: 1px solid rgba(234, 179, 8, 0.6);
  color: #fde047;
  font: 12px/1.4 monospace;
  pointer-events: none;
}

/* Layer rules */
${cssRules.join('\n')}
`;
}

function buildMainJs(model, options = {}) {
  const {layerTree, data} = model;
  const animations = !!options.animations;
  const hasGradedImages = (data.images || []).some(im => !!im.imageFilters);
  const includeGrading = hasGradedImages || animations;

  const motionBlock = animations ? `
  function setState(target, props) {
    var els = resolveTargets(target);
    var p = props || {};
    els.forEach(function (el) {
      var transformed = false;
      if (p.x != null) { el.style.setProperty('--tx', typeof p.x === 'number' ? p.x + 'px' : String(p.x)); transformed = true; }
      if (p.y != null) { el.style.setProperty('--ty', typeof p.y === 'number' ? p.y + 'px' : String(p.y)); transformed = true; }
      if (p.scale != null) {
        el.style.setProperty('--scale-x', String(p.scale));
        el.style.setProperty('--scale-y', String(p.scale));
        transformed = true;
      }
      if (p.scaleX != null) { el.style.setProperty('--scale-x', String(p.scaleX)); transformed = true; }
      if (p.scaleY != null) { el.style.setProperty('--scale-y', String(p.scaleY)); transformed = true; }
      if (p.rotate != null) { el.style.setProperty('--rotate', typeof p.rotate === 'number' ? p.rotate + 'deg' : String(p.rotate)); transformed = true; }
      if (transformed) el.setAttribute('data-transformed', 'true');
      if (p.opacity != null) el.style.opacity = String(p.opacity);
      if (p.visible === true) el.removeAttribute('data-hidden');
      else if (p.visible === false) el.setAttribute('data-hidden', 'true');
    });
    return els;
  }

  var PRESETS = {
    fadeIn: { keyframes: [{ opacity: 0 }, { opacity: 1 }], options: { duration: 480, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' } },
    fadeOut: { keyframes: [{ opacity: 1 }, { opacity: 0 }], options: { duration: 360, easing: 'ease-in', fill: 'both' } },
    slideUp: { keyframes: [{ opacity: 0, transform: 'translateY(28px)' }, { opacity: 1, transform: 'translateY(0)' }], options: { duration: 560, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' } },
    slideDown: { keyframes: [{ opacity: 0, transform: 'translateY(-28px)' }, { opacity: 1, transform: 'translateY(0)' }], options: { duration: 560, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' } },
    slideLeft: { keyframes: [{ opacity: 0, transform: 'translateX(32px)' }, { opacity: 1, transform: 'translateX(0)' }], options: { duration: 560, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' } },
    slideRight: { keyframes: [{ opacity: 0, transform: 'translateX(-32px)' }, { opacity: 1, transform: 'translateX(0)' }], options: { duration: 560, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' } },
    popIn: { keyframes: [{ opacity: 0, transform: 'scale(0.84)' }, { opacity: 1, transform: 'scale(1.03)', offset: 0.72 }, { opacity: 1, transform: 'scale(1)' }], options: { duration: 520, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' } },
    float: { keyframes: [{ transform: 'translateY(0px)' }, { transform: 'translateY(-8px)' }, { transform: 'translateY(0px)' }], options: { duration: 2600, easing: 'ease-in-out', iterations: Infinity } },
    pulse: { keyframes: [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], options: { duration: 1600, easing: 'ease-in-out', iterations: Infinity } }
  };

  function animate(target, keyframesOrPreset, options) {
    var els = resolveTargets(target);
    var preset = typeof keyframesOrPreset === 'string' ? PRESETS[keyframesOrPreset] : null;
    var keyframes = preset ? preset.keyframes : keyframesOrPreset;
    var baseOpts = Object.assign({ duration: 500, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' }, preset ? preset.options : null, options || {});
    var stagger = Number(baseOpts.stagger) || 0;
    var baseDelay = Number(baseOpts.delay) || 0;
    return els.map(function (el, index) {
      var opts = Object.assign({}, baseOpts, { delay: baseDelay + index * stagger });
      delete opts.stagger;
      return el.animate(keyframes, opts);
    });
  }

  function timeline(steps) {
    var anims = [];
    (steps || []).forEach(function (step) {
      var opts = Object.assign({}, step.options || {}, {
        delay: (step.at != null ? step.at : (step.delay || 0)),
        duration: step.duration != null ? step.duration : (step.options && step.options.duration),
        easing: step.easing || (step.options && step.options.easing),
        fill: step.fill || (step.options && step.options.fill) || 'both',
        stagger: step.stagger
      });
      if (opts.duration == null) delete opts.duration;
      if (opts.easing == null) delete opts.easing;
      anims = anims.concat(animate(step.target, step.preset || step.keyframes, opts));
    });
    return {
      animations: anims,
      finished: Promise.all(anims.map(function (a) { return a.finished.catch(function () {}); })),
      play: function () { anims.forEach(function (a) { a.play(); }); },
      pause: function () { anims.forEach(function (a) { a.pause(); }); },
      reverse: function () { anims.forEach(function (a) { a.reverse(); }); },
      restart: function () { anims.forEach(function (a) { a.currentTime = 0; a.play(); }); },
      cancel: function () { anims.forEach(function (a) { a.cancel(); }); },
      seek: function (ms) { anims.forEach(function (a) { a.pause(); a.currentTime = ms; }); }
    };
  }

  function on(target, eventName, handler, options) {
    var els = resolveTargets(target);
    var offs = els.map(function (el) {
      if (eventName === 'click' && !el.style.cursor) el.style.cursor = 'pointer';
      var wrapped = function (ev) { handler.call(el, ev, el); };
      el.addEventListener(eventName, wrapped, options);
      return function () { el.removeEventListener(eventName, wrapped, options); };
    });
    return function () { offs.forEach(function (off) { off(); }); };
  }
` : '';

  const gradingBlock = includeGrading ? `
  // Exact Figma image-paint color grading (shared math with client/figmaImageGrade.js)
  var GRADE_KEYS = ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows'];
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }
  function gradeRgb(r, g, b, p, out) {
    var y = .2126 * r + .7152 * g + .0722 * b;
    var d = y - .217637640824031;
    var ev = p[0] + .75 * d / Math.sqrt(1 + 4 * d * d) * (d > 0 ? p[5] : -.999 * p[6]);
    if (p[1] || p[3] || p[4]) {
      var fx = Math.cbrt((.4124564 * r + .3575761 * g + .1804375 * b) / .95047);
      var fy = Math.cbrt(.2126729 * r + .7151522 * g + .0721750 * b);
      var fz = Math.cbrt((.0193339 * r + .1191920 * g + .9503041 * b) / 1.08883);
      var light = 116 * fy - 16, t = clamp01((light - 20) / 60);
      var target = p[1] < 0 ? (light - 50) * .2 + 50 : 100 * t * t * t * (6 * t * t - 15 * t + 10);
      var shift = .3 * Math.abs(p[1]) * (target - light) / 116;
      var x = .95047 * Math.pow(fx + shift + .06 * p[4], 3);
      var labY = Math.pow(fy + shift, 3);
      var z = 1.08883 * Math.pow(fz + shift - .15 * p[3], 3);
      r = clamp01(3.2404542 * x - 1.5371385 * labY - .4985314 * z);
      g = clamp01(-.969266 * x + 1.8760108 * labY + .041556 * z);
      b = clamp01(.0556434 * x - .2040259 * labY + 1.0572252 * z);
      y = .2126 * r + .7152 * g + .0722 * b;
    }
    if (ev) {
      var negative = Math.min(0, ev), scale = 1 + negative / 16, gain = Math.pow(10, 2 * ev);
      var chroma = 3 * (1 + y * y * negative / (.2 - negative));
      var scaledY = scale * y, base = scaledY * gain / (1 + scaledY * (gain - 1));
      var rr = scale * (.25 * r + .75 * y), gg = scale * (.25 * g + .75 * y), bb = scale * (.25 * b + .75 * y);
      rr = rr * gain / (1 + rr * (gain - 1)); gg = gg * gain / (1 + gg * (gain - 1)); bb = bb * gain / (1 + bb * (gain - 1));
      r = clamp01(rr + (rr - base) * chroma); g = clamp01(gg + (gg - base) * chroma); b = clamp01(bb + (bb - base) * chroma);
      y = .2126 * r + .7152 * g + .0722 * b;
    }
    var sat = 1 + p[2];
    if (p[2] > 0) {
      var limit = Math.min(y / (y - Math.min(r, g, b) + 1e-6), (1 - y) / (Math.max(r, g, b) - y + 1e-6));
      sat = Math.min(2, 1 + p[2] * (limit - 1));
    }
    out[0] = Math.pow(clamp01(y + (r - y) * sat), 1 / 2.2);
    out[1] = Math.pow(clamp01(y + (g - y) * sat), 1 / 2.2);
    out[2] = Math.pow(clamp01(y + (b - y) * sat), 1 / 2.2);
  }

  var DECODE_LUT = new Float32Array(256);
  for (var di = 0; di < 256; di++) DECODE_LUT[di] = Math.pow(di / 255, 2.2);

  function renderGradedImage(img, filters) {
    return new Promise(function (resolve) {
      var isSvg = img.tagName && img.tagName.toLowerCase() === 'image';
      var currentSrc = isSvg ? (img.getAttribute('href') || '') : img.src;
      var params = GRADE_KEYS.map(function (k) { return Number(filters && filters[k]) || 0; });
      var sourceUrl = img.getAttribute('data-grade-src') || img.getAttribute('data-orig-src') || currentSrc;
      if (!img.getAttribute('data-orig-src')) img.setAttribute('data-orig-src', currentSrc);
      var loader = new Image();
      loader.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = loader.naturalWidth;
          canvas.height = loader.naturalHeight;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(loader, 0, 0);
          var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          var buf = imgData.data, pixel = [0, 0, 0];
          for (var i = 0; i < buf.length; i += 4) {
            if (buf[i + 3] === 0) continue;
            gradeRgb(DECODE_LUT[buf[i]], DECODE_LUT[buf[i + 1]], DECODE_LUT[buf[i + 2]], params, pixel);
            buf[i] = Math.round(pixel[0] * 255);
            buf[i + 1] = Math.round(pixel[1] * 255);
            buf[i + 2] = Math.round(pixel[2] * 255);
          }
          ctx.putImageData(imgData, 0, 0);
          var gradedUrl = canvas.toDataURL('image/png');
          if (isSvg) img.setAttribute('href', gradedUrl);
          else img.src = gradedUrl;
          img.setAttribute('data-graded', 'true');
        } catch (e) {}
        resolve(img);
      };
      loader.onerror = function () { resolve(img); };
      loader.src = sourceUrl;
    });
  }

  function applyAllImageGrades() {
    var imgs = Array.from(stage.querySelectorAll('img[data-image-filters], image[data-image-filters]'));
    return Promise.all(imgs.map(function (img) {
      try {
        var filters = JSON.parse(img.getAttribute('data-image-filters') || '{}');
        return renderGradedImage(img, filters);
      } catch (e) { return Promise.resolve(img); }
    }));
  }
${animations ? `
  function setImageGrade(target, filters) {
    var els = resolveTargets(target);
    var imgs = [];
    els.forEach(function (el) {
      var tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag === 'img' || tag === 'image') imgs.push(el);
      else imgs = imgs.concat(Array.from(el.querySelectorAll('img, image')));
    });
    return Promise.all(imgs.map(function (img) { return renderGradedImage(img, filters); }));
  }
` : ''}` : `
  function applyAllImageGrades() {
    return Promise.resolve([]);
  }
`;

  const inspectorDemoBtn = animations ? `
    btn('演示入场', function () {
      var targets = minimalLayers().filter(function (el) { return !el.hasAttribute('data-hidden'); });
      if (!targets.length) targets = Array.from(stage.children).filter(function (el) { return el.hasAttribute('data-layer-name'); });
      animate(targets, 'slideUp', { stagger: 45, duration: 520 });
    });
` : '';

  const motionExports = animations ? `,
    animate: animate,
    timeline: timeline,
    presets: PRESETS,
    on: on,
    setState: setState,
    setImageGrade: setImageGrade` : '';

  return `/* F2A ${animations ? 'Motion & Interaction' : 'Stage'} Runtime (zero dependencies) */
(function () {
  'use strict';

  var TREE = ${JSON.stringify(layerTree).replaceAll('<', '\\u003c')};
  var stage = document.getElementById('f2a-stage');
  var viewport = document.querySelector('.f2a-viewport');
  var root = document.documentElement;
  var fitMode = root.getAttribute('data-fit') || 'fit';

  function updateScale() {
    if (!viewport || !stage) return 1;
    var vw = viewport.clientWidth || window.innerWidth || TREE.width;
    var vh = viewport.clientHeight || window.innerHeight || TREE.height;
    var scale = 1;
    if (fitMode === 'fit') {
      scale = Math.min(vw / TREE.width, vh / TREE.height);
    } else if (fitMode === 'cover') {
      scale = Math.max(vw / TREE.width, vh / TREE.height);
    } else if (fitMode === 'width') {
      scale = vw / TREE.width;
    } else {
      scale = 1;
    }
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    root.style.setProperty('--f2a-scale', String(scale));
    var refEl = stage.querySelector('.f2a-reference');
    var diffOn = !!(refEl && !refEl.hidden && refEl.getAttribute('data-diff') === 'true');
    if (diffOn) root.setAttribute('data-ref-diff', 'true');
    else root.removeAttribute('data-ref-diff');
    return scale;
  }

  function setFitMode(mode) {
    fitMode = mode || 'fit';
    root.setAttribute('data-fit', fitMode);
    return updateScale();
  }

  function allLayerElements() {
    return Array.from(stage.querySelectorAll('[data-layer-name]'));
  }

  function resolveTargets(query) {
    if (!query) return [];
    if (query instanceof Element) return [query];
    if (Array.isArray(query) || query instanceof NodeList) {
      return Array.from(query).reduce(function (acc, item) {
        return acc.concat(resolveTargets(item));
      }, []);
    }
    var key = String(query);
    var byId = document.getElementById(key);
    if (byId && stage.contains(byId)) return [byId];
    var elements = allLayerElements();
    var exactPath = elements.filter(function (el) { return el.getAttribute('data-layer-path') === key; });
    if (exactPath.length) return exactPath;
    var exactMinimal = elements.filter(function (el) {
      return el.getAttribute('data-layer-name') === key && el.getAttribute('data-minimal') === 'true';
    });
    if (exactMinimal.length) return exactMinimal;
    var exactName = elements.filter(function (el) { return el.getAttribute('data-layer-name') === key; });
    if (exactName.length) return exactName;
    var bySource = elements.filter(function (el) { return el.getAttribute('data-source-id') === key; });
    if (bySource.length) return bySource;
    try { return Array.from(stage.querySelectorAll(key)); } catch (e) { return []; }
  }

  function layer(query) {
    return resolveTargets(query)[0] || null;
  }

  function layers(query) {
    return resolveTargets(query);
  }

  function minimalLayers() {
    return Array.from(stage.querySelectorAll('[data-minimal="true"]'));
  }
${motionBlock}${gradingBlock}
  // Optional Dev Inspector (open via ?inspector=1 or press Shift+I)
  function setupInspector() {
    var bar = document.createElement('div');
    bar.className = 'f2a-inspector';
    bar.hidden = !/(?:[?&])inspector=1(?:&|$)/.test(window.location.search);
    var refImg = stage.querySelector('.f2a-reference');
    var tip = document.createElement('div');
    tip.className = 'f2a-inspector-tip';
    tip.hidden = true;
    document.body.appendChild(tip);

    function btn(label, onClick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', function () { onClick(b); });
      bar.appendChild(b);
      return b;
    }

    btn('1:1 像素', function (b) {
      var actual = fitMode !== 'actual';
      setFitMode(actual ? 'actual' : 'fit');
      b.setAttribute('aria-pressed', String(actual));
    });

    var outlinesBtn = btn('图层框', function (b) {
      var onState = root.getAttribute('data-outlines') !== 'true';
      if (onState) root.setAttribute('data-outlines', 'true');
      else root.removeAttribute('data-outlines');
      b.setAttribute('aria-pressed', String(onState));
      if (!onState) tip.hidden = true;
    });

    if (refImg) {
      var diffBtn = null;
      var range = document.createElement('input');
      range.type = 'range'; range.min = '0'; range.max = '100'; range.value = '50'; range.hidden = true;
      range.addEventListener('input', function () {
        refImg.removeAttribute('data-diff');
        if (diffBtn) diffBtn.setAttribute('aria-pressed', 'false');
        refImg.style.opacity = String(Number(range.value) / 100);
        updateScale();
      });
      btn('原图对照', function (b) {
        refImg.hidden = !refImg.hidden;
        range.hidden = refImg.hidden;
        if (diffBtn) diffBtn.hidden = refImg.hidden;
        b.setAttribute('aria-pressed', String(!refImg.hidden));
        updateScale();
      });
      bar.appendChild(range);
      diffBtn = btn('差值比对', function (b) {
        var onDiff = refImg.getAttribute('data-diff') !== 'true';
        if (onDiff) {
          refImg.style.opacity = '';
          refImg.setAttribute('data-diff', 'true');
          if (root.getAttribute('data-outlines') === 'true') {
            root.removeAttribute('data-outlines');
            outlinesBtn.setAttribute('aria-pressed', 'false');
            tip.hidden = true;
          }
        } else {
          refImg.removeAttribute('data-diff');
          refImg.style.opacity = String(Number(range.value) / 100);
        }
        b.setAttribute('aria-pressed', String(onDiff));
        updateScale();
      });
      diffBtn.hidden = true;
    }
${inspectorDemoBtn}
    stage.addEventListener('pointermove', function (ev) {
      if (root.getAttribute('data-outlines') !== 'true') { tip.hidden = true; return; }
      var hit = ev.target && ev.target.closest ? ev.target.closest('[data-minimal="true"], [data-layer-name]') : null;
      if (!hit || !stage.contains(hit)) { tip.hidden = true; return; }
      tip.textContent = (hit.getAttribute('data-minimal') === 'true' ? '[最小合成] ' : '') + hit.getAttribute('data-layer-path');
      tip.hidden = false;
    });

    document.body.appendChild(bar);
    window.addEventListener('keydown', function (ev) {
      if (ev.shiftKey && (ev.key === 'I' || ev.key === 'i')) bar.hidden = !bar.hidden;
    });
  }

  var ready = applyAllImageGrades();
  updateScale();
  window.addEventListener('resize', updateScale);
  if (typeof ResizeObserver === 'function' && viewport) {
    new ResizeObserver(updateScale).observe(viewport);
  }
  setupInspector();

  window.F2A = {
    tree: TREE,
    stage: stage,
    ready: ready,
    layer: layer,
    layers: layers,
    minimalLayers: minimalLayers,
    setFitMode: setFitMode,
    updateScale: updateScale${motionExports}
  };
})();
`;
}

function buildAnimationsJs(model) {
  const {layerTree} = model;
  const sampleNames = [];
  (function collect(list) {
    for (const item of list) {
      if (item.singleLayer && !item.hidden && sampleNames.length < 12) sampleNames.push(item.name);
      if (item.children) collect(item.children);
    }
  })(layerTree.layers);
  if (!sampleNames.length) {
    for (const item of layerTree.layers.slice(0, 12)) sampleNames.push(item.name);
  }
  const first = sampleNames[0] || '图层名';
  const second = sampleNames[1] || first;
  const listComment = sampleNames.length
    ? sampleNames.map(n => ` *   - ${n}`).join('\n')
    : ' *   （请查看 layers.json 获取完整图层树）';
  return `/* F2A 动效与互动脚本入口
 *
 * 按 Shift+I（或在网址后加 ?inspector=1）可打开调试条：原图对照、差值比对、图层框、演示入场。
 * 当前页面导出的主要图层：
${listComment}
 *
 * 常用 API：
 *   F2A.layer('图层名')                         // 按图层名 / 路径 / Figma ID 查找元素
 *   F2A.animate('图层名', 'slideUp', { delay }) // 播放内置或自定义 WAAPI 动效
 *   F2A.timeline([...])                         // 编排多图层时间轴
 *   F2A.on('按钮', 'click', (e, el) => {...})   // 绑定交互事件
 *   F2A.setState('图层名', { x, y, scale, rotate, opacity, visible })
 */

// 示例 1：入场时间轴（取消注释即可启用）
// F2A.timeline([
//   { target: ${JSON.stringify(first)}, preset: 'fadeIn', at: 0, duration: 500 },
//   { target: ${JSON.stringify(second)}, preset: 'slideUp', at: 120, duration: 560 },
// ]);

// 示例 2：点击互动（取消注释即可启用）
// F2A.on(${JSON.stringify(first)}, 'click', (_event, el) => {
//   F2A.animate(el, 'pulse', { iterations: 1, duration: 360 });
// });
`;
}

function buildIndexHtml(model, options = {}) {
  const {data, renderedHtml, rootDefs, referenceAsset, referenceRect} = model;
  const animations = !!options.animations;
  const defsSvg = rootDefs.length
    ? `\n      <svg class="f2a-defs" aria-hidden="true"><defs>${rootDefs.join('')}</defs></svg>`
    : '';
  let refImg = '';
  if (referenceAsset) {
    const refVbW = Math.max(PIXEL_GRID, ceilGrid(data.width));
    const refVbH = Math.max(PIXEL_GRID, ceilGrid(data.height));
    const r = referenceRect || {left: 0, top: 0, width: data.width, height: data.height};
    refImg =
      `\n      <div class="f2a-reference" hidden>` +
      `<svg class="f2a-reference-svg" viewBox="0 0 ${num(refVbW)} ${num(refVbH)}" width="${num(refVbW)}" height="${num(refVbH)}">` +
      `<image href="${escapeHtml(referenceAsset.file)}" x="${num(r.left)}" y="${num(r.top)}" width="${num(r.width)}" height="${num(r.height)}" preserveAspectRatio="none"/>` +
      `</svg></div>`;
  }
  const animationsScript = animations ? '\n  <script src="animations.js"></script>' : '';
  return `<!DOCTYPE html>
<html lang="zh-CN" data-fit="fit">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(data.name)}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="f2a-viewport">
    <div class="f2a-stage-shell">
      <div id="f2a-stage" class="f2a-stage" data-width="${num(data.width)}" data-height="${num(data.height)}">${defsSvg}
${renderedHtml}${refImg}
      </div>
    </div>
  </div>
  <script src="main.js"></script>${animationsScript}
</body>
</html>
`;
}

function renderWebBundle(packet, options = {}) {
  const animations = options.animations != null ? Boolean(options.animations) : Boolean(packet && packet.webAnimations);
  const model = buildWebModel(packet);
  const renderOpts = {animations};
  return {
    html: buildIndexHtml(model, renderOpts),
    css: buildStyleCss(model, renderOpts),
    mainJs: buildMainJs(model, renderOpts),
    animationsJs: animations ? buildAnimationsJs(model) : null,
    layersJson: JSON.stringify(model.layerTree, null, 2) + '\n',
    assets: model.assets,
    counts: model.counts,
    warnings: model.warnings,
    layerTree: model.layerTree,
    animations,
  };
}

async function writeWebBundle(packet, directory, options = {}) {
  const started = performance.now();
  const bundle = renderWebBundle(packet, options);
  await fs.mkdir(directory, {recursive: true});
  if (bundle.assets.length) {
    await fs.mkdir(path.join(directory, 'assets'), {recursive: true});
    for (const asset of bundle.assets) {
      await fs.writeFile(path.join(directory, asset.file), asset.bytes);
    }
  }
  const writes = [
    fs.writeFile(path.join(directory, 'index.html'), bundle.html, 'utf8'),
    fs.writeFile(path.join(directory, 'style.css'), bundle.css, 'utf8'),
    fs.writeFile(path.join(directory, 'main.js'), bundle.mainJs, 'utf8'),
    fs.writeFile(path.join(directory, 'layers.json'), bundle.layersJson, 'utf8'),
  ];
  if (bundle.animationsJs != null) {
    writes.push(fs.writeFile(path.join(directory, 'animations.js'), bundle.animationsJs, 'utf8'));
  }
  await Promise.all(writes);
  const totalMs = Math.round(performance.now() - started);
  const report = {
    entry: 'index.html',
    animations: bundle.animations,
    counts: bundle.counts,
    warnings: bundle.warnings,
    totalMs,
  };
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  return {
    ...report,
    directory,
    entry: path.join(directory, 'index.html'),
  };
}

module.exports = {buildWebModel, renderWebBundle, writeWebBundle};
