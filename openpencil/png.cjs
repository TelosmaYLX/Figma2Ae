'use strict';

const zlib = require('node:zlib');
const { extractShadow } = require('../client/figmaRasterEffects.js');

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffers) {
  let c = 0xffffffff;
  for (const buf of buffers) {
    for (let i = 0; i < buf.length; i++) {
      c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32([typeBuf, data]), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function detectImageExt(bytes) {
  if (!bytes || bytes.length < 4) return 'png';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  return 'png';
}

function readImageDimensions(bytes) {
  if (!bytes || bytes.length < 10) return null;
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) break;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (offset + 2 > bytes.length) break;
      const segLen = bytes.readUInt16BE(offset);
      if (segLen < 2) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        if (offset + 7 <= bytes.length) {
          return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
        }
        break;
      }
      offset += segLen;
    }
  }
  return null;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePngRgba(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('不是有效的 PNG 图片');
  }
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buffer.length) break;
    const chunk = buffer.subarray(start, end);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      interlace = chunk[12];
    } else if (type === 'PLTE') {
      palette = chunk;
    } else if (type === 'tRNS') {
      trns = chunk;
    } else if (type === 'IDAT') {
      idat.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }

  if (!(width > 0 && height > 0) || bitDepth !== 8 || interlace !== 0) {
    throw new Error('暂不支持该 PNG 位深或隔行格式');
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('暂不支持该 PNG 色彩类型');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = width * bpp;
  const recon = new Uint8Array(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const srcRow = y * (stride + 1) + 1;
    const dstRow = y * stride;
    const prevRow = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const val = raw[srcRow + x];
      const left = x >= bpp ? recon[dstRow + x - bpp] : 0;
      const up = y > 0 ? recon[prevRow + x] : 0;
      const upLeft = (y > 0 && x >= bpp) ? recon[prevRow + x - bpp] : 0;
      let out;
      if (filter === 0) out = val;
      else if (filter === 1) out = (val + left) & 0xff;
      else if (filter === 2) out = (val + up) & 0xff;
      else if (filter === 3) out = (val + ((left + up) >>> 1)) & 0xff;
      else if (filter === 4) out = (val + paeth(left, up, upLeft)) & 0xff;
      else throw new Error('未知 PNG 滤波类型: ' + filter);
      recon[dstRow + x] = out;
    }
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  if (colorType === 6) {
    rgba.set(recon);
  } else if (colorType === 2) {
    for (let i = 0, j = 0; i < recon.length; i += 3, j += 4) {
      rgba[j] = recon[i]; rgba[j + 1] = recon[i + 1]; rgba[j + 2] = recon[i + 2]; rgba[j + 3] = 255;
    }
  } else if (colorType === 0) {
    for (let i = 0, j = 0; i < recon.length; i++, j += 4) {
      rgba[j] = rgba[j + 1] = rgba[j + 2] = recon[i]; rgba[j + 3] = 255;
    }
  } else if (colorType === 4) {
    for (let i = 0, j = 0; i < recon.length; i += 2, j += 4) {
      rgba[j] = rgba[j + 1] = rgba[j + 2] = recon[i]; rgba[j + 3] = recon[i + 1];
    }
  } else if (colorType === 3 && palette) {
    for (let i = 0, j = 0; i < recon.length; i++, j += 4) {
      const idx = recon[i];
      rgba[j] = palette[idx * 3] || 0;
      rgba[j + 1] = palette[idx * 3 + 1] || 0;
      rgba[j + 2] = palette[idx * 3 + 2] || 0;
      rgba[j + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { width, height, data: rgba };
}

function encodePngRgba(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1);
    raw[dst] = 0;
    const src = y * stride;
    for (let i = 0; i < stride; i++) raw[dst + 1 + i] = rgba[src + i];
  }
  const compressed = zlib.deflateSync(raw);
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function sampleBilinearPremul(src, sw, sh, sx, sy) {
  if (sx <= -1 || sy <= -1 || sx >= sw || sy >= sh) return [0, 0, 0, 0];
  const x0 = Math.floor(sx), y0 = Math.floor(sy);
  const fx = sx - x0, fy = sy - y0;
  const xs = [x0, x0 + 1], ys = [y0, y0 + 1];
  const wx = [1 - fx, fx], wy = [1 - fy, fy];
  let r = 0, g = 0, b = 0, a = 0;
  for (let j = 0; j < 2; j++) {
    const py = ys[j];
    if (py < 0 || py >= sh) continue;
    for (let i = 0; i < 2; i++) {
      const px = xs[i];
      if (px < 0 || px >= sw) continue;
      const w = wx[i] * wy[j];
      const idx = (py * sw + px) * 4;
      const alpha = src[idx + 3] / 255;
      r += src[idx] * alpha * w;
      g += src[idx + 1] * alpha * w;
      b += src[idx + 2] * alpha * w;
      a += alpha * w;
    }
  }
  if (a <= 0) return [0, 0, 0, 0];
  return [
    Math.min(255, Math.max(0, Math.round(r / a))),
    Math.min(255, Math.max(0, Math.round(g / a))),
    Math.min(255, Math.max(0, Math.round(b / a))),
    Math.min(255, Math.max(0, Math.round(a * 255))),
  ];
}

function resolveShadowBaseNode(fullBase64, base) {
  const full = decodePngRgba(Buffer.from(fullBase64, 'base64'));
  const clean = decodePngRgba(Buffer.from(base.data, 'base64'));
  const aligned = new Uint8ClampedArray(full.width * full.height * 4);
  const dx = Number(base.dx) || 0;
  const dy = Number(base.dy) || 0;
  const bw = Number(base.w) || clean.width;
  const bh = Number(base.h) || clean.height;
  const exactGrid =
    Math.abs(dx - Math.round(dx)) < 1e-4 &&
    Math.abs(dy - Math.round(dy)) < 1e-4 &&
    Math.abs(bw - clean.width) < 1e-4 &&
    Math.abs(bh - clean.height) < 1e-4;

  if (exactGrid) {
    const ox = Math.round(dx), oy = Math.round(dy);
    for (let y = 0; y < clean.height; y++) {
      const ty = y + oy;
      if (ty < 0 || ty >= full.height) continue;
      for (let x = 0; x < clean.width; x++) {
        const tx = x + ox;
        if (tx < 0 || tx >= full.width) continue;
        const si = (y * clean.width + x) * 4;
        const di = (ty * full.width + tx) * 4;
        aligned[di] = clean.data[si];
        aligned[di + 1] = clean.data[si + 1];
        aligned[di + 2] = clean.data[si + 2];
        aligned[di + 3] = clean.data[si + 3];
      }
    }
  } else if (bw > 0 && bh > 0) {
    const startX = Math.max(0, Math.floor(dx));
    const endX = Math.min(full.width, Math.ceil(dx + bw));
    const startY = Math.max(0, Math.floor(dy));
    const endY = Math.min(full.height, Math.ceil(dy + bh));
    for (let ty = startY; ty < endY; ty++) {
      const sy = ((ty + 0.5 - dy) / bh) * clean.height - 0.5;
      for (let tx = startX; tx < endX; tx++) {
        const sx = ((tx + 0.5 - dx) / bw) * clean.width - 0.5;
        const pixel = sampleBilinearPremul(clean.data, clean.width, clean.height, sx, sy);
        const di = (ty * full.width + tx) * 4;
        aligned[di] = pixel[0];
        aligned[di + 1] = pixel[1];
        aligned[di + 2] = pixel[2];
        aligned[di + 3] = pixel[3];
      }
    }
  }
  const shadow = extractShadow(full.data, aligned);
  return encodePngRgba(full.width, full.height, shadow).toString('base64');
}

module.exports = {
  detectImageExt,
  readImageDimensions,
  decodePngRgba,
  encodePngRgba,
  resolveShadowBaseNode,
};
