/* ===== f2a — real-time motion curve & keyframe preview engine =====
 * Evaluates both portable F2A motion clips (schemaVersion 1, with AE temporal ease)
 * and procedural AE Motion presets for live 60fps preview inside the CEP panel.
 * UMD: attaches window.F2AMotionPreview in browser/CEP and exports in Node.
 */
(function (root, factory) {
  var api = factory();
  // Adobe CEP (--enable-nodejs --mixed-context) exposes BOTH window and module.exports
  // inside <script> tags, so always attach the browser global in addition to CommonJS export.
  if (root) root.F2AMotionPreview = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // Solve cubic Bezier X(s) = u on [0,1] for 1D timing curve (0,0)-(x1,y1)-(x2,y2)-(1,1)
  function cubicCoord(s, p1, p2) {
    var u = 1 - s;
    return 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s;
  }
  function cubicDeriv(s, p1, p2) {
    var u = 1 - s;
    return 3 * u * u * p1 + 6 * u * s * (p2 - p1) + 3 * s * s * (1 - p2);
  }
  function solveBezierT(x, x1, x2) {
    x = clamp(x, 0, 1);
    var s = x;
    for (var i = 0; i < 6; i++) {
      var err = cubicCoord(s, x1, x2) - x;
      if (Math.abs(err) < 1e-5) break;
      var d = cubicDeriv(s, x1, x2);
      if (Math.abs(d) < 1e-6) break;
      s = clamp(s - err / d, 0, 1);
    }
    return s;
  }

  // Evaluate a single AE temporal segment between key k0 and key k1 at time t
  // After Effects shapes one segment with one cubic bezier: the outgoing side of k0 gives the first
  // handle and the incoming side of k1 gives the second one. A linear side is a handle at 1/6 (out)
  // or 5/6 (in) with slope 1 — that is exactly how AE's linear interpolation is drawn — while a
  // bezier side places its handle from the key's temporal ease. Both-linear is a plain lerp.
  function evalScalarSegment(t, t0, v0, k0, t1, v1, k1, dimIdx, spatial) {
    var dt = t1 - t0;
    if (dt <= 1e-6) return v1;
    var u = clamp((t - t0) / dt, 0, 1);
    if (k0.outInterp === "hold") return u >= 1 ? v1 : v0;
    var outLinear = k0.outInterp === "linear";
    var inLinear = k1.inInterp === "linear";
    if (outLinear && inLinear) return lerp(v0, v1, u);

    var dv = v1 - v0;
    if (Math.abs(dv) < 1e-6) return v0;
    // A spatial property (position) stores one temporal ease whose speed is a magnitude along the
    // motion path; AE clamps negative speeds to 0, so the handle slope uses the absolute travel.
    var dvHandle = spatial ? Math.abs(dv) : dv;

    var x1, y1, x2, y2;
    if (outLinear) {
      x1 = 1 / 6;
      y1 = x1;
    } else {
      var outEase = (k0.outEase && k0.outEase.length) ? k0.outEase[Math.min(dimIdx, k0.outEase.length - 1)] : { speed: 0, influence: 33.33 };
      x1 = clamp((outEase.influence || 33.33) / 100, 0.01, 0.99);
      // AE speed (units/sec) becomes the normalized handle slope dy/dx = speed * dt / dv
      y1 = clamp(x1 * (outEase.speed || 0) * dt / dvHandle, -1.2, 2.2);
    }
    if (inLinear) {
      x2 = 5 / 6;
      y2 = x2;
    } else {
      var inEase = (k1.inEase && k1.inEase.length) ? k1.inEase[Math.min(dimIdx, k1.inEase.length - 1)] : { speed: 0, influence: 33.33 };
      x2 = clamp(1 - (inEase.influence || 33.33) / 100, 0.01, 0.99);
      y2 = clamp(1 - (1 - x2) * (inEase.speed || 0) * dt / dvHandle, -1.2, 2.2);
    }

    var s = solveBezierT(u, x1, x2);
    var y = cubicCoord(s, y1, y2);
    return v0 + dv * y;
  }

  function evalTrack(track, t) {
    var keys = track.keys;
    if (!keys || !keys.length) return track.value;
    if (t <= keys[0].time) return keys[0].value;
    if (t >= keys[keys.length - 1].time) return keys[keys.length - 1].value;

    var idx = 0;
    for (var i = 0; i < keys.length - 1; i++) {
      if (t >= keys[i].time && t <= keys[i + 1].time) { idx = i; break; }
    }
    var k0 = keys[idx], k1 = keys[idx + 1];
    var spatial = track.type === "TwoD_SPATIAL" || track.type === "ThreeD_SPATIAL";
    if (typeof k0.value === "number") {
      return evalScalarSegment(t, k0.time, k0.value, k0, k1.time, k1.value, k1, 0, spatial);
    }
    if (Array.isArray(k0.value)) {
      var out = [];
      for (var d = 0; d < k0.value.length; d++) {
        out.push(evalScalarSegment(t, k0.time, k0.value[d], k0, k1.time, k1.value[d], k1, d, spatial));
      }
      return out;
    }
    return k0.value;
  }

  function propNameOf(track) {
    if (!track || !track.path || track.path.length < 2) return "";
    if (track.path[0][0] !== "ADBE Transform Group") return "";
    return track.path[1][0];
  }

  // Analyze clip bounds once so position displacements map proportionally to the mini stage
  function analyzeClip(clip, defaultAnchor) {
    var layer = clip && clip.layers && clip.layers[0];
    var tracks = layer ? layer.tracks : [];
    var anchor = defaultAnchor || "end";
    var restPos = [0, 0];
    var restRot = 0;
    var restScale = [100, 100];
    var maxTravel = 0;
    var trackNames = [];

    for (var i = 0; i < tracks.length; i++) {
      var tr = tracks[i], pn = propNameOf(tr), ks = tr.keys || [];
      if (!pn) continue;
      if (pn === "ADBE Position") {
        trackNames.push("位移");
        if (ks.length) {
          var refK = anchor === "start" ? ks[0] : ks[ks.length - 1];
          restPos = [refK.value[0] || 0, refK.value[1] || 0];
          for (var j = 0; j < ks.length; j++) {
            var d = Math.hypot((ks[j].value[0] || 0) - restPos[0], (ks[j].value[1] || 0) - restPos[1]);
            if (d > maxTravel) maxTravel = d;
          }
        }
      } else if (pn === "ADBE Position_0" || pn === "ADBE Position_1") {
        if (trackNames.indexOf("位移") < 0) trackNames.push("位移");
        if (ks.length) {
          var axis = pn === "ADBE Position_0" ? 0 : 1;
          var refP = anchor === "start" ? ks[0].value : ks[ks.length - 1].value;
          restPos[axis] = refP;
          for (var j2 = 0; j2 < ks.length; j2++) {
            var d2 = Math.abs(ks[j2].value - refP);
            if (d2 > maxTravel) maxTravel = d2;
          }
        }
      } else if (pn === "ADBE Scale") {
        trackNames.push("缩放");
        if (ks.length) {
          var refS = (anchor === "start" ? ks[0] : ks[ks.length - 1]).value;
          restScale = [Math.abs(refS[0]) > 10 ? refS[0] : 100, Math.abs(refS[1]) > 10 ? refS[1] : 100];
        }
      } else if (pn === "ADBE Rotate Z" || pn === "ADBE Rotation") {
        trackNames.push("旋转");
        if (ks.length) {
          restRot = (anchor === "start" ? ks[0] : ks[ks.length - 1]).value || 0;
        }
      } else if (pn === "ADBE Opacity") {
        trackNames.push("透明");
      }
    }

    return {
      duration: Math.max(0.05, Number(clip && clip.duration) || 0.6),
      restPos: restPos,
      restRot: restRot,
      restScale: restScale,
      maxTravel: maxTravel,
      trackNames: trackNames
    };
  }

  function evaluateClipAt(clip, t, defaultAnchor, meta) {
    var info = meta || analyzeClip(clip, defaultAnchor);
    var layer = clip && clip.layers && clip.layers[0];
    var tracks = layer ? layer.tracks : [];
    var dx = 0, dy = 0, sx = 1, sy = 1, rot = 0, opacity = 1;
    // Map travel so short UI moves (~70px) move ~18px on stage and big whip moves (~340px) move ~32px
    var posScale = info.maxTravel > 0 ? Math.min(34, Math.max(16, info.maxTravel * 0.25)) / info.maxTravel : 0;

    for (var i = 0; i < tracks.length; i++) {
      var tr = tracks[i], pn = propNameOf(tr);
      if (!pn) continue;
      var v = evalTrack(tr, t);
      if (pn === "ADBE Position" && Array.isArray(v)) {
        dx = (v[0] - info.restPos[0]) * posScale;
        dy = (v[1] - info.restPos[1]) * posScale;
      } else if (pn === "ADBE Position_0" && typeof v === "number") {
        dx = (v - info.restPos[0]) * posScale;
      } else if (pn === "ADBE Position_1" && typeof v === "number") {
        dy = (v - info.restPos[1]) * posScale;
      } else if (pn === "ADBE Scale" && Array.isArray(v)) {
        sx = clamp((v[0] || 0) / info.restScale[0], 0, 2.2);
        sy = clamp((v[1] || 0) / info.restScale[1], 0, 2.2);
      } else if ((pn === "ADBE Rotate Z" || pn === "ADBE Rotation") && typeof v === "number") {
        rot = v - info.restRot;
      } else if (pn === "ADBE Opacity" && typeof v === "number") {
        opacity = clamp(v / 100, 0, 1);
      }
    }
    return { dx: dx, dy: dy, scaleX: sx, scaleY: sy, rotate: rot, opacity: opacity };
  }

  // ---- Procedural preset easing curves ----
  // Cubic-bezier profiles for the React Bits motion vocabulary (power/expo/back), evaluated with the
  // same solver as the clip timeline so a preset card previews the curve that AE will apply.
  var EASE_CURVES = {
    power2Out: [0.33, 1, 0.68, 1],
    power3Out: [0.215, 0.61, 0.355, 1],
    power4Out: [0.165, 0.84, 0.44, 1],
    power5Out: [0.22, 1, 0.36, 1],
    power2InOut: [0.65, 0, 0.35, 1],
    expoOut: [0.16, 1, 0.3, 1],
    backOut: [0.34, 1.56, 0.64, 1],
    backInOut: [0.68, -0.55, 0.27, 1.55]
  };
  function evalCurve(style, u) {
    u = clamp(u, 0, 1);
    if (style === "linear") return u;
    if (style === "smooth") return u * u * (3 - 2 * u);
    if (style === "spring") {
      if (u <= 0) return 0;
      if (u >= 1) return 1;
      return 1 - Math.exp(-6.5 * u) * Math.cos(13.5 * u);
    }
    if (style === "bounce") {
      var n1 = 7.5625, d1 = 2.75;
      if (u < 1 / d1) return n1 * u * u;
      if (u < 2 / d1) return n1 * (u -= 1.5 / d1) * u + 0.75;
      if (u < 2.5 / d1) return n1 * (u -= 2.25 / d1) * u + 0.9375;
      return n1 * (u -= 2.625 / d1) * u + 0.984375;
    }
    if (style === "wave") return 1 - Math.cos(u * Math.PI * 1.5) * Math.pow(1 - u, 1.2);
    var c = EASE_CURVES[style];
    if (c) return cubicCoord(solveBezierT(u, c[0], c[2]), c[1], c[3]);
    // snappy (fast out, smooth landing)
    return 1 - Math.pow(1 - u, 3.2);
  }

  function evaluatePresetAt(preset, overrides, progress) {
    var d = Object.assign({}, preset.defaults || {}, overrides || {});
    var u = clamp(progress, 0, 1);
    var isText = preset.command === "text_reveal";
    // For text reveals the panel's global curve control overrides the reveal EASE; the text style
    // (rise/pop/…) always comes from the preset's own defaults, as it does when the preset is applied.
    var tStyle = isText ? ((preset.defaults || {}).style || "rise") : null;
    var style = isText
      ? ((overrides && overrides.style) || d.ease || "snappy")
      : (d.style || d.ease || "snappy");
    var e = evalCurve(style, u);
    var isOut = d.phase === "out";
    var dir = d.direction || "up";
    var k = isOut ? (1 - e) : e;

    if (preset.command === "animate") {
      var move = d.move || "fade";
      var dx = 0, dy = 0, sx = 1, sy = 1, rot = 0, op = 1;
      if (move === "fade") {
        op = clamp(k, 0, 1);
      } else if (move === "pop") {
        var s = Math.max(0, isOut ? (1 - evalCurve("snappy", u)) : e);
        sx = sy = s;
        op = clamp(isOut ? 1 - u * 1.3 : u * 3.2, 0, 1);
      } else if (move === "grow") {
        var gs = lerp(0.76, 1, k);
        sx = sy = gs;
        op = clamp(k, 0, 1);
      } else if (move === "slide") {
        var dist = 26;
        var vec = { up: [0, dist], down: [0, -dist], left: [dist, 0], right: [-dist, 0] }[dir] || [0, dist];
        var f = isOut ? evalCurve(style, u) : (1 - e);
        dx = vec[0] * (isOut ? -f : f);
        dy = vec[1] * (isOut ? -f : f);
        op = clamp(isOut ? 1 - u * 1.15 : u * 2.4, 0, 1);
      } else if (move === "drop") {
        dy = -30 * (1 - evalCurve(style === "snappy" ? "bounce" : style, u));
        op = clamp(u * 3.5, 0, 1);
      } else if (move === "spin") {
        rot = (isOut ? 1 : -1) * 90 * (isOut ? evalCurve(style, u) : (1 - e));
        sx = sy = Math.max(0, isOut ? (1 - u) : lerp(0.45, 1, clamp(e, 0, 1.15)));
        op = clamp(isOut ? 1 - u : u * 2.5, 0, 1);
      } else if (move === "push") {
        var amt = (Number(d.amount) || 8) / 100;
        sx = sy = 1 + amt * 2.2 * e;
      } else if (move === "drift") {
        var dv = { up: [0, -18], down: [0, 18], left: [-22, 0], right: [22, 0] }[dir] || [22, 0];
        dx = lerp(-dv[0] * 0.5, dv[0] * 0.5, u);
        dy = lerp(-dv[1] * 0.5, dv[1] * 0.5, u);
      }
      return { kind: "box", dx: dx, dy: dy, scaleX: sx, scaleY: sy, rotate: rot, opacity: op };
    }

    if (preset.command === "text_reveal") {
      var chars = ["S", "A", "M", "P", "L", "E"];
      var items = [];
      for (var i = 0; i < chars.length; i++) {
        var start = i * 0.11;
        var span = tStyle === "typewriter" ? 0.04 : 0.45;
        var cu = clamp((u - start) / span, 0, 1);
        var ce = evalCurve(style, cu);
        var cdx = 0, cdy = 0, cs = 1, cop = cu, blur = 0;
        // Travel direction of the unit; the unit starts on the opposite side (as in AE).
        var tdir = d.direction || (tStyle === "skewIn" ? "right" : (tStyle === "drop" ? "down" : ((tStyle === "riseBlur" || tStyle === "zoomIn") ? "down" : "up")));
        var vec = { up: [0, 1], down: [0, -1], left: [1, 0], right: [-1, 0] }[tdir] || [0, 1];
        if (tStyle === "rise") { cdx = vec[0] * 16 * (1 - ce); cdy = vec[1] * 16 * (1 - ce); cop = clamp(cu * 1.8, 0, 1); }
        else if (tStyle === "drop") { cdx = vec[0] * 16 * (1 - ce); cdy = vec[1] * 16 * (1 - ce); cop = clamp(cu * 1.8, 0, 1); }
        else if (tStyle === "pop") { cs = Math.max(0, ce); cop = clamp(cu * 2.4, 0, 1); }
        else if (tStyle === "blur") { blur = (1 - ce) * 5; cop = ce; }
        else if (tStyle === "typewriter") { cop = cu >= 0.5 ? 1 : 0; }
        // React Bits text effects distilled into the library.
        else if (tStyle === "skewIn") { cdx = vec[0] * 16 * (1 - ce); cop = clamp(cu * 1.8, 0, 1); }
        else if (tStyle === "riseBlur") { cdx = vec[0] * 14 * (1 - ce); cdy = vec[1] * 14 * (1 - ce); blur = (1 - ce) * 4; cop = clamp(cu * 1.8, 0, 1); }
        else if (tStyle === "wave") { cdx = vec[0] * 12 * (1 - ce); cdy = vec[1] * 12 * (1 - ce); cop = clamp(cu * 2, 0, 1); }
        else if (tStyle === "float") { cdy = vec[1] * 14 * (1 - ce); cdx = vec[0] * 14 * (1 - ce); cs = 1 + 0.06 * (1 - ce); cop = clamp(cu * 2, 0, 1); }
        else if (tStyle === "focus") { cs = 1 + 0.12 * (1 - ce); blur = (1 - ce) * 5; cop = ce; }
        else if (tStyle === "zoomIn") { cs = 1 + 0.4 * (1 - ce); cdy = vec[1] * 5 * (1 - ce); cdx = vec[0] * 5 * (1 - ce); blur = (1 - ce) * 5; cop = clamp(cu * 2.5, 0, 1); }
        items.push({ ch: chars[i], dx: cdx, dy: cdy, scale: cs, opacity: cop, blur: blur });
      }
      return { kind: "text", chars: items };
    }

    if (preset.command === "transition") {
      return {
        kind: "transition",
        transType: d.type || "wipe",
        direction: dir,
        duration: Number(d.duration) || 0.8,
        progress: u
      };
    }

    return { kind: "box", dx: 0, dy: 0, scaleX: 1, scaleY: 1, rotate: 0, opacity: 1 };
  }

  // Generate an SVG easing/motion sparkline path for card resting state
  function buildCurveSvg(item) {
    var pts = [];
    var samples = 24;
    if (item && item.clip) {
      var clip = item.clip;
      var meta = analyzeClip(clip, item.defaultAnchor);
      var dur = meta.duration;
      // Pick the primary scalar progression from first track
      var tr = clip.layers && clip.layers[0] && clip.layers[0].tracks && clip.layers[0].tracks[0];
      var raw = [];
      for (var i = 0; i <= samples; i++) {
        var t = (i / samples) * dur;
        var v = tr ? evalTrack(tr, t) : 0;
        var mag = typeof v === "number" ? v : (Array.isArray(v) ? Math.hypot(v[0] || 0, v[1] || 0) : 0);
        raw.push(mag);
      }
      var minV = Math.min.apply(null, raw), maxV = Math.max.apply(null, raw);
      var span = maxV - minV;
      if (span < 1e-4) span = 1;
      for (var j = 0; j <= samples; j++) {
        var x = (j / samples) * 60 + 2;
        var norm = (raw[j] - minV) / span;
        var y = 18 - norm * 14;
        pts.push((j === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1));
      }
    } else if (item && item.kind === "procedural") {
      var st = (item.defaults && (item.defaults.style || item.defaults.ease)) || "snappy";
      var outPhase = item.phase === "out";
      for (var k = 0; k <= samples; k++) {
        var u = k / samples;
        var ev = evalCurve(st, u);
        if (outPhase) ev = 1 - ev;
        var px = u * 60 + 2;
        var py = clamp(17 - ev * 12, 2, 18);
        pts.push((k === 0 ? "M" : "L") + px.toFixed(1) + "," + py.toFixed(1));
      }
    }
    return pts.join(" ");
  }

  return {
    analyzeClip: analyzeClip,
    evaluateClipAt: evaluateClipAt,
    evaluatePresetAt: evaluatePresetAt,
    evalCurve: evalCurve,
    buildCurveSvg: buildCurveSvg
  };
});
