/*
 * svgParser.js — Overlord-style SVG -> AE shape model
 * ES3-safe: runs in Node (for testing) AND in After Effects ExtendScript.
 * No let/const/arrow/Array.map — classic var + for loops only.
 *
 * Output model (consumed by aeShapeBuilder.jsx):
 *   {
 *     width, height,                // viewport size
 *     shapes: [                     // flattened, in draw order
 *       {
 *         name,
 *         subpaths: [ { closed:bool, verts:[[x,y]..], inT:[[dx,dy]..], outT:[[dx,dy]..] } ],
 *         fill:   [r,g,b] 0..1  | null,
 *         fillOpacity: 0..1,
 *         stroke: [r,g,b] 0..1  | null,
 *         strokeWidth: number,
 *         strokeOpacity: 0..1,
 *         opacity: 0..1
 *       }
 *     ]
 *   }
 *
 * Coordinates are in SVG space (y-down), same as AE comp space, so no flip needed.
 */

var SVGParser = (function () {

  // ---------- tiny helpers ----------
  function deg2rad(d) { return d * Math.PI / 180; }
  function trim(s) { return String(s).replace(/^\s+/, '').replace(/\s+$/, ''); }

  function matMul(m1, m2) {
    // 2x3 affine [a,b,c,d,e,f]  (x' = a*x + c*y + e ; y' = b*x + d*y + f)
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  }
  function applyPt(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
  function applyVec(m, x, y) { return [m[0] * x + m[2] * y, m[1] * x + m[3] * y]; } // no translate

  // ---------- color parsing ----------
  var NAMED = {
    black: [0, 0, 0], white: [1, 1, 1], red: [1, 0, 0], green: [0, 0.5, 0],
    blue: [0, 0, 1], gray: [0.5, 0.5, 0.5], grey: [0.5, 0.5, 0.5],
    none: null, transparent: null
  };
  function parseColor(str) {
    if (str == null) return undefined; // not specified (inherit)
    str = trim(str);
    if (str === '') return undefined;
    var low = str.toLowerCase();
    if (low === 'none' || low === 'transparent') return null;
    if (NAMED.hasOwnProperty(low)) return NAMED[low];
    if (str.charAt(0) === '#') {
      var h = str.substring(1);
      if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
      if (h.length >= 6) {
        return [
          parseInt(h.substring(0, 2), 16) / 255,
          parseInt(h.substring(2, 4), 16) / 255,
          parseInt(h.substring(4, 6), 16) / 255
        ];
      }
    }
    var m = low.match(/rgba?\(([^)]+)\)/);
    if (m) {
      var parts = m[1].split(',');
      function chan(v) { v = trim(v); if (v.charAt(v.length - 1) === '%') return parseFloat(v) / 100; return parseFloat(v) / 255; }
      return [chan(parts[0]), chan(parts[1]), chan(parts[2])];
    }
    // url(#id) -> gradient/pattern reference; resolved later against the <defs> map
    if (low.indexOf('url(') === 0) {
      var idm = str.match(/url\(\s*['"]?#([^)'"\s]+)/); // ids are case-sensitive -> use original str
      return idm ? { url: idm[1] } : null;
    }
    return undefined;
  }

  // ---------- transform attribute parsing ----------
  function parseTransform(str) {
    var m = [1, 0, 0, 1, 0, 0];
    if (!str) return m;
    var re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g, res;
    while ((res = re.exec(str)) !== null) {
      var fn = res[1];
      var a = res[2].replace(/,/g, ' ').split(/\s+/);
      var n = [];
      for (var i = 0; i < a.length; i++) { if (trim(a[i]) !== '') n.push(parseFloat(a[i])); }
      var t = [1, 0, 0, 1, 0, 0];
      if (fn === 'matrix') { t = [n[0], n[1], n[2], n[3], n[4], n[5]]; }
      else if (fn === 'translate') { t = [1, 0, 0, 1, n[0] || 0, n[1] || 0]; }
      else if (fn === 'scale') { t = [n[0], 0, 0, (n.length > 1 ? n[1] : n[0]), 0, 0]; }
      else if (fn === 'rotate') {
        var r = deg2rad(n[0]); var cos = Math.cos(r), sin = Math.sin(r);
        if (n.length > 2) {
          var cx = n[1], cy = n[2];
          t = matMul([1, 0, 0, 1, cx, cy], matMul([cos, sin, -sin, cos, 0, 0], [1, 0, 0, 1, -cx, -cy]));
        } else { t = [cos, sin, -sin, cos, 0, 0]; }
      }
      else if (fn === 'skewX') { t = [1, 0, Math.tan(deg2rad(n[0])), 1, 0, 0]; }
      else if (fn === 'skewY') { t = [1, Math.tan(deg2rad(n[0])), 0, 1, 0, 0]; }
      m = matMul(m, t);
    }
    return m;
  }

  // ---------- path 'd' tokenizer ----------
  function tokenizePath(d) {
    var tokens = [];
    var re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:[0-9]*\.[0-9]+|[0-9]+)(?:[eE][-+]?[0-9]+)?)/g, r;
    while ((r = re.exec(d)) !== null) {
      if (r[1]) tokens.push({ cmd: r[1] });
      else tokens.push({ num: parseFloat(r[2]) });
    }
    return tokens;
  }

  function pushCubic(sp, c1, c2, p1) {
    var last = sp.verts.length - 1;
    sp.outT[last] = [c1[0] - sp.verts[last][0], c1[1] - sp.verts[last][1]];
    sp.verts.push([p1[0], p1[1]]);
    sp.inT.push([c2[0] - p1[0], c2[1] - p1[1]]);
    sp.outT.push([0, 0]);
  }
  function pushLine(sp, p1) {
    sp.verts.push([p1[0], p1[1]]);
    sp.inT.push([0, 0]);
    sp.outT.push([0, 0]);
  }
  function newSub() { return { closed: false, verts: [], inT: [], outT: [] }; }

  function arcToCubics(x0, y0, rx, ry, phiDeg, largeArc, sweep, x, y, sp) {
    if (rx === 0 || ry === 0) { pushLine(sp, [x, y]); return; }
    rx = Math.abs(rx); ry = Math.abs(ry);
    var phi = deg2rad(phiDeg % 360);
    var cosP = Math.cos(phi), sinP = Math.sin(phi);
    var dx = (x0 - x) / 2, dy = (y0 - y) / 2;
    var x1p = cosP * dx + sinP * dy;
    var y1p = -sinP * dx + cosP * dy;
    var lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) { var s = Math.sqrt(lambda); rx *= s; ry *= s; }
    var sign = (largeArc !== sweep) ? 1 : -1;
    var num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    if (num < 0) num = 0;
    var den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    var co = sign * Math.sqrt(num / den);
    var cxp = co * (rx * y1p / ry);
    var cyp = co * (-ry * x1p / rx);
    var cx = cosP * cxp - sinP * cyp + (x0 + x) / 2;
    var cy = sinP * cxp + cosP * cyp + (y0 + y) / 2;
    function ang(ux, uy, vx, vy) {
      var dot = ux * vx + uy * vy;
      var len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
      var a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
      if (ux * vy - uy * vx < 0) a = -a;
      return a;
    }
    var theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    var dtheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
    if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
    var segs = Math.ceil(Math.abs(dtheta) / (Math.PI / 2));
    var delta = dtheta / segs;
    var t = (4 / 3) * Math.tan(delta / 4);
    var th = theta1;
    for (var i = 0; i < segs; i++) {
      var cosTh = Math.cos(th), sinTh = Math.sin(th);
      var cosTh2 = Math.cos(th + delta), sinTh2 = Math.sin(th + delta);
      var e1x = cosP * rx * cosTh - sinP * ry * sinTh + cx;
      var e1y = sinP * rx * cosTh + cosP * ry * sinTh + cy;
      var e2x = cosP * rx * cosTh2 - sinP * ry * sinTh2 + cx;
      var e2y = sinP * rx * cosTh2 + cosP * ry * sinTh2 + cy;
      var d1x = -cosP * rx * sinTh - sinP * ry * cosTh;
      var d1y = -sinP * rx * sinTh + cosP * ry * cosTh;
      var d2x = -cosP * rx * sinTh2 - sinP * ry * cosTh2;
      var d2y = -sinP * rx * sinTh2 + cosP * ry * cosTh2;
      var c1 = [e1x + t * d1x, e1y + t * d1y];
      var c2 = [e2x - t * d2x, e2y - t * d2y];
      pushCubic(sp, c1, c2, [e2x, e2y]);
      th += delta;
    }
  }

  function parsePathData(d) {
    var tk = tokenizePath(d);
    var subs = [];
    var sp = null;
    var cx = 0, cy = 0;
    var sx = 0, sy = 0;
    var lastCtrl = null;
    var lastCmd = '';
    var i = 0;
    function num() { return tk[i++].num; }
    while (i < tk.length) {
      var cmd;
      if (tk[i].cmd !== undefined) { cmd = tk[i].cmd; i++; }
      else { cmd = (lastCmd === 'M') ? 'L' : (lastCmd === 'm') ? 'l' : lastCmd; }
      var rel = (cmd === cmd.toLowerCase());
      var C = cmd.toUpperCase();

      if (C === 'M') {
        var mx = num(), my = num();
        if (rel) { mx += cx; my += cy; }
        if (sp && sp.verts.length) subs.push(sp);
        sp = newSub();
        cx = mx; cy = my; sx = mx; sy = my;
        sp.verts.push([cx, cy]); sp.inT.push([0, 0]); sp.outT.push([0, 0]);
        lastCtrl = null;
      } else if (C === 'L') {
        var lx = num(), ly = num(); if (rel) { lx += cx; ly += cy; }
        pushLine(sp, [lx, ly]); cx = lx; cy = ly; lastCtrl = null;
      } else if (C === 'H') {
        var hx = num(); if (rel) hx += cx; pushLine(sp, [hx, cy]); cx = hx; lastCtrl = null;
      } else if (C === 'V') {
        var vy = num(); if (rel) vy += cy; pushLine(sp, [cx, vy]); cy = vy; lastCtrl = null;
      } else if (C === 'C') {
        var c1 = [num(), num()], c2 = [num(), num()], p = [num(), num()];
        if (rel) { c1[0] += cx; c1[1] += cy; c2[0] += cx; c2[1] += cy; p[0] += cx; p[1] += cy; }
        pushCubic(sp, c1, c2, p); cx = p[0]; cy = p[1]; lastCtrl = c2;
      } else if (C === 'S') {
        var s2 = [num(), num()], sp2 = [num(), num()];
        if (rel) { s2[0] += cx; s2[1] += cy; sp2[0] += cx; sp2[1] += cy; }
        var s1 = (lastCtrl && (lastCmd.toUpperCase() === 'C' || lastCmd.toUpperCase() === 'S'))
          ? [2 * cx - lastCtrl[0], 2 * cy - lastCtrl[1]] : [cx, cy];
        pushCubic(sp, s1, s2, sp2); cx = sp2[0]; cy = sp2[1]; lastCtrl = s2;
      } else if (C === 'Q') {
        var q = [num(), num()], qp = [num(), num()];
        if (rel) { q[0] += cx; q[1] += cy; qp[0] += cx; qp[1] += cy; }
        var qc1 = [cx + 2 / 3 * (q[0] - cx), cy + 2 / 3 * (q[1] - cy)];
        var qc2 = [qp[0] + 2 / 3 * (q[0] - qp[0]), qp[1] + 2 / 3 * (q[1] - qp[1])];
        pushCubic(sp, qc1, qc2, qp); cx = qp[0]; cy = qp[1]; lastCtrl = q;
      } else if (C === 'T') {
        var tp = [num(), num()]; if (rel) { tp[0] += cx; tp[1] += cy; }
        var tq = (lastCtrl && (lastCmd.toUpperCase() === 'Q' || lastCmd.toUpperCase() === 'T'))
          ? [2 * cx - lastCtrl[0], 2 * cy - lastCtrl[1]] : [cx, cy];
        var tc1 = [cx + 2 / 3 * (tq[0] - cx), cy + 2 / 3 * (tq[1] - cy)];
        var tc2 = [tp[0] + 2 / 3 * (tq[0] - tp[0]), tp[1] + 2 / 3 * (tq[1] - tp[1])];
        pushCubic(sp, tc1, tc2, tp); cx = tp[0]; cy = tp[1]; lastCtrl = tq;
      } else if (C === 'A') {
        var rx = num(), ry = num(), rot = num(), laf = num(), sf = num(), ax = num(), ay = num();
        if (rel) { ax += cx; ay += cy; }
        arcToCubics(cx, cy, rx, ry, rot, laf, sf, ax, ay, sp);
        cx = ax; cy = ay; lastCtrl = null;
      } else if (C === 'Z') {
        if (sp) { sp.closed = true; cx = sx; cy = sy; }
        lastCtrl = null;
      }
      lastCmd = cmd;
    }
    if (sp && sp.verts.length) subs.push(sp);
    for (var k = 0; k < subs.length; k++) {
      var s = subs[k];
      if (s.closed && s.verts.length > 1) {
        var a = s.verts[0], b = s.verts[s.verts.length - 1];
        if (Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4) {
          s.inT[0] = s.inT[s.verts.length - 1];
          s.verts.pop(); s.inT.pop(); s.outT.pop();
        }
      }
    }
    return subs;
  }

  // ---------- primitive -> subpaths ----------
  function rectSub(x, y, w, h, rx, ry) {
    if (!rx && !ry) {
      var sp = newSub(); sp.closed = true;
      var pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      for (var i = 0; i < 4; i++) { sp.verts.push(pts[i]); sp.inT.push([0, 0]); sp.outT.push([0, 0]); }
      return [sp];
    }
    if (rx == null) rx = ry; if (ry == null) ry = rx;
    rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
    var k = 0.5522847498;
    var s2 = newSub(); s2.closed = true;
    // 8 vertices (2 per corner). in/out tangents make each corner a quarter-ellipse.
    s2.verts = [
      [x + rx, y], [x + w - rx, y],
      [x + w, y + ry], [x + w, y + h - ry],
      [x + w - rx, y + h], [x + rx, y + h],
      [x, y + h - ry], [x, y + ry]
    ];
    s2.inT = [
      [-rx * k, 0], [0, 0],
      [0, -ry * k], [0, 0],
      [rx * k, 0], [0, 0],
      [0, ry * k], [0, 0]
    ];
    s2.outT = [
      [0, 0], [rx * k, 0],
      [0, 0], [0, ry * k],
      [0, 0], [-rx * k, 0],
      [0, 0], [0, -ry * k]
    ];
    return [s2];
  }
  function ellipseSub(cx, cy, rx, ry) {
    var k = 0.5522847498;
    var sp = newSub(); sp.closed = true;
    sp.verts = [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]];
    sp.outT = [[rx * k, 0], [0, ry * k], [-rx * k, 0], [0, -ry * k]];
    sp.inT = [[-rx * k, 0], [0, -ry * k], [rx * k, 0], [0, ry * k]];
    return [sp];
  }
  function polySub(pointsStr, closed) {
    var nums = pointsStr.replace(/,/g, ' ').split(/\s+/);
    var sp = newSub(); sp.closed = closed;
    for (var i = 0; i + 1 < nums.length; i += 2) {
      if (trim(nums[i]) === '') { i--; continue; }
      sp.verts.push([parseFloat(nums[i]), parseFloat(nums[i + 1])]);
      sp.inT.push([0, 0]); sp.outT.push([0, 0]);
    }
    return [sp];
  }

  // ---------- transform subpaths ----------
  function transformSubs(subs, m) {
    for (var i = 0; i < subs.length; i++) {
      var s = subs[i];
      for (var j = 0; j < s.verts.length; j++) {
        s.verts[j] = applyPt(m, s.verts[j][0], s.verts[j][1]);
        s.inT[j] = applyVec(m, s.inT[j][0], s.inT[j][1]);
        s.outT[j] = applyVec(m, s.outT[j][0], s.outT[j][1]);
      }
    }
    return subs;
  }

  // ---------- attribute reading (attr + inline style) ----------
  function readStyle(attrs) {
    var st = {};
    if (attrs.style) {
      var decls = attrs.style.split(';');
      for (var i = 0; i < decls.length; i++) {
        var kv = decls[i].split(':');
        if (kv.length === 2) st[trim(kv[0])] = trim(kv[1]);
      }
    }
    return function pick(name) { return st.hasOwnProperty(name) ? st[name] : attrs[name]; };
  }

  // ---------- minimal XML walk ----------
  function parseXML(svg) {
    var root = { tag: 'root', attrs: {}, children: [] };
    var stack = [root];
    var re = /<(\/?)([a-zA-Z0-9:]+)((?:[^">]|"[^"]*")*?)(\/?)>/g, r;
    while ((r = re.exec(svg)) !== null) {
      var closing = r[1] === '/';
      var tag = r[2];
      var attrStr = r[3];
      var selfClose = r[4] === '/';
      if (closing) { if (stack.length > 1) stack.pop(); continue; }
      var attrs = {};
      var are = /([a-zA-Z0-9:_-]+)\s*=\s*"([^"]*)"/g, ar;
      while ((ar = are.exec(attrStr)) !== null) { attrs[ar[1]] = ar[2]; }
      var node = { tag: tag, attrs: attrs, children: [] };
      stack[stack.length - 1].children.push(node);
      if (!selfClose) stack.push(node);
    }
    return root;
  }

  // ---------- main ----------

  // Figma exports a shape that has BOTH a fill and a stroke as TWO elements: the filled one
  // first, then an identical outline. Imported literally that doubles every such layer (3 dots
  // arriving as 6). Merge the pair back into one shape carrying both paints.
  function geomKey(sh) {
    if (sh.prim) {
      return sh.prim.k + '|' + Math.round(sh.prim.cx * 100) + '|' + Math.round(sh.prim.cy * 100) + '|' +
             Math.round((sh.prim.w || sh.prim.rx * 2) * 100) + '|' + Math.round((sh.prim.h || sh.prim.ry * 2) * 100);
    }
    var k = 'p', subs = sh.subpaths, i, v;
    for (i = 0; i < subs.length; i++) {
      v = subs[i].verts;
      if (!v.length) continue;
      k += '|' + v.length + ':' + Math.round(v[0][0] * 100) + ',' + Math.round(v[0][1] * 100) +
           ';' + Math.round(v[v.length - 1][0] * 100) + ',' + Math.round(v[v.length - 1][1] * 100);
    }
    return k;
  }
  // Figma allows SEVERAL fills and strokes on one layer and exports each paint as its own
  // element. Two extra wrinkles make them hard to spot:
  //   * an INSIDE stroke is drawn on a slightly smaller shape (inset by the stroke width), so
  //     the geometry never matches exactly — compare with a tolerance instead;
  //   * the topmost paint must stay on top, so paints are kept in file order.
  function bboxOf(sh) {
    if (sh.prim) {
      var w = (sh.prim.w != null ? sh.prim.w : sh.prim.rx * 2);
      var h = (sh.prim.h != null ? sh.prim.h : sh.prim.ry * 2);
      return { cx: sh.prim.cx, cy: sh.prim.cy, w: w, h: h };
    }
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, i, j, v;
    for (i = 0; i < sh.subpaths.length; i++) {
      v = sh.subpaths[i].verts;
      for (j = 0; j < v.length; j++) {
        if (v[j][0] < x0) x0 = v[j][0]; if (v[j][1] < y0) y0 = v[j][1];
        if (v[j][0] > x1) x1 = v[j][0]; if (v[j][1] > y1) y1 = v[j][1];
      }
    }
    if (x0 > x1) return { cx: 0, cy: 0, w: 0, h: 0 };
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
  }
  function sameShape(a, b) {
    var ba = bboxOf(a), bb = bboxOf(b);
    if (!ba.w && !ba.h) return false;
    // An inside stroke shrinks the shape SYMMETRICALLY: the centre does not move and each side
    // comes in by half the stroke width. So the centre must line up tightly (a loose centre
    // tolerance made neighbouring cards swallow each other), while the size may differ by up
    // to one stroke width.
    var sw = Math.max(a.strokeWidth || 0, b.strokeWidth || 0);
    var cTol = 0.75;
    var sTol = Math.max(1.0, sw + 0.75);
    return Math.abs(ba.cx - bb.cx) <= cTol && Math.abs(ba.cy - bb.cy) <= cTol &&
           Math.abs(ba.w - bb.w) <= sTol && Math.abs(ba.h - bb.h) <= sTol;
  }
  function mergeStrokeTwins(shapes) {
    for (var i = 0; i < shapes.length; i++) {
      var base = shapes[i];
      if (!base || base.imageSlot) continue;

      var run = [], j = i + 1;
      while (j < shapes.length && shapes[j] && !shapes[j].imageSlot &&
             sameShape(base, shapes[j]) &&
             Math.abs((shapes[j].opacity == null ? 1 : shapes[j].opacity) - (base.opacity == null ? 1 : base.opacity)) < 0.001) {
        run.push(shapes[j]); j++;
      }
      if (!run.length) continue;

      base.extraPaints = base.extraPaints || [];
      for (var r = 0; r < run.length; r++) {
        var sh = run[r];
        if (sh.fill || sh.gradient) {
          // A later fill paints OVER the earlier one, so it becomes the layer's main fill and
          // the previous one drops to an extra underneath. (The mic icon is a grey placeholder
          // with the real gradient on top — keeping the first fill made it grey.)
          if (base.fill || base.gradient) {
            base.extraPaints.push({ kind: 'fill', under: true, color: base.fill, gradient: base.gradient,
                                    opacity: base.fillOpacity, fillRule: base.fillRule });
          }
          base.fill = sh.fill; base.gradient = sh.gradient;
          base.fillOpacity = sh.fillOpacity; base.fillRule = sh.fillRule;
        }
        if (sh.stroke || sh.strokeGradient) {
          if (!base.stroke && !base.strokeGradient) {
            base.stroke = sh.stroke; base.strokeGradient = sh.strokeGradient;
            base.strokeWidth = sh.strokeWidth; base.strokeOpacity = sh.strokeOpacity;
            base.strokeCap = sh.strokeCap; base.strokeJoin = sh.strokeJoin; base.strokeMiter = sh.strokeMiter;
            base.strokeDash = sh.strokeDash; base.strokeDashOffset = sh.strokeDashOffset;
          } else {
            base.extraPaints.push({ kind: 'stroke', color: sh.stroke, gradient: sh.strokeGradient,
                                    width: sh.strokeWidth, opacity: sh.strokeOpacity,
                                    cap: sh.strokeCap, join: sh.strokeJoin, miter: sh.strokeMiter,
                                    dash: sh.strokeDash, dashOffset: sh.strokeDashOffset });
          }
        }
        if (isGenericName(base.name) && !isGenericName(sh.name)) base.name = sh.name;
        if (!base.blur && sh.blur) base.blur = sh.blur;
      }
      if (!base.extraPaints.length) base.extraPaints = null;
      shapes.splice(i + 1, run.length);
    }
  }
  function isGenericName(nm) {
    return !nm || nm === 'rect' || nm === 'path' || nm === 'circle' ||
           nm === 'ellipse' || nm === 'line' || nm === 'polygon' || nm === 'polyline';
  }

  function parse(svgString) {
    var root = parseXML(svgString);
    function findSvg(n) {
      if (n.tag === 'svg') return n;
      for (var i = 0; i < n.children.length; i++) { var f = findSvg(n.children[i]); if (f) return f; }
      return null;
    }
    var svg = findSvg(root) || root;
    var width = parseFloat(svg.attrs.width) || 0;
    var height = parseFloat(svg.attrs.height) || 0;
    if ((!width || !height) && svg.attrs.viewBox) {
      var vb = svg.attrs.viewBox.replace(/,/g, ' ').split(/\s+/);
      width = width || parseFloat(vb[2]); height = height || parseFloat(vb[3]);
    }

    var shapes = [];

    // ---- collect gradient defs anywhere in the tree (Figma puts them in <defs>) ----
    var gradients = {};
    (function scanGrads(n) {
      if (n.tag === 'linearGradient' || n.tag === 'radialGradient') {
        var id = n.attrs.id;
        if (id) {
          var stops = [];
          for (var c = 0; c < n.children.length; c++) {
            var ch = n.children[c];
            if (ch.tag !== 'stop') continue;
            var pick = readStyle(ch.attrs);
            var col = parseColor(pick('stop-color'));
            if (col == null || col.url) col = [0, 0, 0];
            var off = pick('offset');
            var o = 0;
            if (off != null) { off = trim(String(off)); o = (off.charAt(off.length - 1) === '%') ? parseFloat(off) / 100 : parseFloat(off); }
            var so = pick('stop-opacity');
            stops.push({ offset: o, color: col, opacity: so != null ? parseFloat(so) : 1 });
          }
          gradients[id] = {
            type: n.tag === 'radialGradient' ? 'radial' : 'linear',
            stops: stops,
            units: n.attrs.gradientUnits || 'objectBoundingBox',
            gt: parseTransform(n.attrs.gradientTransform),
            x1: n.attrs.x1, y1: n.attrs.y1, x2: n.attrs.x2, y2: n.attrs.y2,
            cx: n.attrs.cx, cy: n.attrs.cy, r: n.attrs.r,
            href: n.attrs['xlink:href'] || n.attrs.href
          };
        }
      }
      for (var i = 0; i < n.children.length; i++) scanGrads(n.children[i]);
    })(svg);
    // Figma sometimes splits geometry and stops across href-linked gradients
    for (var gid in gradients) {
      if (!gradients.hasOwnProperty(gid)) continue;
      var G = gradients[gid];
      if ((!G.stops || !G.stops.length) && G.href) {
        var ref = gradients[String(G.href).replace('#', '')];
        if (ref) G.stops = ref.stops;
      }
    }
    function gnum(v, d) { var x = parseFloat(v); return isNaN(x) ? d : x; }
    function bboxOf(subs) {
      var minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
      for (var i = 0; i < subs.length; i++) { var vv = subs[i].verts; for (var j = 0; j < vv.length; j++) { var p = vv[j]; if (p[0] < minx) minx = p[0]; if (p[1] < miny) miny = p[1]; if (p[0] > maxx) maxx = p[0]; if (p[1] > maxy) maxy = p[1]; } }
      return { x: minx, y: miny, w: maxx - minx, h: maxy - miny };
    }
    // compute gradient start/end in comp space (before path transform is applied to verts)
    function gradGeom(g, ctx, subsOrig) {
      var x1, y1, x2, y2;
      if (g.type === 'radial') {
        var cx, cy, r;
        if (g.units === 'userSpaceOnUse') { cx = gnum(g.cx, 0); cy = gnum(g.cy, 0); r = gnum(g.r, 0); }
        else { var bb = bboxOf(subsOrig); cx = bb.x + gnum(g.cx, 0.5) * bb.w; cy = bb.y + gnum(g.cy, 0.5) * bb.h; r = gnum(g.r, 0.5) * Math.max(bb.w, bb.h); }
        x1 = cx; y1 = cy; x2 = cx + r; y2 = cy;
      } else {
        if (g.units === 'userSpaceOnUse') { x1 = gnum(g.x1, 0); y1 = gnum(g.y1, 0); x2 = gnum(g.x2, 1); y2 = gnum(g.y2, 0); }
        else { var b = bboxOf(subsOrig); x1 = b.x + gnum(g.x1, 0) * b.w; y1 = b.y + gnum(g.y1, 0) * b.h; x2 = b.x + gnum(g.x2, 1) * b.w; y2 = b.y + gnum(g.y2, 0) * b.h; }
      }
      var m = matMul(ctx.matrix, g.gt);
      var s = applyPt(m, x1, y1), e = applyPt(m, x2, y2);
      return { start: [s[0], s[1]], end: [e[0], e[1]] };
    }

    // representative solid color for a gradient (most opaque stop) — v1 approximation
    function representative(grad) {
      if (!grad || !grad.stops.length) return { color: [0.5, 0.5, 0.5], opacity: 1 };
      var best = grad.stops[0];
      for (var i = 1; i < grad.stops.length; i++) if (grad.stops[i].opacity > best.opacity) best = grad.stops[i];
      return { color: best.color, opacity: best.opacity };
    }
    // resolve a fill/stroke value -> { color:[r,g,b] | null, opacityMul, gradient }
    function resolvePaint(val) {
      if (val && val.url) {
        var g = gradients[val.url];
        if (g) { var r = representative(g); return { color: r.color, opacityMul: r.opacity, gradient: g }; }
        // Unknown reference = an <image> pattern fill. It must not paint (it used to render
        // grey), but it still marks WHERE the picture sits in the stack, so it is kept as a
        // placeholder — otherwise imported footage lands on top of everything.
        return { color: null, opacityMul: 1, gradient: null, isImage: true };
      }
      return { color: val, opacityMul: 1, gradient: null };
    }

    // Figma states the blur right in the file: blurred content sits inside
    // <g filter="url(#id)"> and the matching <filter> holds feGaussianBlur/stdDeviation.
    // Reading it here targets the exact layers, instead of guessing by bounding box.
    var filters = {};
    (function collectFilters(n) {
      if (n.tag === 'filter' && n.attrs && n.attrs.id) {
        // ONLY a real layer blur counts. Drop shadows and inner shadows are built out of
        // feGaussianBlur as well, and taking their deviation blurred whole panels that should
        // merely have carried a shadow. Figma tags the genuine one 'effectN_foregroundBlur'.
        var sd = 0, isBlur = false;
        (function scan(k) {
          if (k.attrs) {
            var res = String(k.attrs.result || '');
            if (res.indexOf('foregroundBlur') !== -1 || res.indexOf('backgroundBlur') !== -1) isBlur = true;
            if (k.tag === 'feGaussianBlur' && k.attrs.stdDeviation != null) {
              var v = parseFloat(String(k.attrs.stdDeviation).split(/[\s,]+/)[0]);
              if (v > sd) sd = v;
            }
          }
          for (var c = 0; c < k.children.length; c++) scan(k.children[c]);
        })(n);
        if (sd > 0 && isBlur) filters[n.attrs.id] = sd;
      }
      for (var i = 0; i < n.children.length; i++) collectFilters(n.children[i]);
    })(root);

    // containers whose contents must NEVER be drawn (defs, masks, clip paths, filters…)
    var SKIP = {
      defs: 1, clipPath: 1, mask: 1, filter: 1, pattern: 1, symbol: 1, marker: 1,
      linearGradient: 1, radialGradient: 1, style: 1, title: 1, desc: 1, metadata: 1
    };

    function inherit(parentCtx, attrs) {
      var pick = readStyle(attrs);
      var f = parseColor(pick('fill'));
      var s = parseColor(pick('stroke'));
      return {
        fill: (f === undefined) ? parentCtx.fill : f,
        fillSet: (f === undefined) ? parentCtx.fillSet : true,   // was fill ever explicitly given?
        stroke: (s === undefined) ? parentCtx.stroke : s,
        strokeWidth: pick('stroke-width') != null ? parseFloat(pick('stroke-width')) : parentCtx.strokeWidth,
        strokeCap: pick('stroke-linecap') != null ? pick('stroke-linecap') : parentCtx.strokeCap,
        strokeJoin: pick('stroke-linejoin') != null ? pick('stroke-linejoin') : parentCtx.strokeJoin,
        strokeMiter: pick('stroke-miterlimit') != null ? parseFloat(pick('stroke-miterlimit')) : parentCtx.strokeMiter,
        strokeDash: pick('stroke-dasharray') != null ? pick('stroke-dasharray') : parentCtx.strokeDash,
        strokeDashOff: pick('stroke-dashoffset') != null ? parseFloat(pick('stroke-dashoffset')) : parentCtx.strokeDashOff,
        fillRule: (pick('fill-rule') != null) ? pick('fill-rule') : (pick('clip-rule') != null ? pick('clip-rule') : parentCtx.fillRule),
        fillOpacity: pick('fill-opacity') != null ? parseFloat(pick('fill-opacity')) : parentCtx.fillOpacity,
        strokeOpacity: pick('stroke-opacity') != null ? parseFloat(pick('stroke-opacity')) : parentCtx.strokeOpacity,
        // opacity is multiplicative down the tree (a group's opacity affects its children)
        opacity: (pick('opacity') != null ? parseFloat(pick('opacity')) : 1) * (parentCtx.opacity == null ? 1 : parentCtx.opacity),
        matrix: matMul(parentCtx.matrix, parseTransform(attrs.transform)),
        filterId: (function () {
          var fu = attrs.filter && String(attrs.filter).match(/url\(\s*['"]?#([^)'"\s]+)/);
          return fu ? fu[1] : parentCtx.filterId;
        })()
      };
    }

    // `prim` (optional) describes a PARAMETRIC primitive so AE can build a real Rectangle /
    // Ellipse shape instead of a generic bezier path: {k:'rect',x,y,w,h,r} | {k:'ellipse',cx,cy,rx,ry}
    function emit(subs, ctx, name, prim) {
      if (!subs || !subs.length) return;

      var strokeVal = (ctx.stroke === undefined) ? null : ctx.stroke;
      var strokeColor = null, strokeOp = (ctx.strokeOpacity == null ? 1 : ctx.strokeOpacity), strokeGradDesc = null;
      if (strokeVal) {
        var rs = resolvePaint(strokeVal);
        strokeColor = rs.color; strokeOp = strokeOp * rs.opacityMul;
        if (rs.gradient && rs.gradient.stops && rs.gradient.stops.length >= 2) {
          var sgeom = gradGeom(rs.gradient, ctx, subs);   // subs still untransformed here
          if (sgeom) strokeGradDesc = { type: rs.gradient.type, stops: rs.gradient.stops, start: sgeom.start, end: sgeom.end };
        }
      }

      // Fill resolution. If fill was never specified: a stroked element is a stroke-only
      // icon (checkmarks, arrows) -> no fill; otherwise SVG's default fill is black.
      var fillVal;
      if (ctx.fill === undefined) fillVal = strokeVal ? null : [0, 0, 0];
      else fillVal = ctx.fill;

      var fillColor = null, fillOp = (ctx.fillOpacity == null ? 1 : ctx.fillOpacity), gradDesc = null, isImageSlot = false;
      if (fillVal) {
        var rf = resolvePaint(fillVal);
        if (rf.isImage) isImageSlot = true;
        fillColor = rf.color; fillOp = fillOp * rf.opacityMul;
        if (rf.gradient && rf.gradient.stops && rf.gradient.stops.length >= 2) {
          var geom = gradGeom(rf.gradient, ctx, subs);   // subs still untransformed here
          if (geom) {
            gradDesc = { type: rf.gradient.type, stops: rf.gradient.stops, start: geom.start, end: geom.end, fillOpacity: (ctx.fillOpacity == null ? 1 : ctx.fillOpacity) };
            fillColor = null;                            // real gradient replaces the solid approx
          }
        }
      }

      // drop fully-invisible shapes (e.g. text hidden at opacity 0 for the export, leftover helpers)
      var op = (ctx.opacity == null ? 1 : ctx.opacity);
      var visFill = (gradDesc != null) || (fillColor && fillOp > 0.001);
      var visStroke = (strokeColor && strokeOp > 0.001 && (ctx.strokeWidth == null ? 1 : ctx.strokeWidth) > 0);
      if (op <= 0.001 || (!visFill && !visStroke && !isImageSlot)) return;   // keep image slots

      transformSubs(subs, ctx.matrix);                   // now bake the path geometry

      // Map the primitive through the CTM too. Rotation/skew can't be expressed by AE's
      // parametric Rect/Ellipse (they're axis-aligned), so in that case drop to the path.
      var primOut = null;
      if (prim) {
        var m = ctx.matrix || [1, 0, 0, 1, 0, 0];
        var axisAligned = (Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6);
        if (axisAligned) {
          var sx = m[0], sy = m[3], tx = m[4], ty = m[5];
          if (prim.k === 'rect') {
            var x2 = prim.x * sx + tx, y2 = prim.y * sy + ty, w2 = prim.w * sx, h2 = prim.h * sy;
            if (w2 < 0) { x2 += w2; w2 = -w2; }
            if (h2 < 0) { y2 += h2; h2 = -h2; }
            primOut = { k: 'rect', cx: x2 + w2 / 2, cy: y2 + h2 / 2, w: w2, h: h2, r: (prim.r || 0) * Math.abs(sx) };
          } else if (prim.k === 'ellipse') {
            primOut = { k: 'ellipse', cx: prim.cx * sx + tx, cy: prim.cy * sy + ty, rx: Math.abs(prim.rx * sx), ry: Math.abs(prim.ry * sy) };
          }
        }
      }

      // stroke style: cap/join/miter enums for AE, dash array parsed to numbers
      var capMap = { butt: 1, round: 2, square: 3 };
      var joinMap = { miter: 1, round: 2, bevel: 3 };
      var dash = null;
      if (ctx.strokeDash && String(ctx.strokeDash).toLowerCase() !== 'none') {
        var parts = String(ctx.strokeDash).replace(/,/g, ' ').split(/\s+/), dd = [];
        for (var di = 0; di < parts.length; di++) { if (trim(parts[di]) !== '') dd.push(parseFloat(parts[di])); }
        if (dd.length) { if (dd.length % 2 === 1) dd = dd.concat(dd); dash = dd; }  // odd repeats per SVG spec
      }

      shapes.push({
        name: name || 'Shape',
        subpaths: subs,
        prim: primOut,                   // parametric Rect/Ellipse for AE (null = use the path)
        imageSlot: isImageSlot,          // marks where an imported picture belongs in the stack
        // Figma's blur radius is 2 x the SVG standard deviation, and AE's Blurriness is the
        // same kind of radius — so stdDev x 2. (x4 over-blurred everything: a glow at 740
        // spread so thin it vanished against the background.)
        blur: (ctx.filterId && filters[ctx.filterId]) ? filters[ctx.filterId] * 2 : 0,
        fill: fillColor,                 // null = no solid fill
        fillOpacity: fillOp,
        fillRule: (ctx.fillRule != null && String(ctx.fillRule).toLowerCase() === 'evenodd') ? 2 : 1,  // 1 nonzero, 2 evenodd
        gradient: gradDesc,              // { type, stops, start, end } | null
        stroke: strokeColor,
        strokeGradient: strokeGradDesc,   // { type, stops, start, end } | null
        strokeWidth: ctx.strokeWidth == null ? 1 : ctx.strokeWidth,
        strokeOpacity: strokeOp,
        strokeCap: (ctx.strokeCap != null) ? (capMap[String(ctx.strokeCap).toLowerCase()] || null) : null,
        strokeJoin: (ctx.strokeJoin != null) ? (joinMap[String(ctx.strokeJoin).toLowerCase()] || null) : null,
        strokeMiter: (ctx.strokeMiter != null) ? ctx.strokeMiter : null,
        strokeDash: dash,
        strokeDashOffset: (ctx.strokeDashOff != null) ? ctx.strokeDashOff : null,
        opacity: ctx.opacity == null ? 1 : ctx.opacity
      });
    }

    function walk(node, parentCtx) {
      if (SKIP[node.tag]) return;        // never draw defs/clip/mask/filter/gradient contents
      var ctx = inherit(parentCtx, node.attrs);
      var a = node.attrs;
      // Figma writes the layer name into `id` (svgIdAttribute) and escapes odd characters as
      // _x20_ style codes — decode them so AE shows the name exactly as in Figma.
      var nm = node.tag;
      if (a.id) {
        nm = String(a.id).replace(/_x([0-9A-Fa-f]{2})_/g, function (m, hx) {
          return String.fromCharCode(parseInt(hx, 16));
        });
      }
      if (node.tag === 'path' && a.d) emit(parsePathData(a.d), ctx, nm);
      else if (node.tag === 'rect') {
        var rx0 = parseFloat(a.x) || 0, ry0 = parseFloat(a.y) || 0, rw0 = parseFloat(a.width) || 0, rh0 = parseFloat(a.height) || 0;
        var rr0 = a.rx != null ? parseFloat(a.rx) : (a.ry != null ? parseFloat(a.ry) : null);
        emit(rectSub(rx0, ry0, rw0, rh0, a.rx != null ? parseFloat(a.rx) : null, a.ry != null ? parseFloat(a.ry) : null), ctx, nm,
             { k: 'rect', x: rx0, y: ry0, w: rw0, h: rh0, r: rr0 || 0 });
      }
      else if (node.tag === 'circle') {
        var cr = parseFloat(a.r) || 0, ccx = parseFloat(a.cx) || 0, ccy = parseFloat(a.cy) || 0;
        emit(ellipseSub(ccx, ccy, cr, cr), ctx, nm, { k: 'ellipse', cx: ccx, cy: ccy, rx: cr, ry: cr });
      }
      else if (node.tag === 'ellipse') {
        var ecx = parseFloat(a.cx) || 0, ecy = parseFloat(a.cy) || 0, erx = parseFloat(a.rx) || 0, ery = parseFloat(a.ry) || 0;
        emit(ellipseSub(ecx, ecy, erx, ery), ctx, nm, { k: 'ellipse', cx: ecx, cy: ecy, rx: erx, ry: ery });
      }
      else if (node.tag === 'line') { var ls = newSub(); ls.verts = [[parseFloat(a.x1) || 0, parseFloat(a.y1) || 0], [parseFloat(a.x2) || 0, parseFloat(a.y2) || 0]]; ls.inT = [[0, 0], [0, 0]]; ls.outT = [[0, 0], [0, 0]]; emit([ls], ctx, nm); }
      else if (node.tag === 'polyline') emit(polySub(a.points || '', false), ctx, nm);
      else if (node.tag === 'polygon') emit(polySub(a.points || '', true), ctx, nm);
      for (var i = 0; i < node.children.length; i++) walk(node.children[i], ctx);
    }

    var baseCtx = { fill: undefined, stroke: undefined, strokeWidth: 1, fillOpacity: 1, strokeOpacity: 1, opacity: 1, matrix: [1, 0, 0, 1, 0, 0] };
    for (var i = 0; i < svg.children.length; i++) walk(svg.children[i], baseCtx);

        // MERGE IS OFF. Collapsing Figma's per-paint elements into one layer kept eating real
    // artwork (card backgrounds, background glows), so correctness wins over layer count until
    // the rule is proven on real files. Flip to true to re-enable.
    var MERGE_PAINTS = false;
    if (MERGE_PAINTS) mergeStrokeTwins(shapes);
    return { width: width, height: height, shapes: layerStyleStrokes(shapes) };
  }

  // Layer Styles stroke follows the alpha boundary of closed artwork. Open paths,
  // dashes and gradient strokes are path paints and keep their original geometry.
  function layerStyleStrokes(shapes) {
    var out = [];
    for (var i = 0; i < shapes.length; i++) {
      var s = shapes[i], closed = !!s.prim, j;
      if (!closed && s.subpaths.length) {
        closed = true;
        for (j = 0; j < s.subpaths.length; j++) if (!s.subpaths[j].closed) closed = false;
      }
      if (!closed) { out.push(s); continue; }
      var strokes = [], extras = [], paints = s.extraPaints || [];
      if (s.stroke && s.strokeWidth > 0 && !(s.strokeDash && s.strokeDash.length)) {
        strokes.push({color:s.stroke, width:s.strokeWidth, opacity:s.strokeOpacity, align:s.strokeAlign});
        s.stroke = null;
      }
      for (j = 0; j < paints.length; j++) {
        var p = paints[j];
        if (p.kind === 'stroke' && p.color && !p.gradient && p.width > 0 && !(p.dash && p.dash.length))
          strokes.push({color:p.color, width:p.width, opacity:p.opacity, align:p.align});
        else extras.push(p);
      }
      s.extraPaints = extras.length ? extras : null;
      if (!strokes.length) { out.push(s); continue; }
      // Keep paint alpha in Fill Opacity, so a translucent fill does not also
      // attenuate its independent border. More complex fills get a border carrier.
      if (strokes.length === 1 && !s.gradient && !s.strokeGradient && !s.stroke && !extras.length) {
        s.layerStroke = strokes[0];
        s.layerFillOpacity = s.fill ? s.fillOpacity : 0;
        s.fill = s.fill || [1,1,1]; s.fillOpacity = 1;
        out.push(s);
      } else {
        var hasBase = !!(s.fill || s.gradient || s.stroke || s.strokeGradient || extras.length);
        if (hasBase) out.push(s);
        for (j = 0; j < strokes.length; j++) {
          var carrier = _paintCopy(s, !hasBase && j === 0);
          carrier.name = s.name + ' stroke' + (j ? ' ' + (j + 1) : '');
          carrier.fill = [1,1,1]; carrier.layerFillOpacity = 0; carrier.layerStroke = strokes[j];
          if (s.z != null) carrier.z = s.z + (j + 1) / 10000;
          out.push(carrier);
        }
      }
    }
    return out;
  }

  // One paint of a multi-gradient node as its own layer. subpaths and prim are only ever read
  // after this point, so the copies can share them; the paint slots are reset for the caller.
  // Effects go on the FIRST copy alone — a drop shadow belongs to the node, not to every paint.
  function _paintCopy(sh, first) {
    var c = {}, key;
    for (key in sh) if (sh.hasOwnProperty(key)) c[key] = sh[key];
    c.extraPaints = null;
    c.fill = null; c.gradient = null; c.fillOpacity = 1;
    c.stroke = null; c.strokeGradient = null; c.strokeOpacity = 1;
    c.strokeWidth = 0;
    if (!first) c.fx = null;
    return c;
  }

  // ===== NODE-TREE MODE (beta) =====
  // Build the very same shape model straight from Figma nodes. Each node arrives with its own
  // geometry, transform and full paint stack, so one Figma layer maps to exactly one AE layer —
  // no guessing which SVG elements belonged together.
  function fromNodes(nodes, width, height, origin) {
    var ox = (origin && origin.x) || 0, oy = (origin && origin.y) || 0;
    var shapes = [], i, k;
    for (i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      var subs = [];
      for (k = 0; k < nd.paths.length; k++) {
        var part = parsePathData(nd.paths[k].d);
        for (var q = 0; q < part.length; q++) subs.push(part[q]);
      }
      if (!subs.length) continue;

      // node-local geometry -> absolute -> frame-relative
      transformSubs(subs, nd.matrix);
      for (k = 0; k < subs.length; k++) {
        var v = subs[k].verts;
        for (var j = 0; j < v.length; j++) { v[j][0] -= ox; v[j][1] -= oy; }
      }

      // A Rectangle / Ellipse node becomes a REAL parametric AE shape with editable Size and
      // Roundness instead of dead path points. AE's primitives are axis-aligned, so a rotated or
      // skewed node keeps its path — the matrix here is [a,b,c,d,e,f] and b/c carry the rotation.
      var primOut = null;
      if (nd.prim && nd.matrix) {
        var mm = nd.matrix;
        if (Math.abs(mm[1]) < 1e-6 && Math.abs(mm[2]) < 1e-6) {
          var pw = Math.abs(nd.prim.w * mm[0]), ph = Math.abs(nd.prim.h * mm[3]);
          var pcx = mm[0] * (nd.prim.w / 2) + mm[2] * (nd.prim.h / 2) + mm[4] - ox;
          var pcy = mm[1] * (nd.prim.w / 2) + mm[3] * (nd.prim.h / 2) + mm[5] - oy;
          if (nd.prim.k === 'rect') primOut = { k: 'rect', cx: pcx, cy: pcy, w: pw, h: ph, r: (nd.prim.r || 0) * Math.abs(mm[0]) };
          else primOut = { k: 'ellipse', cx: pcx, cy: pcy, rx: pw / 2, ry: ph / 2 };
        }
      }

      var sh = {
        name: nd.name || 'Shape',
        srcIndex: i,                     // keyed to the node list, so presets can be matched
        maskId: nd.maskId || null,       // content masked by this Figma mask root
        maskSource: nd.maskSource || null, // mask geometry only; never build it as visible art
        maskType: nd.maskType || 'ALPHA',
        path: nd.path || null,           // ancestor containers — organize mode groups by this
        subpaths: subs,
        prim: primOut,
        imageSlot: !!nd.imageFill,
        hidden: !!nd.hidden,
        // Effects come straight from the node here, so there is no bbox matching at all.
        // Blurriness matches Figma's blur radius (same convention as the SVG path).
        blur: (function () {
          var b = nd.inheritedBlur || 0, q;      // a blur on the parent group counts too
          if (nd.fx) for (q = 0; q < nd.fx.length; q++)
            if ((nd.fx[q].kind === 'blur' || nd.fx[q].kind === 'bgblur') && nd.fx[q].radius > b) b = nd.fx[q].radius;
          return b;
        })(),
        fx: nd.fx || null,               // drop / inner shadows for this exact layer
        fill: null, fillOpacity: 1, gradient: null,
        fillRule: (nd.paths[0] && nd.paths[0].evenOdd) ? 2 : 1,
        stroke: null, strokeGradient: null,
        // NOT `|| 1`: zero is falsy in JS, so a Figma stroke set to weight 0 came through as a
        // visible 1px line. Only a missing value falls back.
        strokeWidth: (nd.strokeWeight == null ? 1 : nd.strokeWeight),
        // Closed solid borders map to Layer Styles Stroke with native alignment.
        strokeAlign: nd.strokeAlign || 'CENTER',
        strokeOpacity: 1,
        strokeCap: nd.cap || null, strokeJoin: nd.join || null, strokeMiter: nd.miter || null,
        strokeDash: nd.dash || null, strokeDashOffset: null,
        opacity: (nd.opacity == null ? 1 : nd.opacity),
        blend: nd.blend || 'NORMAL',
        z: (nd.z == null ? 0 : nd.z),    // tree-wide paint order, used to restack at the end
        extraPaints: null
      };

      function axis(p) {
        return { type: p.type, stops: p.stops,
                 start: [p.p0[0] - ox, p.p0[1] - oy], end: [p.p1[0] - ox, p.p1[1] - oy] };
      }

      // The geometry is already the outlined stroke, so its paint has to go on as a FILL.
      if (nd.strokeAsFill && nd.strokes.length) {
        var sp0 = nd.strokes[0];
        if (sp0.kind === 'grad') sh.gradient = axis(sp0); else sh.fill = sp0.color;
        sh.fillOpacity = sp0.opacity;
        sh.strokeWidth = 0;
        shapes.push(sh);
        continue;
      }

      // SEVERAL GRADIENTS ON ONE NODE -> ONE LAYER PER PAINT.
      // Stacking them as extra groups inside a single layer depends on applyPreset, which drops
      // its group wherever it likes, and on hand-matched indices — that is what turned the
      // microphone button into a flat blob. The SVG path never had the problem because Figma
      // splits paints into separate elements, so do the same here. Only for MULTIPLE gradients:
      // a plain fill+stroke node stays one layer, which is why node mode was worth building.
      var fillsNoImg = [], strokesNoImg = [], gradCount = 0;
      for (k = 0; k < nd.fills.length; k++) if (nd.fills[k].kind !== 'image') { fillsNoImg.push(nd.fills[k]); if (nd.fills[k].kind === 'grad') gradCount++; }
      for (k = 0; k < nd.strokes.length; k++) if (nd.strokes[k].kind !== 'image') { strokesNoImg.push(nd.strokes[k]); if (nd.strokes[k].kind === 'grad') gradCount++; }

      if (gradCount >= 2) {
        // build() adds layers in forward order and AE stacks each new one on top, so the
        // bottom-most Figma paint has to be pushed first.
        var lastFill = fillsNoImg.length - 1, exBase = Math.max(0, lastFill), made = 0;
        for (k = 0; k < fillsNoImg.length; k++) {
          var cf = _paintCopy(sh, made === 0), pf = fillsNoImg[k];
          if (pf.kind === 'grad') { cf.gradient = axis(pf); cf.gradient.fillOpacity = pf.opacity; }
          else cf.fill = pf.color;
          cf.fillOpacity = pf.opacity;
          cf.presetRef = (k === lastFill) ? { kind: 'fill' } : { kind: 'extra', i: k };
          shapes.push(cf); made++;
        }
        for (k = 0; k < strokesNoImg.length; k++) {
          var cs2 = _paintCopy(sh, made === 0), ps = strokesNoImg[k];
          if (ps.kind === 'grad') cs2.strokeGradient = axis(ps); else cs2.stroke = ps.color;
          cs2.strokeOpacity = ps.opacity;
          cs2.strokeWidth = (nd.strokeWeight == null ? 1 : nd.strokeWeight);
          cs2.presetRef = (k === 0) ? { kind: 'stroke' } : { kind: 'extra', i: exBase + k - 1 };
          shapes.push(cs2); made++;
        }
        if (made) continue;
      }

      var extras = [];
      // Figma paints the LAST fill on top, which is the one AE should show as the layer's fill.
      for (k = 0; k < nd.fills.length; k++) {
        var fp = nd.fills[k];
        if (fp.kind === 'image') continue;                     // real footage arrives separately
        if (sh.fill || sh.gradient) {
          extras.push({ kind: 'fill', under: true, color: sh.fill, gradient: sh.gradient, opacity: sh.fillOpacity });
        }
        if (fp.kind === 'grad') { sh.gradient = axis(fp); sh.fill = null; }
        else { sh.fill = fp.color; sh.gradient = null; }
        sh.fillOpacity = fp.opacity;
        // The .ffx preset only carries per-STOP alpha; the paint's own opacity slider lives in
        // AE's Fill Opacity, and the builder reads it off the gradient descriptor.
        if (sh.gradient) sh.gradient.fillOpacity = fp.opacity;
      }
      for (k = 0; k < nd.strokes.length; k++) {
        var sp = nd.strokes[k];
        if (sp.kind === 'image') continue;
        if (!sh.stroke && !sh.strokeGradient) {
          if (sp.kind === 'grad') sh.strokeGradient = axis(sp); else sh.stroke = sp.color;
          sh.strokeOpacity = sp.opacity;
        } else {
          extras.push({ kind: 'stroke', color: (sp.kind === 'grad' ? null : sp.color),
                        gradient: (sp.kind === 'grad' ? axis(sp) : null),
                        width: sh.strokeWidth, opacity: sp.opacity, align: sh.strokeAlign,
                        cap: sh.strokeCap, join: sh.strokeJoin, miter: sh.strokeMiter, dash: sh.strokeDash });
        }
      }
      if (extras.length) sh.extraPaints = extras;
      shapes.push(sh);
    }
    return { width: width, height: height, shapes: layerStyleStrokes(shapes) };
  }

  return { parse: parse, parseColor: parseColor, parseTransform: parseTransform, parsePathData: parsePathData, fromNodes: fromNodes };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SVGParser;
