/*
 * aeShapeBuilder.jsx — consumes the SVGParser model and builds NATIVE AE shape layers.
 * ExtendScript only (runs inside After Effects). Overlord-style: real editable shapes.
 *
 * Perf notes (why this is fast):
 *  - No per-layer moveToBeginning(): that was O(N^2) and the cause of multi-minute imports.
 *    Creating layers in forward model order already yields the correct SVG z-order
 *    (addShape inserts at the top, so the first shape ends up at the bottom = drawn first).
 *  - Property groups are looked up by matchName once and reused; no repeated name lookups.
 *
 * Usage:
 *   AEShapeBuilder.build(model, { comp: comp, oneLayer: false, name: "UI" });
 */

var AEShapeBuilder = (function () {

  // One native undo group per synchronous import. Internal builders may nest through this
  // helper, but must not open separate native groups inside the owning transaction.
  var _undoDepth = 0;
  function beginUndo(name) {
    if (_undoDepth === 0) app.beginUndoGroup(name);
    _undoDepth++;
  }
  function endUndo() {
    _undoDepth--;
    if (_undoDepth === 0) app.endUndoGroup();
  }
  function withUndo(name, action) {
    beginUndo(name);
    try { return action(); }
    finally { endUndo(); }
  }

  var _diag = [];   // gradient diagnostics for the status bar
  var _fontMiss = {}, _fontMissList = [];   // families we had to substitute (not installed)
  var _txtOk = 0, _txtNo = 0;               // text layers measured vs not (sourceRect health)
  var _imgSlots = [];                       // z-order placeholders left where pictures belong
  // Folder this script lives in (host/figma) — used to load bundled .ffx templates.
  var _MK_DIR = (function () {
    try { return File($.fileName).parent.fsName.replace(/\\/g, "/"); } catch (e) { return ""; }
  })();

  // Figma's soft line break is U+2028 (Shift+Enter); a hard one is \n. After Effects breaks
  // lines on \r only — anything else is drawn as a placeholder glyph (the little "SEP" box).
  function aeLines(str) {
    if (str == null) return str;
    return String(str)
      .replace(/\r\n/g, "\r")
      .replace(/[\n\u2028\u2029\u000B\u000C\u0085]/g, "\r");
  }

  function toShape(sub) {
    var sh = new Shape();
    sh.vertices = sub.verts;
    sh.inTangents = sub.inT;
    sh.outTangents = sub.outT;
    sh.closed = !!sub.closed;
    return sh;
  }

  // Build one shape group (paths + fill + stroke) inside `contents`.
  // deferFill=true: leave the fill out (a gradient .ffx preset will be applied to this layer).
  function addShapeGroup(contents, shapeData, groupName, deferFill) {
    var vGroup = contents.addProperty("ADBE Vector Group");
    vGroup.name = groupName || shapeData.name || "Shape";
    var gc = vGroup.property("ADBE Vectors Group");

    addGeom(gc, shapeData, false);      // parametric Rect/Ellipse when possible, else paths

    if (shapeData.gradient) {
      if (!deferFill) addGradientFill(gc, shapeData.gradient);   // manual path (no preset): native-or-solid
      // deferFill: no fill here; build() applies the gradient .ffx preset to the layer
    } else {
      var f = shapeData.fill;
      if (f) {
        var fill = gc.addProperty("ADBE Vector Graphic - Fill");
        fill.property("ADBE Vector Fill Color").setValue([f[0], f[1], f[2], 1]);
        if (shapeData.fillOpacity != null && shapeData.fillOpacity < 1)
          fill.property("ADBE Vector Fill Opacity").setValue(shapeData.fillOpacity * 100);
        try { if (shapeData.fillRule) fill.property("ADBE Vector Fill Rule").setValue(shapeData.fillRule); } catch (efr) {}  // evenodd holes
      }
    }

    // INSIDE / OUTSIDE stroke: offset the centreline. With no fill in the way the whole group can
    // share one offset path; with a fill present the stroke moves to a group of its own.
    var off = strokeOffsetAmount(shapeData);
    if (off && (shapeData.fill || shapeData.gradient || deferFill)) {
      addAlignedStrokeGroup(contents, shapeData, off, true);
    } else {
      if (off) addOffsetPaths(gc, off, shapeData);
      addStrokeTo(gc, shapeData);
    }
    return vGroup;
  }

  // Add a solid stroke (colour, width, opacity, cap/join/miter/dashes) to a contents group.
  function addStrokeTo(gc, sd) {
    var s = sd.stroke;
    if (!s || !(sd.strokeWidth > 0)) return null;
    var stroke = gc.addProperty("ADBE Vector Graphic - Stroke");
    stroke.property("ADBE Vector Stroke Color").setValue([s[0], s[1], s[2], 1]);
    stroke.property("ADBE Vector Stroke Width").setValue(sd.strokeWidth);
    if (sd.strokeOpacity != null && sd.strokeOpacity < 1)
      stroke.property("ADBE Vector Stroke Opacity").setValue(sd.strokeOpacity * 100);
    applyStrokeStyle(stroke, sd);
    return stroke;
  }

  // Apply cap / join / miter / dashes from the SVG stroke to an AE stroke property.
  function applyStrokeStyle(stroke, sd) {
    try { if (sd.strokeCap) stroke.property("ADBE Vector Stroke Line Cap").setValue(sd.strokeCap); } catch (ec) {}
    try { if (sd.strokeJoin) stroke.property("ADBE Vector Stroke Line Join").setValue(sd.strokeJoin); } catch (ej) {}
    try { if (sd.strokeMiter != null) stroke.property("ADBE Vector Stroke Miter Limit").setValue(sd.strokeMiter); } catch (em) {}
    if (sd.strokeDash && sd.strokeDash.length) {
      try {
        var dg = stroke.property("ADBE Vector Stroke Dashes");
        var names = ["ADBE Vector Stroke Dash 1", "ADBE Vector Stroke Gap 1", "ADBE Vector Stroke Dash 2", "ADBE Vector Stroke Gap 2", "ADBE Vector Stroke Dash 3", "ADBE Vector Stroke Gap 3"];
        for (var i = 0; i < sd.strokeDash.length && i < names.length; i++) {
          try { dg.addProperty(names[i]).setValue(sd.strokeDash[i]); } catch (ed) {}
        }
        if (sd.strokeDashOffset) { try { dg.addProperty("ADBE Vector Stroke Offset").setValue(sd.strokeDashOffset); } catch (eo) {} }
      } catch (edg) {}
    }
  }

  // ---- ORGANIZE: Figma containers -> nested AE precomps ----
  // Every layer records which Figma containers it sits in (outermost first). After the whole
  // scene is built, the deepest containers are collapsed first, so an outer group only ever sees
  // finished precomp layers. Effects then live on the precomp, which is the only way to match
  // Figma: it composites the group and blurs the RESULT, not each child separately.
  var _layerPaths = [];                 // { lyr, path:[containerId,...], z, matte, isMatte }
  // Rounded rectangle as an AE Shape, in whatever coordinate space the caller works in.
  // Used for the Clip content mask; r = 0 gives plain corners.
  function roundedRectShape(x, y, w, h, r) {
    var sh = new Shape();
    r = Math.max(0, Math.min(r || 0, Math.min(w, h) / 2));
    if (!r) {
      sh.vertices = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      sh.inTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
      sh.outTangents = [[0, 0], [0, 0], [0, 0], [0, 0]];
      sh.closed = true;
      return sh;
    }
    var k = 0.5522847498 * r;                 // circle-to-bezier constant
    sh.vertices = [
      [x + r, y], [x + w - r, y],
      [x + w, y + r], [x + w, y + h - r],
      [x + w - r, y + h], [x + r, y + h],
      [x, y + h - r], [x, y + r]
    ];
    sh.inTangents = [[-k, 0], [0, 0], [0, -k], [0, 0], [k, 0], [0, 0], [0, k], [0, 0]];
    sh.outTangents = [[0, 0], [k, 0], [0, 0], [0, k], [0, 0], [-k, 0], [0, 0], [0, -k]];
    sh.closed = true;
    return sh;
  }

  // Cropped pictures are a PAIR: the footage plus the shape that mattes it. That pair now moves
  // twice — once when the stack is rebuilt, once when it is swallowed by a precomp — and AE only
  // keeps a track matte while the matte sits directly above its footage in the SAME comp. So the
  // link is re-asserted at the very end instead of being trusted to survive.
  var _mattePairs = [];
  function relinkMattes() {
    var ok = 0, lost = 0;
    for (var i = 0; i < _mattePairs.length; i++) {
      var p = _mattePairs[i];
      try {
        if (!p.lyr || !p.mt) { lost++; continue; }
        // Do NOT compare containingComp with !==. ExtendScript may hand back a fresh wrapper
        // for the same CompItem, which falsely rejected every pair after precompose. The actual
        // move/setTrackMatte calls below are the authoritative same-comp check.
        p.mt.moveBefore(p.lyr);
        var matteKind = p.type || TrackMatteType.ALPHA;
        try { p.lyr.setTrackMatte(p.mt, matteKind); }
        catch (e1) { try { p.lyr.trackMatteType = matteKind; } catch (e2) {} }
        p.mt.enabled = false;
        ok++;
      } catch (e) { lost++; }
    }
    if (_mattePairs.length) _diag.push("mattes " + ok + "/" + _mattePairs.length + (lost ? " (" + lost + " lost)" : ""));
    return ok;
  }

  // Register a matte pair whose MATTE is a layer that was already tracked on its own — the
  // gradient text case, where the text layer mattes the gradient underneath it. The text stops
  // being moved on its own and travels with the gradient instead, exactly like a cropped photo.
  function pairMatte(contentLyr, matteLyr, path, z) {
    for (var i = 0; i < _layerPaths.length; i++) {
      if (_layerPaths[i].lyr === matteLyr) { _layerPaths[i].isMatte = true; break; }
    }
    trackLayer(contentLyr, path, z, matteLyr);
    _mattePairs.push({ lyr: contentLyr, mt: matteLyr });
  }

  var _trackSeq = 0;
  var _referenceLayers = [];
  function placeReferences(comp) {
    for (var i = _referenceLayers.length - 1; i >= 0; i--) {
      var layer = _referenceLayers[i];
      try { if (layer.containingComp === comp) { layer.moveToBeginning(); layer.enabled = false; } } catch (e) {}
    }
  }
  function trackLayer(lyr, path, z, matte, isMatte, external) {
    if (!lyr) return;
    _layerPaths.push({ lyr: lyr, path: path || [], z: (z == null ? 0 : z),
                       seq: _trackSeq++,          // tie-break: ExtendScript's sort is NOT stable
                       matte: matte || null, isMatte: !!isMatte, external: !!external });
  }

  // Put the comp back into Figma's paint order WITHOUT blindly moving every layer. The old
  // bottom-up moveToBeginning() pass touched N layers even when only the late text/image passes
  // were out of place. Keep a longest already-correct subsequence in place and insert only the
  // remaining layers next to an anchor. This is O(N log N) in ExtendScript and, more importantly,
  // avoids most of AE's expensive layer-stack mutations.
  function restackByZ() {
    var units = [], j, i;
    for (j = 0; j < _layerPaths.length; j++) {
      var r = _layerPaths[j];
      if (!r.lyr || r.isMatte) continue;              // a matte travels with its footage
      try { r.lyr.index; } catch (edead) { r.lyr = null; continue; }
      units.push(r);
    }
    // bottom of the stack first; equal paint index keeps the order the layers were built in
    units.sort(function (a, b) { return (a.z - b.z) || (a.seq - b.seq); });
    if (!units.length) return 0;
    var top = units.slice().reverse();                // AE index 1 is the TOP of the comp
    var current = units.slice();
    try { current.sort(function (a, b) { return a.lyr.index - b.lyr.index; }); }
    catch (esort) { return 0; }

    var already = (current.length === top.length);
    for (i = 0; already && i < top.length; i++) if (current[i].lyr !== top[i].lyr) already = false;
    if (already) {
      for (i = 0; i < top.length; i++) {
        if (top[i].matte) {
          try { if (top[i].matte.index !== top[i].lyr.index - 1) already = false; } catch (em0) {}
        }
      }
    }
    if (already) { _diag.push("stack already ordered (" + top.length + ")"); return 0; }

    // Rank each layer in the desired top-to-bottom order, then find the longest increasing
    // subsequence in the CURRENT order. Those layers never need to move.
    for (i = 0; i < top.length; i++) top[i]._mkRank = i;
    var tails = [], tailAt = [], before = [], keep = {};
    for (i = 0; i < current.length; i++) {
      var rank = current[i]._mkRank, lo = 0, hi = tails.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (tails[mid] < rank) lo = mid + 1; else hi = mid; }
      tails[lo] = rank; tailAt[lo] = i; before[i] = (lo > 0 ? tailAt[lo - 1] : -1);
    }
    var at = tailAt.length ? tailAt[tailAt.length - 1] : -1;
    while (at >= 0) { keep[at] = true; at = before[at]; }
    for (i = 0; i < current.length; i++) current[i]._mkKeep = !!keep[i];

    var anchor = null, moved = 0;
    for (i = 0; i < top.length; i++) {
      var u = top[i];
      if (!u._mkKeep) {
        try {
          if (anchor) u.lyr.moveAfter(anchor.lyr); else u.lyr.moveToBeginning();
          moved++;
        } catch (e) { _diag.push("restack:" + String(e).substr(0, 30)); }
      }
      // A matte must sit directly above its footage, including when the footage itself stayed.
      if (u.matte) {
        try { if (u.matte.index !== u.lyr.index - 1) u.matte.moveBefore(u.lyr); } catch (em) {}
      }
      anchor = u;
    }
    for (i = 0; i < units.length; i++) { units[i]._mkRank = null; units[i]._mkKeep = null; }
    _diag.push("stack: moved " + moved + "/" + top.length + ", kept " + keepCount(keep) + " in place");
    return units.length;
  }
  function keepCount(keep) { var n = 0, k; for (k in keep) if (keep[k]) n++; return n; }

  // Read the stack BACK out of AE and check it against the paint order that was asked for.
  // Walking down the timeline the paint index must never rise; anywhere it does, the two layers
  // that swapped are named. This is the only way to tell a wrong sort from a move AE refused.
  function verifyStack(comp) {
    var seen = [], j, k;
    for (j = 0; j < _layerPaths.length; j++) {
      var r = _layerPaths[j];
      if (!r.lyr || r.isMatte) continue;
      var idx, cc, nm;
      try { idx = r.lyr.index; cc = r.lyr.containingComp; nm = r.lyr.name; } catch (e) { continue; }
      if (cc !== comp) continue;                       // only this comp's own top level
      seen.push({ idx: idx, z: r.z, name: nm });
    }
    seen.sort(function (a, b) { return a.idx - b.idx; });   // index 1 = top of the stack
    var bad = [];
    for (k = 1; k < seen.length; k++) {
      if (seen[k].z > seen[k - 1].z) {
        bad.push(seen[k - 1].name + "#" + seen[k - 1].z + " OVER " + seen[k].name + "#" + seen[k].z);
      }
    }
    if (bad.length) _diag.push("ORDER BAD " + bad.length + "/" + seen.length + ": " + bad.slice(0, 4).join(" ; "));
    else _diag.push("order ok (" + seen.length + " top-level)");
    // the actual top-level stack, top first — reads straight against the Figma layer list
    var top = [];
    for (k = 0; k < seen.length && k < 16; k++) top.push(seen[k].name + "#" + seen[k].z);
    if (top.length) _diag.push("top>bottom: " + top.join(" | "));
    return bad.length;
  }

  // Recompute skew pivots from the FINAL tree, after every nested precomp has been positioned.
  // Incrementally adding dx/dy is fragile if organize runs again or a container is skipped:
  // the pivot then accumulates a second shift while Position does not. This pass is idempotent.
  function refreshTextSkewPivots(comp, seen) {
    if (!comp) return;
    seen = seen || {};
    var compKey = (comp.id != null ? comp.id : comp.name);
    if (seen[compKey]) return;
    seen[compKey] = 1;
    for (var i = 1; i <= comp.numLayers; i++) {
      var lyr = comp.layer(i);
      if (typeof TextLayer !== "undefined" && lyr instanceof TextLayer) {
        try {
          var fx = lyr.property("ADBE Effect Parade");
          var hasSkew = false;
          for (var j = 1; j <= fx.numProperties; j++)
            if (fx.property(j).matchName === "ADBE Geometry2" && fx.property(j).name === "Figma 斜体") hasSkew = true;
          if (hasSkew) {
            var r = measureRect(comp, lyr);
            if (r) {
              var tg = lyr.property("ADBE Transform Group");
              var pos = tg.property("ADBE Position").value, anc = tg.property("ADBE Anchor Point").value;
              var pivot = [pos[0] + r.left + r.width / 2 - anc[0], pos[1] + r.top + r.height / 2 - anc[1]];
              for (var k = 1; k <= fx.numProperties; k++) {
                var e = fx.property(k);
                if (e.matchName !== "ADBE Geometry2" || e.name !== "Figma 斜体") continue;
                e.property(1).setValue(pivot); e.property(2).setValue(pivot);
              }
            }
          }
        } catch (et) {}
      }
      try { if (lyr.source && (lyr.source instanceof CompItem)) refreshTextSkewPivots(lyr.source, seen); } catch (es) {}
    }
  }

  function organize(comp, containers) {
    if (!comp || !containers || !containers.length) { _diag.push("organize: no containers"); return 0; }
    if (!_layerPaths.length) { _diag.push("organize: no layer carried a group path"); return 0; }
    var made = 0, i, j, empty = 0, emptyNames = [], sizes = [];

    // Sort the whole comp BEFORE collapsing. precompose keeps the relative order of what it
    // swallows, so the stack inside every precomp is only correct if the comp was correct first
    // — otherwise text stayed piled on top inside each group.
    restackByZ();

    // A layer's path can name a container that never made it into the table (a group with no
    // measurable box is skipped, for one). Those ids match nothing, so the layer is orphaned at
    // the root instead of joining its group. Drop the unknown ones so it falls back to the
    // nearest ancestor that DOES exist, and say how many were dropped.
    var known = {}, dropped = 0;
    for (i = 0; i < containers.length; i++) known[containers[i].id] = 1;
    for (i = 0; i < _layerPaths.length; i++) {
      var pth = _layerPaths[i].path, keep = [];
      if (!pth || !pth.length) continue;
      for (j = 0; j < pth.length; j++) { if (known[pth[j]]) keep.push(pth[j]); else dropped++; }
      _layerPaths[i].path = keep;
    }
    if (dropped) _diag.push("orphan path refs dropped: " + dropped);

    // deepest first: a container is only collapsed once everything inside it already is
    var order = [];
    for (i = 0; i < containers.length; i++) order.push(containers[i]);
    order.sort(function (a, b) { return (b.path ? b.path.length : 0) - (a.path ? a.path.length : 0); });

    for (i = 0; i < order.length; i++) {
      var c = order[i];
      try {
        // every layer whose path still contains this container id
        var members = [], seen = {};
        var isRootContainer = (c.root === true);
        for (j = 0; j < _layerPaths.length; j++) {
          var rec = _layerPaths[j];
          if (!rec.lyr) continue;
          var hit = false;
          if (isRootContainer) {
            // The root is the final sweep: swallow every remaining imported layer, including
            // layers whose intermediate container was skipped (orphan path refs).
            hit = !rec.external;
          } else {
            for (var k = 0; k < rec.path.length; k++) if (rec.path[k] === c.id) { hit = true; break; }
          }
          if (!hit) continue;
          var idx;
          try { idx = rec.lyr.index; } catch (edead) { rec.lyr = null; continue; }   // already swallowed
          if (seen[idx]) continue;
          seen[idx] = 1; members.push(idx);
        }
        if (members.length < 1) { empty++; emptyNames.push(c.name || "?"); continue; }
        members.sort(function (a, b) { return a - b; });

        // Precompose invalidates the old layer wrappers. Rebind pairs to the new comp's
        // layers in the same stack order, including pairs nested by an outer mask scope.
        var memberSlots = {}, movingPairs = [];
        for (j = 0; j < members.length; j++) memberSlots[members[j]] = j + 1;
        for (j = 0; j < _mattePairs.length; j++) {
          var pair = _mattePairs[j];
          try {
            if (pair.lyr.containingComp.id !== comp.id || pair.mt.containingComp.id !== comp.id) continue;
            var layerSlot = memberSlots[pair.lyr.index], matteSlot = memberSlots[pair.mt.index];
            if (layerSlot && matteSlot) movingPairs.push({ pair: pair, layer: layerSlot, matte: matteSlot });
          } catch (epair) {}
        }
        var pc = comp.layers.precompose(members, c.name || "Group", true);
        for (j = 0; j < movingPairs.length; j++) {
          movingPairs[j].pair.lyr = pc.layer(movingPairs[j].layer);
          movingPairs[j].pair.mt = pc.layer(movingPairs[j].matte);
        }
        // Find the new layer by its SOURCE rather than assuming which index precompose used —
        // guessing the slot means the group's effects can land on a completely unrelated layer.
        var pcLayer = null;
        for (j = 1; j <= comp.numLayers; j++) {
          try { if (comp.layer(j).source === pc) { pcLayer = comp.layer(j); break; } } catch (efind) {}
        }
        if (!pcLayer) { _diag.push("precomp " + (c.name || "?") + ": layer not found"); continue; }

        var tg = pcLayer.property("ADBE Transform Group");
        // An unclipped Figma container can draw outside its own box. With collapse disabled,
        // include that content in the precomp and cancel the changed origin in the parent.
        var cb = !c.clip && c.cb ? c.cb : c;
        var left = Math.floor(Math.min(c.x, cb.x) + .000001), top = Math.floor(Math.min(c.y, cb.y) + .000001);
        var bounds = {x:left,y:top,w:Math.ceil(Math.max(c.x+c.w,cb.x+cb.w)-.000001)-left,
                      h:Math.ceil(Math.max(c.y+c.h,cb.y+cb.h)-.000001)-top};
        var W = Math.max(4, bounds.w), H = Math.max(4, bounds.h);
        var dx = -bounds.x, dy = -bounds.y;

        // Resizing a comp does not move its layers, so the contents are shifted first and the
        // precomp layer is then placed so every pixel lands back exactly where Figma had it.
        for (j = 1; j <= pc.numLayers; j++) {
          try {
            var pos = pc.layer(j).property("ADBE Transform Group").property("ADBE Position");
            var v = pos.value;
            pos.setValue([v[0] + dx, v[1] + dy, (v.length > 2 ? v[2] : 0)]);
          } catch (ep) {}
        }
        try { pc.width = W; pc.height = H; } catch (ers) {}

        // Center the anchor and cancel the content offset in the parent.
        try { tg.property("ADBE Anchor Point").setValue([W / 2, H / 2, 0]); } catch (ea2) {}
        try { tg.property("ADBE Position").setValue([W / 2 - dx, H / 2 - dy, 0]); } catch (ep3) {}

        // Rebuild Clip content in the original frame's local space, including rounded corners.
        if (c.clip) {
          try {
            var mk = pcLayer.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
            mk.name = "Clip content";
            mk.property("ADBE Mask Shape").setValue(roundedRectShape(c.x + dx, c.y + dy, c.w, c.h, c.r || 0));
            try { mk.maskMode = MaskMode.ADD; } catch (emm) {}
          } catch (emask) { _diag.push("clip " + (c.name || "?") + ":" + String(emask).substr(0, 30)); }
        }

        // the group's own look now belongs to the precomp layer
        if (c.opacity != null && c.opacity < 1) { try { tg.property("ADBE Opacity").setValue(c.opacity * 100); } catch (eo) {} }
        if (c.blur) addBlur(pcLayer, c.blur);
        if (c.fx && c.fx.length) { try { addLayerEffects(pcLayer, c.fx); } catch (efx) {} }
        applyBlend(pcLayer, c.blend);
        if (c.hidden) { try { pcLayer.enabled = false; } catch (eh) {} }
        try { pcLayer.collapseTransformation = c.collapseForBlends === true; } catch (ect) {}

        // the swallowed layers are gone; this precomp now stands in for them one level up
        for (j = 0; j < _layerPaths.length; j++) {
          var r2 = _layerPaths[j];
          if (!r2.lyr) continue;
          var inside = false;
          for (var k2 = 0; k2 < r2.path.length; k2++) if (r2.path[k2] === c.id) { inside = true; break; }
          if (inside) r2.lyr = null;
        }
        var containerMatte = applyNodeMask(pcLayer, c);
        trackLayer(pcLayer, c.path || [], c.z, containerMatte);
        if (containerMatte) trackLayer(containerMatte, c.path || [], c.z, null, true);
        sizes.push((c.name || "?") + "(" + members.length + ")");
        made++;
      } catch (e) { _diag.push("precomp " + (c.name || "?") + ":" + String(e).substr(0, 40)); }
    }
    // An empty group means its layers never carried the path — that is a wiring bug, not a
    // design with empty groups, so it has to show up in the status line.
    if (empty) _diag.push("EMPTY GROUPS " + empty + "/" + order.length + ": " + emptyNames.slice(0, 6).join(", "));
    // how many layers each group actually swallowed — a group that should hold a row of a list
    // and reports (1) or (0) is the one whose children never carried its id
    if (sizes.length) _diag.push("swallowed: " + sizes.slice(0, 14).join(" "));
    restackByZ();          // groups back into Figma's order, text back under what covers it
    relinkMattes();        // cropped pictures survived two moves — put their mattes back
    refreshTextSkewPivots(comp); // final comp-space pivots; safe across nesting and repeated runs
    verifyStack(comp);     // and prove the stack really came out the way it was asked for
    placeReferences(comp);
    return made;
  }

  // ---- blend modes ----
  // Figma's names map almost one-to-one onto AE's BlendingMode enum. PASS_THROUGH only means
  // anything on a group (the group doesn't composite separately), which is Normal for a layer.
  // Anything AE lacks stays Normal rather than guessing a lookalike and shifting the colour.
  var BLEND_MAP = null;
  function blendOf(name) {
    if (!name || name === 'NORMAL' || name === 'PASS_THROUGH') return null;
    if (!BLEND_MAP) {
      BLEND_MAP = {};
      var pairs = [
        ['DARKEN', 'DARKEN'], ['MULTIPLY', 'MULTIPLY'], ['LINEAR_BURN', 'LINEAR_BURN'],
        ['COLOR_BURN', 'COLOR_BURN'], ['LIGHTEN', 'LIGHTEN'], ['SCREEN', 'SCREEN'],
        // Figma exports LINEAR_DODGE as plus-lighter: add premultiplied colours, including
        // translucent glows. AE Linear Dodge clips before alpha; Add preserves this glow.
        ['LINEAR_DODGE', 'ADD'], ['COLOR_DODGE', 'COLOR_DODGE'],
        ['OVERLAY', 'OVERLAY'], ['SOFT_LIGHT', 'SOFT_LIGHT'], ['HARD_LIGHT', 'HARD_LIGHT'],
        ['DIFFERENCE', 'DIFFERENCE'], ['EXCLUSION', 'EXCLUSION'],
        ['HUE', 'HUE'], ['SATURATION', 'SATURATION'], ['COLOR', 'COLOR'], ['LUMINOSITY', 'LUMINOSITY']
      ];
      for (var i = 0; i < pairs.length; i++) {
        try { if (BlendingMode[pairs[i][1]] != null) BLEND_MAP[pairs[i][0]] = BlendingMode[pairs[i][1]]; } catch (e) {}
      }
    }
    return (BLEND_MAP[name] != null) ? BLEND_MAP[name] : null;
  }
  function applyBlend(lyr, name) {
    var m = blendOf(name);
    if (m == null) return;
    try { lyr.blendingMode = m; } catch (e) { _diag.push("blend:" + name); }
  }

  // ---- stroke alignment (Figma INSIDE / OUTSIDE vs AE's always-centred stroke) ----
  // Figma hangs an INSIDE stroke entirely inside the path and an OUTSIDE one entirely outside it.
  // AE straddles the path, so a 24px INSIDE ring came in 12px too wide on the outside and 12px
  // too narrow on the inside — that is the ring that visibly missed its arc. The fix is to move
  // the CENTRELINE by half the width with an Offset Paths operator and keep a real, editable
  // stroke (baking strokeGeometry instead would kill Trim Paths on progress rings).
  function strokeOffsetAmount(sd) {
    if (!sd) return 0;
    var a = sd.strokeAlign;
    if (!a || a === 'CENTER') return 0;
    if (!sd.stroke && !sd.strokeGradient) return 0;      // nothing to draw -> never touch the fill
    var w = Number(sd.strokeWidth) || 0;
    if (!(w > 0)) return 0;
    return (a === 'INSIDE') ? -w / 2 : w / 2;
  }

  // Insert Offset Paths into a contents group. A path operator only affects the paths ABOVE it,
  // so `aboveMatch` lets callers slide it in just under the geometry and over the paint.
  function addOffsetPaths(gc, amount, sd, aboveMatch) {
    if (!amount) return null;
    try {
      var op = gc.addProperty("ADBE Vector Filter - Offset");
      var amt = null;
      try { amt = op.property("ADBE Vector Offset Amount"); } catch (e1) {}
      if (!amt) { try { amt = op.property(1); } catch (e2) {} }
      if (!amt) { _diag.push("offset: no amount"); try { op.remove(); } catch (e3) {} return null; }
      amt.setValue(amount);
      try { if (sd && sd.strokeJoin) op.property("ADBE Vector Offset Line Join").setValue(sd.strokeJoin); } catch (e4) {}
      try { if (sd && sd.strokeMiter != null) op.property("ADBE Vector Offset Miter Limit").setValue(sd.strokeMiter); } catch (e5) {}
      if (aboveMatch) {
        for (var i = 1; i <= gc.numProperties; i++) {
          if (gc.property(i).matchName === aboveMatch) { try { op.moveTo(i); } catch (e6) {} break; }
        }
      }
      return op;
    } catch (e) { _diag.push("offset:" + String(e).substr(0, 30)); return null; }
  }

  // A shape that carries BOTH a fill and an offset stroke cannot share one path: shifting it
  // would shrink the fill too. The stroke gets its own group with its own copy of the geometry.
  function addAlignedStrokeGroup(contents, sdata, amount, toFront) {
    var g = contents.addProperty("ADBE Vector Group");
    g.name = "Stroke";
    var gc = g.property("ADBE Vectors Group");
    addGeom(gc, sdata, false);
    addOffsetPaths(gc, amount, sdata);
    addStrokeTo(gc, sdata);
    if (toFront) { try { g.moveTo(1); } catch (e) {} }   // Figma paints strokes over fills
    return g;
  }

  // Most opaque stop -> the solid green used as the area's base colour.
  function repStop(stops) {
    var b = stops[0];
    for (var i = 1; i < stops.length; i++) if ((stops[i].opacity == null ? 1 : stops[i].opacity) > (b.opacity == null ? 1 : b.opacity)) b = stops[i];
    return { color: b.color, opacity: (b.opacity == null ? 1 : b.opacity) };
  }

  // Real shape Gradient Fill via "ADBE Vector Grad Colors".
  // The colour array's SCALE differs by AE version (colours 0..1 or 0..255; alpha 0..1 or 0..100),
  // so we read the default array, detect the scale from it, and write our stops in that scale.
  // This is what made earlier attempts go black/white (setValue ignored) or vanish (alpha 0.35
  // read as ~0 on a 0..100 build). Read-modify-write preserves the exact native structure.
  function addGradientFill(gc, g) {
    var gf = null;
    try {
      gf = gc.addProperty("ADBE Vector Graphic - G-Fill");
      gf.property("ADBE Vector Grad Type").setValue(g.type === 'radial' ? 2 : 1);
      gf.property("ADBE Vector Grad Start Pt").setValue([g.start[0], g.start[1]]);
      gf.property("ADBE Vector Grad End Pt").setValue([g.end[0], g.end[1]]);

      var cp = gf.property("ADBE Vector Grad Colors");
      var v = cp.value;                       // native default: 2 colour stops + 2 alpha stops
      var stops = g.stops, s0 = stops[0], s1 = stops[stops.length - 1];
      var a0 = (s0.opacity == null ? 1 : s0.opacity), a1 = (s1.opacity == null ? 1 : s1.opacity);

      if (v && v.length === 12) {
        var colorScale = (v[5] > 2) ? 255 : 1;    // white stop reads 1 or 255
        var alphaScale = (v[9] > 2) ? 100 : 1;    // full-alpha stop reads 1 or 100
        v[0] = s0.offset; v[1] = s0.color[0] * colorScale; v[2] = s0.color[1] * colorScale; v[3] = s0.color[2] * colorScale;
        v[4] = s1.offset; v[5] = s1.color[0] * colorScale; v[6] = s1.color[1] * colorScale; v[7] = s1.color[2] * colorScale;
        v[8] = s0.offset; v[9] = a0 * alphaScale;
        v[10] = s1.offset; v[11] = a1 * alphaScale;
        cp.setValue(v);
      } else {
        // unfamiliar structure: build a plain 0..1 layout as a best effort
        var arr = [], i, s;
        for (i = 0; i < stops.length; i++) { s = stops[i]; arr.push(s.offset, s.color[0], s.color[1], s.color[2]); }
        for (i = 0; i < stops.length; i++) { s = stops[i]; arr.push(s.offset, (s.opacity == null ? 1 : s.opacity)); }
        cp.setValue(arr);
      }
    } catch (e) {
      if (gf) { try { gf.remove(); } catch (e2) {} }
      var r = repStop(g.stops);               // solid fallback only if the whole thing errors
      var fill = gc.addProperty("ADBE Vector Graphic - Fill");
      fill.property("ADBE Vector Fill Color").setValue([r.color[0], r.color[1], r.color[2], 1]);
      if (r.opacity < 1) fill.property("ADBE Vector Fill Opacity").setValue(r.opacity * 100);
    }
  }

  // Find the first property with a given matchName anywhere in a shape layer's contents.
  function findProp(group, matchName) {
    for (var i = 1; i <= group.numProperties; i++) {
      var p = group.property(i);
      if (p.matchName === matchName) return p;
      if (p.numProperties && p.numProperties > 0) { var r = findProp(p, matchName); if (r) return r; }
    }
    return null;
  }
  // applyPreset applies to every selected layer. Newly created layers can leave other
  // selections behind, so clear the small selectedLayers set, not the whole composition.
  function selectForPreset(comp, lyr) {
    var selected = comp.selectedLayers;
    for (var i = 0; i < selected.length; i++) if (selected[i] !== lyr) selected[i].selected = false;
    lyr.selected = true;
  }

  // Apply a generated gradient .ffx to an EMPTY shape layer (preset brings a group with the
  // Gradient Fill), then INJECT the real Figma path into that SAME group so the fill paints it,
  // and set the gradient axis. Path + fill in one group is what makes it render.
  // Build the geometry: a real parametric Rectangle/Ellipse when the SVG element was a
  // <rect>/<circle>/<ellipse> (editable Size/Position/Roundness in AE, like Figma), else paths.
  function addGeom(contents, sdata, toFront) {
    var p = sdata.prim;
    if (p) {
      try {
        if (p.k === 'rect') {
          var rc = contents.addProperty("ADBE Vector Shape - Rect");
          rc.property("ADBE Vector Rect Size").setValue([p.w, p.h]);
          rc.property("ADBE Vector Rect Position").setValue([p.cx, p.cy]);
          if (p.r) rc.property("ADBE Vector Rect Roundness").setValue(p.r);
          if (toFront) { try { rc.moveTo(1); } catch (e1) {} }
          return true;
        }
        if (p.k === 'ellipse') {
          var el = contents.addProperty("ADBE Vector Shape - Ellipse");
          el.property("ADBE Vector Ellipse Size").setValue([p.rx * 2, p.ry * 2]);
          el.property("ADBE Vector Ellipse Position").setValue([p.cx, p.cy]);
          if (toFront) { try { el.moveTo(1); } catch (e2) {} }
          return true;
        }
      } catch (ep) { _diag.push("prim:" + ep); }   // fall through to paths
    }
    for (var i = 0; i < sdata.subpaths.length; i++) {
      try {
        var pp = contents.addProperty("ADBE Vector Shape - Group");
        pp.property("ADBE Vector Shape").setValue(toShape(sdata.subpaths[i]));
        if (toFront) { try { pp.moveTo(1); } catch (em) {} }
      } catch (epath) { _diag.push("path" + i + ":" + epath); }
    }
    return false;
  }
  // inject Figma geometry into a preset group's contents (must sit above the gradient fill)
  function injectPaths(contents, sdata) { addGeom(contents, sdata, true); }
  function setGradAxis(gp, g) {
    try { gp.property("ADBE Vector Grad Type").setValue(g.type === 'radial' ? 2 : 1); } catch (e0) {}
    try { gp.property("ADBE Vector Grad Start Pt").setValue([Number(g.start[0]), Number(g.start[1])]); } catch (e1) {}
    try { gp.property("ADBE Vector Grad End Pt").setValue([Number(g.end[0]), Number(g.end[1])]); } catch (e2) {}
  }

  // GRADIENT FILL: preset carries a G-Fill; we set axis/opacity, inject the path, and
  // (optionally) add a solid stroke into the same group.
  function applyFillGradient(comp, lyr, sdata, ffxPath, includeSolidStroke) {
    try {
      var g = sdata.gradient, f = new File(File.encode(ffxPath));
      if (!f.exists) { _diag.push("no fill ffx"); return false; }
      selectForPreset(comp, lyr);
      try { lyr.applyPreset(f); } catch (ea) { _diag.push("fillApply:" + ea); return false; }
      var root = lyr.property("ADBE Root Vectors Group");
      var gfill = findProp(root, "ADBE Vector Graphic - G-Fill");
      if (!gfill) { _diag.push("no gfill"); return false; }
      var contents = gfill.parentProperty;
      setGradAxis(gfill, g);
      // Take it from the gradient descriptor (SVG mode) or the shape (node mode) — whichever has it.
      var gOp = (g.fillOpacity != null) ? g.fillOpacity : sdata.fillOpacity;
      try { if (gOp != null && gOp < 1) gfill.property("ADBE Vector Fill Opacity").setValue(gOp * 100); } catch (eo) {}
      try { if (sdata.fillRule) gfill.property("ADBE Vector Fill Rule").setValue(sdata.fillRule); } catch (efr) {}
      injectPaths(contents, sdata);
      if (includeSolidStroke) {
        try {
          // An offset stroke must not drag the gradient fill's path with it -> own group.
          var offF = strokeOffsetAmount(sdata);
          if (offF) addAlignedStrokeGroup(root, sdata, offF, true);
          else addStrokeTo(contents, sdata);
        } catch (es) {}
      }
      return true;
    } catch (ETOP) { _diag.push("fillTOP:" + ETOP.toString() + " @" + ETOP.line); return false; }
  }

  // GRADIENT STROKE: preset carries a G-Stroke; we set axis + width + cap/join/dashes,
  // inject the path, and (optionally) add a solid fill into the same group.
  function applyStrokeGradient(comp, lyr, sdata, ffxPath, includeSolidFill) {
    try {
      var g = sdata.strokeGradient, f = new File(File.encode(ffxPath));
      if (!f.exists) { _diag.push("no stroke ffx"); return false; }
      selectForPreset(comp, lyr);
      try { lyr.applyPreset(f); } catch (ea) { _diag.push("strokeApply:" + ea); return false; }
      var root = lyr.property("ADBE Root Vectors Group");
      var gstroke = findProp(root, "ADBE Vector Graphic - G-Stroke");
      if (!gstroke) { _diag.push("no gstroke"); return false; }
      var contents = gstroke.parentProperty;
      setGradAxis(gstroke, g);
      // same zero-is-falsy trap as the solid stroke: weight 0 must stay 0
      try { gstroke.property("ADBE Vector Stroke Width").setValue(sdata.strokeWidth == null ? 1 : sdata.strokeWidth); } catch (ew) {}
      try { if (sdata.strokeOpacity != null && sdata.strokeOpacity < 1) gstroke.property("ADBE Vector Stroke Opacity").setValue(sdata.strokeOpacity * 100); } catch (eop) {}
      try { applyStrokeStyle(gstroke, sdata); } catch (ess) {}     // cap/join/miter/dashes
      injectPaths(contents, sdata);
      // INSIDE / OUTSIDE gradient stroke: slide Offset Paths between the injected geometry and
      // the G-Stroke so only the stroke's centreline moves.
      var offS = strokeOffsetAmount(sdata);
      if (offS) addOffsetPaths(contents, offS, sdata, "ADBE Vector Graphic - G-Stroke");
      if (includeSolidFill && sdata.fill) {
        try {
          if (offS) {
            // The offset would shrink a fill sharing this path, so the fill gets its own group
            // (left at the end of the list = rendered first = behind the stroke, as in Figma).
            var fg = root.addProperty("ADBE Vector Group");
            fg.name = "Fill";
            var fgc = fg.property("ADBE Vectors Group");
            addGeom(fgc, sdata, false);
            var fl2 = fgc.addProperty("ADBE Vector Graphic - Fill");
            fl2.property("ADBE Vector Fill Color").setValue([sdata.fill[0], sdata.fill[1], sdata.fill[2], 1]);
            if (sdata.fillOpacity != null && sdata.fillOpacity < 1) fl2.property("ADBE Vector Fill Opacity").setValue(sdata.fillOpacity * 100);
            try { if (sdata.fillRule) fl2.property("ADBE Vector Fill Rule").setValue(sdata.fillRule); } catch (efr2) {}
          } else {
            var fl = contents.addProperty("ADBE Vector Graphic - Fill");
            fl.property("ADBE Vector Fill Color").setValue([sdata.fill[0], sdata.fill[1], sdata.fill[2], 1]);
            if (sdata.fillOpacity != null && sdata.fillOpacity < 1) fl.property("ADBE Vector Fill Opacity").setValue(sdata.fillOpacity * 100);
          }
        } catch (ef) {}
      }
      return true;
    } catch (ETOP) { _diag.push("strokeTOP:" + ETOP.toString() + " @" + ETOP.line); return false; }
  }

  // Blur straight from the SVG (see svgParser): the file says exactly which elements sit
  // inside a blur filter, so no bounding-box guessing is involved any more.
  function addBlur(lyr, blurriness) {
    if (!blurriness) return;
    try {
      var gb = lyr.property("ADBE Effect Parade").addProperty("ADBE Gaussian Blur 2");
      gb.property("ADBE Gaussian Blur 2-0001").setValue(blurriness);
      try { gb.property("ADBE Gaussian Blur 2-0003").setValue(0); } catch (e1) {}   // Repeat Edge Pixels OFF
    } catch (e) { _diag.push("blur:" + String(e).substr(0, 30)); }
  }

  // ---- extra paints (Figma allows several fills/strokes per layer) ----
  // Each extra paint becomes its own vector group INSIDE the same layer, carrying a copy of the
  // geometry. Visually identical to Figma's stacked paints, but still one layer in the timeline.
  function addExtraSolidPaint(contents, sdata, ep, underAt) {
    var g = contents.addProperty("ADBE Vector Group");
    g.name = ep.kind === 'stroke' ? "Stroke" : "Fill";
    // In AE the FIRST item of Contents renders last (on top). Extras arrive BOTTOM-first, so
    // every `under` paint is slotted at the same index right below the main paint: each new one
    // pushes the previous down and the stack ends up in Figma's order. Leaving them appended at
    // the end reversed the stack — the bottom-most fill (a flat D9D9D9) covered the gradients.
    // Moving an indexed property invalidates its old reference in AE. Reacquire the group
    // before adding geometry; otherwise multi-fill shapes are removed as failed layers.
    try {
      var at = ep.under ? (underAt || 2) : 1;
      g.moveTo(at);
      g = contents.property(at);
    } catch (emv) {}
    var gc = g.property("ADBE Vectors Group");
    addGeom(gc, ep.subpaths ? {subpaths:ep.subpaths,prim:null} : sdata, false);
    if (ep.kind === 'stroke') {
      if (!ep.color) return;
      // this group holds nothing but the geometry and this one stroke, so the offset is safe here
      addOffsetPaths(gc, strokeOffsetAmount({ strokeAlign: ep.align, stroke: ep.color, strokeWidth: ep.width }),
                     { strokeJoin: ep.join, strokeMiter: ep.miter });
      var st = gc.addProperty("ADBE Vector Graphic - Stroke");
      st.property("ADBE Vector Stroke Color").setValue([ep.color[0], ep.color[1], ep.color[2], 1]);
      st.property("ADBE Vector Stroke Width").setValue(ep.width == null ? 1 : ep.width);
      if (ep.opacity != null && ep.opacity < 1) st.property("ADBE Vector Stroke Opacity").setValue(ep.opacity * 100);
      applyStrokeStyle(st, { strokeCap: ep.cap, strokeJoin: ep.join, strokeMiter: ep.miter, strokeDash: ep.dash, strokeDashOffset: ep.dashOffset });
    } else {
      if (!ep.color) return;
      var fl = gc.addProperty("ADBE Vector Graphic - Fill");
      fl.property("ADBE Vector Fill Color").setValue([ep.color[0], ep.color[1], ep.color[2], 1]);
      if (ep.opacity != null && ep.opacity < 1) fl.property("ADBE Vector Fill Opacity").setValue(ep.opacity * 100);
      try { if (ep.fillRule) fl.property("ADBE Vector Fill Rule").setValue(ep.fillRule); } catch (e) {}
    }
  }

  // A gradient extra needs its own .ffx: applying the preset again adds a fresh group holding
  // the gradient, and the geometry is injected into that very group so it has something to paint.
  function addExtraGradientPaint(comp, lyr, sdata, ep, ffxPath, underAt) {
    try {
      var f = new File(File.encode(ffxPath));
      if (!f.exists) { _diag.push("no extra ffx"); return false; }
      selectForPreset(comp, lyr);
      lyr.applyPreset(f);

      var root = lyr.property("ADBE Root Vectors Group");
      var want = (ep.kind === 'stroke') ? "ADBE Vector Graphic - G-Stroke" : "ADBE Vector Graphic - G-Fill";
      // The preset's group is the one that has the paint but no geometry yet.
      var target = null;
      for (var i = 1; i <= root.numProperties; i++) {
        var grp = root.property(i);
        if (!grp || grp.matchName !== "ADBE Vector Group") continue;
        var gc = grp.property("ADBE Vectors Group"), paint = null, hasGeom = false;
        for (var k = 1; k <= gc.numProperties; k++) {
          var mn = gc.property(k).matchName;
          if (mn === want) paint = gc.property(k);
          if (mn === "ADBE Vector Shape - Group" || mn === "ADBE Vector Shape - Rect" || mn === "ADBE Vector Shape - Ellipse") hasGeom = true;
        }
        if (paint && !hasGeom) { target = { grp: grp, gc: gc, paint: paint }; break; }
      }
      if (!target) { _diag.push("extra grad: group not found"); return false; }

      setGradAxis(target.paint, ep.gradient);
      if (ep.kind === 'stroke') {
        try { target.paint.property("ADBE Vector Stroke Width").setValue(ep.width == null ? 1 : ep.width); } catch (e1) {}
        try { if (ep.opacity != null && ep.opacity < 1) target.paint.property("ADBE Vector Stroke Opacity").setValue(ep.opacity * 100); } catch (e2) {}
        try { applyStrokeStyle(target.paint, { strokeCap: ep.cap, strokeJoin: ep.join, strokeMiter: ep.miter, strokeDash: ep.dash, strokeDashOffset: ep.dashOffset }); } catch (e3) {}
      } else {
        try { if (ep.opacity != null && ep.opacity < 1) target.paint.property("ADBE Vector Fill Opacity").setValue(ep.opacity * 100); } catch (e4) {}
        if (ep.fillRule) target.paint.property("ADBE Vector Fill Rule").setValue(ep.fillRule);
      }
      addGeom(target.gc, ep.subpaths ? {subpaths:ep.subpaths,prim:null} : sdata, true);
      if (ep.kind === 'stroke') {
        addOffsetPaths(target.gc,
                       strokeOffsetAmount({ strokeAlign: ep.align, strokeGradient: ep.gradient, strokeWidth: ep.width }),
                       { strokeJoin: ep.join, strokeMiter: ep.miter }, "ADBE Vector Graphic - G-Stroke");
      }
      // applyPreset drops its group wherever it likes, so the position is always set explicitly —
      // an `under` paint left at AE's chosen index landed ON TOP and hid the real gradient.
      try { target.grp.moveTo(ep.under ? (underAt || 2) : 1); } catch (emv2) {}
      return true;
    } catch (e) { _diag.push("extraGrad:" + String(e).substr(0, 40)); return false; }
  }

  // bounding box of subpaths (comp coords)
  function bboxOfSubs(subs) {
    var minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (var i = 0; i < subs.length; i++) {
      var v = subs[i].verts;
      for (var j = 0; j < v.length; j++) {
        if (v[j][0] < minx) minx = v[j][0]; if (v[j][1] < miny) miny = v[j][1];
        if (v[j][0] > maxx) maxx = v[j][0]; if (v[j][1] > maxy) maxy = v[j][1];
      }
    }
    return { x: minx, y: miny, w: maxx - minx, h: maxy - miny, cx: (minx + maxx) / 2, cy: (miny + maxy) / 2 };
  }
  // gradient Start/End that span the shape's bbox along the (start->end) direction
  function gradientSpan(subs, gStart, gEnd) {
    var bb = bboxOfSubs(subs);
    var dx = gEnd[0] - gStart[0], dy = gEnd[1] - gStart[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-3) { dx = 0; dy = 1; len = 1; }         // default: vertical
    var ux = dx / len, uy = dy / len;
    var corners = [[bb.x, bb.y], [bb.x + bb.w, bb.y], [bb.x, bb.y + bb.h], [bb.x + bb.w, bb.y + bb.h]];
    var minT = 1e9, maxT = -1e9;
    for (var i = 0; i < 4; i++) {
      var t = (corners[i][0] - bb.cx) * ux + (corners[i][1] - bb.cy) * uy;
      if (t < minT) minT = t; if (t > maxT) maxT = t;
    }
    return {
      start: [bb.cx + ux * minT, bb.cy + uy * minT],
      end: [bb.cx + ux * maxT, bb.cy + uy * maxT]
    };
  }

  // ---- Figma layer effects -> AE layer effects (matched to a layer by bbox) ----
  // Figma Inner Shadow -> AE Inner Shadow LAYER STYLE (no shape effect exists for this).
  // Angle mapping: layer-style shadow offset (screen, y-down) = (-d*cos A, -d*sin A).
  // We want that to equal Figma (dx,dy) -> A = atan2(dy,dx)+180, d = hypot(dx,dy).
  function addInnerShadowStyle(lyr, e) {
    try {
      var styles = lyr.property("ADBE Layer Styles");
      if (!styles) { _diag.push("IS: no styles group"); return false; }
      // Layer styles can NOT be added via addProperty (AE scripting limitation — the group
      // always reports placeholder styles and refuses adds). The reliable path is the MENU
      // COMMAND Layer > Layer Styles > Inner Shadow, which adds AND enables the style for
      // the selected layer; its properties are scriptable afterwards.
      // Per the AE scripting guide, layer-style properties use "innerShadow/..." match names
      // (NOT "ADBE Inner Shadow-000N"), and each style carries its own "enabled" property.
      // So the style is switched on by setting innerShadow/enabled — no addProperty, no menu.
      function findIS(grp) {
        var f = null;
        try { f = grp.property("ADBE Inner Shadow"); } catch (ea) {}
        if (f) return f;
        try {
          for (var k = 1; k <= grp.numProperties; k++) {
            var pr = grp.property(k);
            if (String(pr.matchName).toLowerCase().indexOf("innershadow") !== -1 ||
                String(pr.name).toLowerCase().indexOf("inner shadow") !== -1) return pr;
          }
        } catch (eb) {}
        return null;
      }

      // The Layer Styles group ALWAYS exposes innerShadow/enabled with its 9 children, even
      // when the style was never added — `enabled` reads true on that inert template, and AE
      // refuses setValue on it ("Can not set value"). addProperty is refused, and
      // findMenuCommandId("Inner Shadow") returns 0 from a script. What DOES work is the same
      // trick used for gradients: apply an .ffx preset that already carries an enabled
      // Inner Shadow; afterwards the parameters are fully scriptable.
      try {
        var tpl = new File(File.encode(_MK_DIR + "/innershadow-template.ffx"));
        if (!tpl.exists) { _diag.push("IS: template missing @" + _MK_DIR); return false; }
        selectForPreset(lyr.containingComp, lyr);
        lyr.applyPreset(tpl);
      } catch (ea) { _diag.push("IS preset:" + String(ea).substr(0, 45)); return false; }
      styles = lyr.property("ADBE Layer Styles");     // applyPreset invalidates the old ref
      var is = findIS(styles);
      if (!is) {
        var dump = "";
        try { for (var q = 1; q <= Math.min(styles.numProperties, 13); q++) dump += styles.property(q).matchName + "|"; } catch (ed) {}
        _diag.push("IS missing n=" + styles.numProperties + " [" + dump + "]");
        return false;
      }

      var dx = e.dx || 0, dy = e.dy || 0;
      var d = Math.sqrt(dx * dx + dy * dy);
      // Layer-style angle A is the LIGHT direction; shadow offset (screen, y-down) is
      // (-d*cosA, d*sinA). Solving for Figma's (dx,dy): A = atan2(dy, -dx).
      var A = Math.atan2(dy, -dx) * 180 / Math.PI; if (A < 0) A += 360;
      var size = e.blur || 0;
      var choke = (size > 0) ? Math.min(100, (e.spread || 0) / size * 100) : 0;

      var nSet = 0, nFail = "", firstErr = "";
      function set(mn, nameRe, val) {
        try { is.property(mn).setValue(val); nSet++; return; }
        catch (ep) { if (!firstErr) firstErr = mn + "->" + String(ep).substr(0, 70); }
        try {                                    // fallback: locate the property by display name
          for (var q = 1; q <= is.numProperties; q++) {
            var pp = is.property(q);
            if (nameRe.test(String(pp.name))) { pp.setValue(val); nSet++; return; }
          }
        } catch (eq) { if (firstErr.indexOf("||") === -1) firstErr += " || byName:" + String(eq).substr(0, 50); }
        nFail += mn.replace("innerShadow/", "") + " ";
      }
      try { is.enabled = true; } catch (een) {}   // innerShadow/enabled IS this group's own flag

      // AE inherits Photoshop's default of MULTIPLY for this style, while Figma draws inner
      // shadows in NORMAL — on a dark surface multiply simply swallows them. Normal is the
      // first entry of the blend menu, so 1 selects it.
      try {
        var bm = is.property("innerShadow/mode2");
        if (bm && bm.value !== 1) bm.setValue(1);
      } catch (ebm) { _diag.push("IS mode:" + String(ebm).substr(0, 30)); }

      set("innerShadow/color", /colou?r/i, [e.color[0], e.color[1], e.color[2], 1]);
      set("innerShadow/opacity", /opacity/i, (e.alpha != null ? e.alpha : 1) * 100);
      set("innerShadow/useGlobalAngle", /global/i, false);
      set("innerShadow/localLightingAngle", /angle/i, A);
      set("innerShadow/distance", /distance/i, d);
      set("innerShadow/chokeMatte", /choke|spread/i, choke);
      set("innerShadow/blur", /size/i, size);
      _diag.push("IS " + nSet + "/7" + (firstErr ? " ERR " + firstErr : ""));
      return true;
    } catch (ex) { _diag.push("IS err:" + ex.toString()); return false; }
  }

  // AE allows exactly ONE Inner Shadow layer style per layer, so a Figma layer with
  // several inner shadows used to keep only the last one (each call re-set the same
  // style). Shadows 2..N now ride on style-carrier duplicates: a copy of the layer
  // whose Fill Opacity is 0, so only its Inner Shadow style renders, overlaid in place.
  function addInnerShadowOverlay(lyr, e, idx) {
    try {
      var dup = lyr.duplicate();
      dup.name = lyr.name + " inner shadow " + idx;
      try { dup.moveBefore(lyr); } catch (em) {}
      // strip copied effects so drop shadows etc. don't render twice
      try { var fx = dup.property("ADBE Effect Parade"); while (fx && fx.numProperties > 0) fx.property(1).remove(); } catch (ef) {}
      // Preferred path: an overlay template authored in AE that already carries an
      // enabled Inner Shadow AND Blending Options with Fill Opacity = 0. Scripting can
      // not activate Blend Options on its own (AE reports the group as hidden), but an
      // .ffx preset can. Falls back to the plain inner-shadow template when absent.
      var usedOverlayTpl = false;
      try {
        var otpl = new File(File.encode(_MK_DIR + "/innershadow-overlay-template.ffx"));
        if (otpl.exists) {
          selectForPreset(lyr.containingComp, dup);
          dup.applyPreset(otpl);
          usedOverlayTpl = true;
        }
      } catch (eot) { _diag.push("IS otpl:" + String(eot).substr(0, 40)); usedOverlayTpl = false; }
      if (!addInnerShadowStyle(dup, e)) { try { dup.remove(); } catch (er) {} return false; }
      // hide the duplicate's own pixels: Fill Opacity = 0 (Layer Styles > Blending
      // Options > Advanced Blending). Group matchNames differ between AE builds, so
      // instead of trusting a fixed path we walk the whole Layer Styles tree and set
      // every property whose match/display name says "fill opacity".
      var okFill = false;
      function huntFillOpacity(grp, depth) {
        if (!grp || depth > 4) return;
        for (var q = 1; q <= grp.numProperties; q++) {
          var pp = null;
          try { pp = grp.property(q); } catch (eg) { continue; }
          if (!pp) continue;
          var mn = "", nm = "";
          try { mn = String(pp.matchName); } catch (e1) {}
          try { nm = String(pp.name); } catch (e2) {}
          if (/fill\s*opacity/i.test(mn) || /fill\s*opacity/i.test(nm)) {
            try { pp.setValue(0); okFill = true; } catch (e3) { _diag.push("IS fillop set fail:" + String(e3).substr(0, 40)); }
          } else {
            var isGrp = false;
            try { isGrp = (pp.numProperties && pp.numProperties > 0); } catch (e4) {}
            if (isGrp) huntFillOpacity(pp, depth + 1);
          }
        }
      }
      try {
        var _st = dup.property("ADBE Layer Styles");
        try { var _bo = _st.property("ADBE Blend Options Group"); if (_bo && !_bo.enabled) _bo.enabled = true; } catch (een) {}
        huntFillOpacity(_st, 0);
      } catch (eh) { _diag.push("IS hunt err:" + String(eh).substr(0, 40)); }
      if (usedOverlayTpl && !okFill) { okFill = true; } // template carries Fill Opacity 0 itself
      if (!okFill) {
        // Could not find Fill Opacity anywhere - dump the first two levels of the styles
        // tree into diag so the property names on this AE build are visible in the status bar.
        var tree = "";
        try {
          var st2 = dup.property("ADBE Layer Styles");
          for (var t1 = 1; t1 <= st2.numProperties; t1++) {
            var g1 = st2.property(t1); tree += g1.matchName + ";";
            try { for (var t2 = 1; t2 <= Math.min(g1.numProperties, 12); t2++) tree += " " + g1.property(t2).matchName + ","; } catch (et2) {}
          }
        } catch (et) {}
        _diag.push("IS overlay " + idx + ": fill opacity NOT FOUND [" + tree.substr(0, 300) + "]");
      }
      return true;
    } catch (eall) { _diag.push("IS overlay err:" + String(eall).substr(0, 60)); return false; }
  }

  function addLayerEffects(lyr, effs) {
    var fx = lyr.property("ADBE Effect Parade");
    var _innerCount = 0;
    for (var i = 0; i < effs.length; i++) {
      var e = effs[i];
      try {
        if (e.kind === 'drop') {
          var ds = fx.addProperty("ADBE Drop Shadow");
          ds.property("ADBE Drop Shadow-0001").setValue([e.color[0], e.color[1], e.color[2], 1]);      // Shadow Color
          ds.property("ADBE Drop Shadow-0002").setValue((e.alpha != null ? e.alpha : 1) * 255);        // Opacity 0..255
          var D = Math.sqrt(e.dx * e.dx + e.dy * e.dy);
          var dir = Math.atan2(e.dx, -e.dy) * 180 / Math.PI; if (dir < 0) dir += 360;                  // clockwise from up
          ds.property("ADBE Drop Shadow-0003").setValue(dir);                                          // Direction
          ds.property("ADBE Drop Shadow-0004").setValue(D);                                            // Distance
          ds.property("ADBE Drop Shadow-0005").setValue(e.blur || 0);                                  // Softness
        } else if (e.kind === 'blur' || e.kind === 'bgblur') {
          // Blur is applied from the SVG filter instead: the file names the blurred elements
          // exactly, while matching by bounding box used to land it on the wrong layer.
        } else if (e.kind === 'inner') {
          // AE has NO inner-shadow effect for shapes — use the native Inner Shadow LAYER STYLE.
          // The style is a singleton per layer: the first shadow lives on the layer itself,
          // every additional one on a style-carrier duplicate (see addInnerShadowOverlay).
          _innerCount++;
          if (_innerCount === 1) addInnerShadowStyle(lyr, e);
          else addInnerShadowOverlay(lyr, e, _innerCount);
        }
      } catch (ex) {}
    }
  }
  // Gradient text fill via the "Gradient Ramp" (ADBE Ramp) effect. Ramp preserves the layer's
  // alpha, so the gradient shows only through the glyphs. Figma handles are normalized to the
  // node box; we map them onto the rendered text rect (layer space) from sourceRect.
  function applyTextGradient(comp, tl, g, t) {
    if (!g || !g.stops || !g.stops.length) return false;
    try {
      // Effect point params live in LAYER space, whose origin is the anchor point — and the
      // anchor sits at Position in comp space. So: P_layer = anchor + (P_comp - position).
      // (Using sourceRect directly put the handles in the wrong space entirely.)
      var tg = tl.property("ADBE Transform Group");
      var pos = [0, 0], anc = [0, 0];
      try { var pv = tg.property("ADBE Position").value; pos = [pv[0], pv[1]]; } catch (e1) {}
      try { var av = tg.property("ADBE Anchor Point").value; anc = [av[0], av[1]]; } catch (e2) {}

      // Figma handles are normalised to the text node's box -> comp coords first.
      var bx = (t && t.ink) ? t.ink.x : (t ? t.x : 0), by = (t && t.ink) ? t.ink.y : (t ? t.y : 0);
      var bw = (t && t.ink) ? t.ink.w : (t ? (t.w || 0) : 0), bh = (t && t.ink) ? t.ink.h : (t ? (t.h || 0) : 0);
      var s0 = g.stops[0], s1 = g.stops[g.stops.length - 1];
      function pt(h) {
        var cx = bx + (h.x || 0) * bw, cy = by + (h.y || 0) * bh;
        return [anc[0] + (cx - pos[0]), anc[1] + (cy - pos[1])];
      }
      var fx = tl.property("ADBE Effect Parade");
      var ramp = fx.addProperty("ADBE Ramp");
      ramp.property("ADBE Ramp-0001").setValue(pt(g.h0));                                   // Start of Ramp
      ramp.property("ADBE Ramp-0002").setValue([s0.color[0], s0.color[1], s0.color[2], 1]); // Start Color
      ramp.property("ADBE Ramp-0003").setValue(pt(g.h1));                                   // End of Ramp
      ramp.property("ADBE Ramp-0004").setValue([s1.color[0], s1.color[1], s1.color[2], 1]); // End Color
      try { ramp.property("ADBE Ramp-0005").setValue(g.type === 'radial' ? 2 : 1); } catch (esh) {} // shape
      try { ramp.property("ADBE Ramp-0007").setValue(0); } catch (eb) {}                    // Blend With Original 0
      return true;
    } catch (e) { return false; }
  }

  // Figma skewX -> AE's editable Transform effect. A font family such as Source Han Sans has
  // no true italic face: Figma stores the slant in the node matrix, not in fontName.style.
  // Rotate around the measured ink centre so the alignment already calculated from Figma's
  // (also sheared) render bounds remains exact. AE's skew sign is opposite Figma's matrix shear.
  function applyTextSkew(comp, tl, t) {
    if (!t || !t.skewX) return false;
    try {
      var r = measureRect(comp, tl);
      if (!r) { _diag.push("skew: text not measurable"); return false; }
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var tg = tl.property("ADBE Transform Group");
      var pos = tg.property("ADBE Position").value, anc = tg.property("ADBE Anchor Point").value;
      // Text-layer effect points use COMP coordinates, unlike sourceRectAtTime's layer-local
      // rect. Setting the pivot to r.left/r.top directly shears around the wrong place.
      var pivot = [pos[0] + cx - anc[0], pos[1] + cy - anc[1]];
      var fx = tl.property("ADBE Effect Parade").addProperty("ADBE Geometry2");
      fx.name = "Figma 斜体";
      fx.property(1).setValue(pivot);                  // effect Anchor Point, in comp space
      fx.property(2).setValue(pivot);                  // same Position -> pivot does not travel
      fx.property("ADBE Geometry2-0005").setValue(-t.skewX);
      fx.property("ADBE Geometry2-0006").setValue(90); // horizontal glyph shear; 0 shears the LINE vertically
      return true;
    } catch (e) { _diag.push("skew:" + String(e).substr(0, 40)); return false; }
  }

  // Apply text-node effects (drop shadow / blur / inner shadow) + gradient fill to a text layer.
  function applyTextDecor(comp, tl, t) {
    applyTextSkew(comp, tl, t);
    try { if (t.fx && t.fx.length) addLayerEffects(tl, t.fx); } catch (e1) {}
    // Blur is skipped inside addLayerEffects (shapes get it from their own channel), so a
    // blurred text layer needs it applied here — including a blur set on its parent group.
    try { if (t.blur) addBlur(tl, t.blur); } catch (e1b) {}
    // Gradient TEXT fill — PIXEL ACCURATE.
    // Gradient Overlay (layer style) only exposes angle/scale, so the stops could never sit
    // exactly where Figma puts them. Instead: a shape layer carrying a real gradient fill
    // (every stop, baked into an .ffx) with its axis set to Figma's own handle points, matted
    // by the text itself. Same result, but the geometry is exact rather than approximated.
    try {
      if (t.gradFfx && t.grad) {
        var gf = new File(File.encode(t.gradFfx));
        if (gf.exists) {
          var bx = t.x, by = t.y, bw = (t.w || 0), bh = (t.h || 0);
          // Exact handle points from Figma (already in comp coords); the normalised pair is
          // only a fallback for payloads produced by an older plugin build.
          var p0 = t.grad.p0 ? [t.grad.p0[0], t.grad.p0[1]] : [bx + (t.grad.h0.x || 0) * bw, by + (t.grad.h0.y || 0) * bh];
          var p1 = t.grad.p1 ? [t.grad.p1[0], t.grad.p1[1]] : [bx + (t.grad.h1.x || 0) * bw, by + (t.grad.h1.y || 0) * bh];

          var gl = comp.layers.addShape();
          selectForPreset(comp, gl);
          gl.applyPreset(gf);
          // TEMP calibration: the computed axis is written into the layer name so it can be
          // compared against Figma's own x1,y1->x2,y2 without guessing.
          gl.name = (tl.name || "Text") + " gradient";

          var root = gl.property("ADBE Root Vectors Group");
          var gfill = findProp(root, "ADBE Vector Graphic - G-Fill");
          if (gfill) {
            setGradAxis(gfill, { type: t.grad.type, start: p0, end: p1 });
            // Restore the Figma paint opacity instead of inheriting the preset's value.
            try { gfill.property("ADBE Vector Fill Opacity").setValue((t.grad.opacity == null ? 1 : t.grad.opacity) * 100); } catch (efo) {}
            try { gl.property("ADBE Transform Group").property("ADBE Opacity").setValue(100); } catch (elo) {}
            // A rectangle over the text so the fill has something to paint; the matte trims it.
            var cont = gfill.parentProperty;
            var pad = 8;
            var rc = cont.addProperty("ADBE Vector Shape - Rect");
            rc.property("ADBE Vector Rect Size").setValue([bw + pad * 2, bh + pad * 2]);
            rc.property("ADBE Vector Rect Position").setValue([bx + bw / 2, by + bh / 2]);
            try { rc.moveTo(1); } catch (emv) {}
            zeroTransform(gl);
            gl.moveAfter(tl);                                  // matte must sit directly above
            try { gl.setTrackMatte(tl, TrackMatteType.ALPHA); }
            catch (e1) { try { gl.trackMatteType = TrackMatteType.ALPHA; } catch (e2) {} }
            // The text is a MATTE here, not a layer in its own right: keep the two together
            // through the restack and the precomp, or the gradient loses its matte and vanishes.
            pairMatte(gl, tl, t.path, t.z);
            if (t.hidden) { try { gl.enabled = false; } catch (ehg) {} }
            // The matte's alpha multiplies into the result, so any layer opacity meant for the
            // text has to live on the gradient instead — otherwise the fill came out washed out.
            try {
              var mtOp = tl.property("ADBE Transform Group").property("ADBE Opacity");
              var carried = mtOp.value;
              if (carried < 100) {
                mtOp.setValue(100);
                gl.property("ADBE Transform Group").property("ADBE Opacity").setValue(carried);
              }
            } catch (eop) {}
          } else { _diag.push("TXTGRAD: no G-Fill in preset"); gl.remove(); }
        }
      }
    } catch (e2) { _diag.push("TXTGRAD:" + String(e2).substr(0, 40) + " @" + e2.line); }
  }

  // Match an effect to this shape by CENTRE proximity + proportional size (robust to strokes,
  // group transforms and effect-expanded Figma bounds). Applies once per effect entry.
  function applyMatchingEffects(lyr, sdata, effects) {
    if (!effects || !effects.length) return;
    var bb = bboxOfSubs(sdata.subpaths);
    var cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
    for (var i = 0; i < effects.length; i++) {
      var ef = effects[i];
      if (ef._used) continue;
      var ecx = ef.x + ef.w / 2, ecy = ef.y + ef.h / 2;
      var ctol = Math.max(6, Math.min(ef.w, ef.h) * 0.35);
      var wtol = Math.max(24, ef.w * 0.5), htol = Math.max(24, ef.h * 0.5);
      if (Math.abs(ecx - cx) < ctol && Math.abs(ecy - cy) < ctol &&
          Math.abs(ef.w - bb.w) < wtol && Math.abs(ef.h - bb.h) < htol) {
        ef._used = true;
        addLayerEffects(lyr, ef.effects);
        return;
      }
    }
  }

  // Map SVG coords -> comp coords: anchor [0,0], position [0,0].
  function zeroTransform(layer) {
    var t = layer.property("ADBE Transform Group");
    t.property("ADBE Anchor Point").setValue([0, 0, 0]);
    t.property("ADBE Position").setValue([0, 0, 0]);
    return t;
  }

  var _maskDefs = {};   // Figma mask root id -> geometry records (never rendered as art)
  var _imageMaskDefs = {}, _imageMaskFolder = '';
  function registerImageMasks(images, folder) {
    if (folder) _imageMaskFolder = folder;
    for (var i = 0; images && i < images.length; i++)
      if (images[i].maskSource) _imageMaskDefs[images[i].maskSource] = images[i];
  }
  // Build one white ALPHA matte above a masked layer. All regions of a container mask share a
  // single matte layer; this keeps the mask out of the visible artwork and preserves editability.
  function applyNodeMask(lyr, sdata) {
    if (!sdata.maskId) return null;
    var defs = _maskDefs[sdata.maskId];
    var imageMask = _imageMaskDefs[sdata.maskId];
    if ((!defs || !defs.length) && !imageMask) { _diag.push("mask missing " + sdata.maskId); return null; }
    var comp = lyr.containingComp;
    var isLuma = ((imageMask || defs[0]).maskType === 'LUMINANCE');
    var matteKind = isLuma ? TrackMatteType.LUMA : TrackMatteType.ALPHA;
    var mt = imageMask ? createImageFootage(comp, imageMask, _imageMaskFolder) : comp.layers.addShape();
    mt.name = "Figma 遮罩 - " + (lyr.name || "图层");
    var contents = imageMask ? null : mt.property("ADBE Root Vectors Group");
    for (var i = 0; !imageMask && i < defs.length; i++) {
      var def = defs[i];
      if (isLuma) {
        // Luminance depends on the ORIGINAL colours, not on a white alpha silhouette.
        addShapeGroup(contents, def, def.name || "Mask", false);
        continue;
      }
      var grp = contents.addProperty("ADBE Vector Group");
      grp.name = def.name || "Mask";
      var gc = grp.property("ADBE Vectors Group");
      addGeom(gc, def, false);
      var fl = gc.addProperty("ADBE Vector Graphic - Fill");
      fl.property("ADBE Vector Fill Color").setValue([1, 1, 1, 1]);
      try { if (def.fillRule) fl.property("ADBE Vector Fill Rule").setValue(def.fillRule); } catch (efr) {}
      try {
        var maskOpacity = (def.opacity == null ? 1 : def.opacity) * (def.fillOpacity == null ? 1 : def.fillOpacity);
        if (maskOpacity < 1)
          grp.property("ADBE Vector Transform Group").property("ADBE Vector Group Opacity").setValue(maskOpacity * 100);
      } catch (eop) {}
    }
    if (!imageMask) zeroTransform(mt);
    mt.moveBefore(lyr);                       // AE requires the matte directly above its content
    try { lyr.setTrackMatte(mt, matteKind); }
    catch (e1) { try { lyr.trackMatteType = matteKind; } catch (e2) {} }
    mt.enabled = false;
    _mattePairs.push({ lyr: lyr, mt: mt, type: matteKind });
    return mt;
  }

  function build(model, opts) {
    opts = opts || {};
    var comp = opts.comp || (app.project ? app.project.activeItem : null);
    if (!comp || !(comp instanceof CompItem)) throw new Error("No active comp. Open/select a comp first.");
    var baseName = opts.name || "UI Shapes";
    var shapes = model.shapes, N = shapes.length, i;
    _diag = []; _fontMiss = {}; _fontMissList = []; _imgSlots = []; _layerPaths = []; _mattePairs = []; _referenceLayers = [];
    _maskDefs = {};
    _imageMaskDefs = {}; _imageMaskFolder = '';
    registerImageMasks(opts.imageMasks, opts.imageFolder);

    beginUndo("SVG -> Shapes");
    try {
      var created = [];
      var layers = comp.layers;

      if (opts.oneLayer) {
        var layer = layers.addShape();
        layer.name = baseName;
        var contents = layer.property("ADBE Root Vectors Group");
        // reversed: first SVG shape must sit at the bottom of the contents stack (drawn first)
        for (i = N - 1; i >= 0; i--) {
          var g = addShapeGroup(contents, shapes[i]);
          var op = shapes[i].opacity;
          if (op != null && op < 1) {
            var tr = g.property("ADBE Vector Transform Group");
            if (tr) tr.property("ADBE Vector Group Opacity").setValue(op * 100);
          }
        }
        zeroTransform(layer);
        created.push(layer);
      } else {
        // forward order -> correct SVG z-order with NO reordering pass
        var presets = opts.gradientPresets || null;
        var effects = opts.effects || null;
        var shapeInfos = [];   // { lyr, bb } — for GLOBAL best-match of effects after the loop
        var shapeErr = 0, firstShapeErr = "";
        for (i = 0; i < N; i++) {
          var currentLayer = null;
          try {
          var sdata = shapes[i];
          if (sdata.layerStroke && sdata.maskId) {
            var maskedPaint = {}, border = sdata.layerStroke;
            for (var paintKey in sdata) if (sdata.hasOwnProperty(paintKey)) maskedPaint[paintKey] = sdata[paintKey];
            maskedPaint.fillOpacity = sdata.layerFillOpacity == null ? 1 : sdata.layerFillOpacity;
            maskedPaint.fill = maskedPaint.fillOpacity ? sdata.fill : null;
            maskedPaint.stroke = border.color; maskedPaint.strokeWidth = border.width;
            maskedPaint.strokeOpacity = border.opacity == null ? 1 : border.opacity;
            maskedPaint.strokeAlign = border.align || 'CENTER'; maskedPaint.layerStroke = null;
            sdata = maskedPaint;
          }
          if (sdata.maskSource) {
            if (!_maskDefs[sdata.maskSource]) _maskDefs[sdata.maskSource] = [];
            _maskDefs[sdata.maskSource].push(sdata);
            continue;                         // mask geometry only, never a visible shape layer
          }
          var srcIdx = (sdata.srcIndex != null) ? sdata.srcIndex : i;
          var gp = (presets && presets[srcIdx]) ? presets[srcIdx] : null;
          var fillFfx = null, strokeFfx = null;
          // A node split into one layer per paint says which preset it wants; an unsplit layer
          // takes the node's main fill/stroke presets as before.
          var pref = sdata.presetRef || null;
          if (gp && !pref) { fillFfx = gp.fill || null; strokeFfx = gp.stroke || null; }
          else if (gp && pref.kind === 'fill') fillFfx = gp.fill || null;
          else if (gp && pref.kind === 'stroke') strokeFfx = gp.stroke || null;
          else if (gp && pref.kind === 'extra' && gp.extras) {
            for (var ex = 0; ex < gp.extras.length; ex++) {
              if (gp.extras[ex].i !== pref.i) continue;
              if (gp.extras[ex].kind === 'stroke') strokeFfx = gp.extras[ex].ffx; else fillFfx = gp.extras[ex].ffx;
            }
          }
          var hasGFill = !!(sdata.gradient && fillFfx);
          var hasGStroke = !!(sdata.strokeGradient && strokeFfx);
          var nm = sdata.name || (baseName + " " + (i + 1));

          var lyr = layers.addShape();
          currentLayer = lyr;
          lyr.name = nm;

          // A picture's slot: keep an empty layer purely to hold its place in the stack.
          // buildImages() drops the footage here later, so it lands at the right depth instead
          // of on top of the whole scene. The plugin paints picture nodes with a flat marker
          // colour (254,0,255) for the export, so they are recognised here.
          var isSlot = !!sdata.imageSlot;
          if (!isSlot && sdata.fill) {
            isSlot = (Math.abs(sdata.fill[0] - 254 / 255) < 0.01 &&
                      Math.abs(sdata.fill[1]) < 0.01 &&
                      Math.abs(sdata.fill[2] - 1) < 0.01);
          }
          if (isSlot) {
            lyr.name = "MK image slot";
            lyr.enabled = false;
            zeroTransform(lyr);
            _imgSlots.push({ lyr: lyr, bb: bboxOfSubs(sdata.subpaths), blur: sdata.blur || 0, z: sdata.z });
            created.push(lyr);
            continue;
          }

          var okMain = true;
          if (hasGFill) {
            okMain = applyFillGradient(comp, lyr, sdata, fillFfx, !hasGStroke);   // solid stroke only if no gradient stroke
          } else if (hasGStroke) {
            okMain = applyStrokeGradient(comp, lyr, sdata, strokeFfx, true);      // includes solid fill if any
          } else {
            addShapeGroup(lyr.property("ADBE Root Vectors Group"), sdata, nm, false);
          }
          lyr.name = nm;                                                          // applyPreset may rename
          if (!okMain) addShapeGroup(lyr.property("ADBE Root Vectors Group"), sdata, nm, false);
          var t = zeroTransform(lyr);
          if (sdata.opacity != null && sdata.opacity < 1) t.property("ADBE Opacity").setValue(sdata.opacity * 100);
          // Figma's additional fills/strokes: each becomes another group in THIS layer.
          if (sdata.extraPaints && sdata.extraPaints.length) {
            var exList = (gp && gp.extras) ? gp.extras : null;
            // Everything already in Contents is the MAIN paint (plus its aligned stroke group);
            // the slot right under it is where every lower Figma paint gets inserted.
            var underAt = lyr.property("ADBE Root Vectors Group").numProperties + 1;
            for (var xi = 0; xi < sdata.extraPaints.length; xi++) {
              var ep = sdata.extraPaints[xi];
              var exFfx = null;
              if (exList) for (var xj = 0; xj < exList.length; xj++) if (exList[xj].i === xi) exFfx = exList[xj].ffx;
              if (ep.gradient && exFfx) {
                if (!addExtraGradientPaint(comp, lyr, sdata, ep, exFfx, underAt)) addExtraSolidPaint(lyr.property("ADBE Root Vectors Group"), sdata, ep, underAt);
              } else {
                if (ep.gradient && !ep.color) { var rp = repStop(ep.gradient.stops); ep.color = rp.color; if (ep.opacity == null) ep.opacity = rp.opacity; }
                addExtraSolidPaint(lyr.property("ADBE Root Vectors Group"), sdata, ep, underAt);
              }
            }
            lyr.name = nm;                                    // applyPreset renames the layer
          }

          addStrokeStyle(lyr, sdata.layerStroke, sdata.layerFillOpacity);
          lyr = scaleStrokeLayer(lyr, sdata.layerStroke);
          addBlur(lyr, sdata.blur);
          // Node mode: shadows belong to this layer by definition — no matching required.
          if (sdata.fx && sdata.fx.length) {
            var ownFx = [];
            for (var fi2 = 0; fi2 < sdata.fx.length; fi2++)
              if (sdata.fx[fi2].kind === 'drop' || sdata.fx[fi2].kind === 'inner') ownFx.push(sdata.fx[fi2]);
            if (ownFx.length) addLayerEffects(lyr, ownFx);
          }
          applyBlend(lyr, sdata.blend);
          var nodeMatte = applyNodeMask(lyr, sdata);
          trackLayer(lyr, sdata.path, sdata.z, nodeMatte);
          if (nodeMatte) trackLayer(nodeMatte, sdata.path, sdata.z, null, true);
          // Node mode walks hidden nodes too (SVG export dropped them silently), so the eye
          // has to be honoured here or an invisible Figma layer arrives fully visible.
          if (sdata.hidden) { try { lyr.enabled = false; } catch (ehs) {} }
          if (effects) shapeInfos.push({ lyr: lyr, bb: bboxOfSubs(sdata.subpaths) });
          created.push(lyr);

          // combo: gradient fill + gradient stroke -> put the gradient stroke on its own layer above
          if (hasGFill && hasGStroke) {
            var slyr = layers.addShape();
            slyr.name = nm + " stroke";
            applyStrokeGradient(comp, slyr, sdata, strokeFfx, false);
            slyr.name = nm + " stroke";
            var st = zeroTransform(slyr);
            if (sdata.opacity != null && sdata.opacity < 1) st.property("ADBE Opacity").setValue(sdata.opacity * 100);
            created.push(slyr);
          }
          } catch (eShape) {
            // One bad shape must not abort the whole import. Remove its partial layer so it
            // cannot survive as an untracked orphan outside the root precomp.
            shapeErr++;
            if (currentLayer) { try { currentLayer.remove(); } catch (eRemove) {} }
            if (!firstShapeErr) firstShapeErr = String(eShape).substr(0, 60) + " @" + eShape.line;
          }
        }
        if (shapeErr) _diag.push("shapes failed " + shapeErr + "/" + N + " (" + firstShapeErr + ")");

        // GLOBAL best-match: for each effect pick the shape closest in centre AND size, so
        // concentric shapes (e.g. 3 circles sharing a centre) don't let a big faint one steal it.
        if (effects && effects.length && shapeInfos.length) {
          for (var ei = 0; ei < effects.length; ei++) {
            var ef = effects[ei];
            var ecx = ef.x + ef.w / 2, ecy = ef.y + ef.h / 2;
            var bestI = -1, bestScore = 1e18;
            for (var si = 0; si < shapeInfos.length; si++) {
              if (shapeInfos[si]._used) continue;
              var sb = shapeInfos[si].bb, scx = sb.x + sb.w / 2, scy = sb.y + sb.h / 2;
              var cd = Math.abs(scx - ecx) + Math.abs(scy - ecy);       // centre distance
              var sd = Math.abs(sb.w - ef.w) + Math.abs(sb.h - ef.h);   // size difference
              var score = cd + sd;
              if (score < bestScore) { bestScore = score; bestI = si; }
            }
            // accept only a reasonable match (guards against attaching to a totally wrong shape)
            var lim = (ef.w + ef.h) * 0.6 + 40;
            if (bestI >= 0 && bestScore <= lim) {
              addLayerEffects(shapeInfos[bestI].lyr, ef.effects);
              shapeInfos[bestI]._used = true; ef._used = true;
            }
          }
          // diagnostics for anything still unmatched
          var un = 0, first = null;
          for (i = 0; i < effects.length; i++) if (!effects[i]._used) { un++; if (!first) first = effects[i]; }
          if (un > 0 && first) {
            var fcx = first.x + first.w / 2, fcy = first.y + first.h / 2, best = null, bd = 1e9;
            for (var b = 0; b < shapeInfos.length; b++) {
              var sbb = shapeInfos[b].bb, sx = sbb.x + sbb.w / 2, sy = sbb.y + sbb.h / 2;
              var dd = Math.abs(sx - fcx) + Math.abs(sy - fcy);
              if (dd < bd) { bd = dd; best = sbb; }
            }
            _diag.push("FX unmatched " + un + " | ef[" + Math.round(first.x) + "," + Math.round(first.y) + "," + Math.round(first.w) + "," + Math.round(first.h) + "]" +
              (best ? " nearest[" + Math.round(best.x) + "," + Math.round(best.y) + "," + Math.round(best.w) + "," + Math.round(best.h) + "]" : " (no shapes)"));
          }
        }
      }
      return created;
    } finally {
      endUndo();
    }
  }

  // A guaranteed-INSTALLED PostScript name. Assigning a NON-installed name marks the layer
  // as a "missing font", and sourceRectAtTime() then THROWS on that layer — which was
  // dropping every text into the crude fallback branch (no centring -> whole scene misplaced).
  var _safeFont = null;
  function safeFontName() {
    if (_safeFont) return _safeFont;
    try {
      if (app.fonts && app.fonts.allFonts && app.fonts.allFonts.length) {
        var fonts = app.fonts.allFonts, i;
        var pref = ["ArialMT", "Arial-Regular", "MyriadPro-Regular", "HelveticaNeue", "Helvetica", "SegoeUI", "TimesNewRomanPSMT"];
        for (var p = 0; p < pref.length; p++) for (i = 0; i < fonts.length; i++) if (fonts[i].postScriptName === pref[p]) return (_safeFont = fonts[i].postScriptName);
        for (i = 0; i < fonts.length; i++) if (/arial|helvetica|segoe|myriad/i.test(String(fonts[i].familyName))) return (_safeFont = fonts[i].postScriptName);
        return (_safeFont = fonts[0].postScriptName);
      }
    } catch (e) {}
    return (_safeFont = "ArialMT");
  }

  // Resolve Figma family + style ("Inter" + "Semi Bold") to an AE PostScript font name.
  // NEVER returns a name that isn't actually installed (see safeFontName above).
  function resolveFont(family, style) {
    style = style || "Regular";
    var norm = String(style).toLowerCase().replace(/\s+/g, "");
    try {
      if (app.fonts && app.fonts.allFonts) {
        var fonts = app.fonts.allFonts, i, f;
        for (i = 0; i < fonts.length; i++) { f = fonts[i]; if (f.familyName === family && f.styleName === style) return f.postScriptName; }
        for (i = 0; i < fonts.length; i++) { f = fonts[i]; if (f.familyName === family && String(f.styleName).toLowerCase().replace(/\s+/g, "") === norm) return f.postScriptName; }
        var famFirst = null;
        for (i = 0; i < fonts.length; i++) { f = fonts[i]; if (f.familyName === family) { if (!famFirst) famFirst = f; if (f.styleName === "Regular") return f.postScriptName; } }
        if (famFirst) return famFirst.postScriptName;
      }
    } catch (e) {}
    // Not found via allFonts enumeration — return the conventional PostScript name
    // (e.g. "Inter" + "Semi Bold" -> "Inter-SemiBold"). AE resolves this to the real font
    // when it IS installed (enumeration sometimes misses it). Only if the family string is
    // empty do we hard-substitute a guaranteed font.
    if (!family) return safeFontName();
    return String(family).replace(/\s+/g, "") + "-" + String(style).replace(/\s+/g, "");
  }

  // ---- editable text layers (from the Figma plugin's text-node data) ----
  // AE's metric kerning compresses full-width CJK punctuation by half an em. Figma keeps
  // its advance, so disable automatic kerning only at those characters, retaining Latin pairs.
  function applyFigmaPunctuation(doc, chars) {
    var punctuation = /[\u3001\u3002\u3008-\u3011\u3014-\u301f\uff01\uff08\uff09\uff0c\uff0e\uff1a\uff1b\uff1f\uff3b\uff3d\uff5b\uff5d]/;
    if (!punctuation.test(chars || "")) return;
    if (typeof doc.characterRange !== "function") {
      doc.autoKernType = AutoKernType.NO_AUTO_KERN; doc.kerning = 0;
      return;
    }
    for (var i = 0; i < chars.length; i++) if (punctuation.test(chars.charAt(i))) {
      var range = doc.characterRange(i, i + 1);
      range.autoKernType = AutoKernType.NO_AUTO_KERN; range.kerning = 0;
    }
  }

  function addStrokeStyle(lyr, stroke, fillOpacity) {
    if (!stroke || !(stroke.width > 0)) return;
    var name = lyr.name;
    selectForPreset(lyr.containingComp, lyr);
    lyr.applyPreset(new File(File.encode(_MK_DIR + '/stroke-template.ffx')));
    lyr.name = name;
    var styles = lyr.property('ADBE Layer Styles'), style = styles.property('frameFX/enabled');
    style.property('frameFX/mode2').setValue(1);
    style.property('frameFX/color').setValue([stroke.color[0],stroke.color[1],stroke.color[2],1]);
    style.property('frameFX/size').setValue(stroke.width * Math.max(1, Math.ceil(1 / stroke.width)));
    style.property('frameFX/opacity').setValue((stroke.opacity == null ? 1 : stroke.opacity) * 100);
    // ExtendScript associates chained ternaries differently; keep these branches explicit.
    var position = 3;
    if (stroke.align === 'INSIDE') position = 2;
    else if (stroke.align === 'OUTSIDE') position = 1;
    style.property('frameFX/style').setValue(position);
    styles.property('ADBE Blend Options Group').property('ADBE Adv Blend Group').property('ADBE Layer Fill Opacity2').setValue((fillOpacity == null ? 1 : fillOpacity) * 100);
  }

  function scaleStrokeLayer(lyr, stroke) {
    if (!stroke || !(stroke.width > 0 && stroke.width < 1)) return lyr;
    var scale = Math.ceil(1 / stroke.width), comp = lyr.containingComp;
    var rect = lyr.sourceRectAtTime(comp.time, false), pad = stroke.width + 1;
    var left = rect.left - pad, top = rect.top - pad, t = lyr.property('ADBE Transform Group');
    var anchor = t.property('ADBE Anchor Point').value, position = t.property('ADBE Position').value;
    var size = t.property('ADBE Scale').value, rotation = t.property('ADBE Rotate Z').value;
    var opacity = t.property('ADBE Opacity').value, blend = lyr.blendingMode, enabled = lyr.enabled, name = lyr.name;
    var source = app.project.items.addComp(name + ' 细描边', Math.max(4, Math.ceil((rect.width + 2 * pad) * scale)),
      Math.max(4, Math.ceil((rect.height + 2 * pad) * scale)), comp.pixelAspect, comp.duration, comp.frameRate);
    source.parentFolder = comp.parentFolder;
    lyr.copyToComp(source);
    var inner = source.layer(1), it = inner.property('ADBE Transform Group');
    it.property('ADBE Anchor Point').setValue([left, top, 0]);
    it.property('ADBE Position').setValue([0, 0, 0]);
    it.property('ADBE Scale').setValue([100 * scale, 100 * scale, 100]);
    it.property('ADBE Rotate Z').setValue(0);
    it.property('ADBE Opacity').setValue(100);
    inner.blendingMode = BlendingMode.NORMAL; inner.enabled = true;
    var outer = comp.layers.add(source), ot = outer.property('ADBE Transform Group');
    outer.name = name;
    ot.property('ADBE Anchor Point').setValue([(anchor[0] - left) * scale, (anchor[1] - top) * scale, anchor[2] || 0]);
    ot.property('ADBE Position').setValue(position);
    ot.property('ADBE Scale').setValue([size[0] / scale, size[1] / scale, size[2] == null ? 100 : size[2]]);
    ot.property('ADBE Rotate Z').setValue(rotation);
    ot.property('ADBE Opacity').setValue(opacity);
    outer.blendingMode = blend; outer.enabled = enabled;
    outer.moveBefore(lyr); lyr.remove();
    return outer;
  }

  function applyTextStroke(doc, t) {
    doc.applyStroke = false;
  }

  function applyParagraphStyle(doc, style) {
    if (style.leading != null) { doc.autoLeading = false; doc.leading = style.leading; }
    if (style.paragraphSpacing != null) doc.spaceAfter = style.paragraphSpacing;
    if (style.paragraphIndent != null) doc.firstLineIndent = style.paragraphIndent;
  }

  function applyTextFillOpacity(tl, segments) {
    var index = 0;
    for (var i = 0; i < segments.length; i++) {
      // Range Selector indices omit paragraph/soft breaks, unlike TextDocument ranges.
      var segment = segments[i], length = (aeLines(segment.characters) || '').replace(/[\r\u0003]/g, '').length;
      if (length && segment.opacity != null && segment.opacity < 1) {
        var animator = tl.property('ADBE Text Properties').property('ADBE Text Animators').addProperty('ADBE Text Animator');
        animator.name = 'Figma fill opacity';
        animator.property('ADBE Text Animator Properties').addProperty('ADBE Text Fill Opacity').setValue(segment.opacity * 100);
        var selector = animator.property('ADBE Text Selectors').addProperty('ADBE Text Selector');
        var advanced = selector.property('ADBE Text Range Advanced');
        advanced.property('ADBE Text Range Units').setValue(2);
        advanced.property('ADBE Text Selector Smoothness').setValue(0);
        selector.property('ADBE Text Index Start').setValue(index);
        selector.property('ADBE Text Index End').setValue(index + length);
      }
      index += length;
    }
  }

  function _applyDoc(tl, style, align) {
    var tp = tl.property("ADBE Text Properties").property("ADBE Text Document");
    var doc = tp.value;
    if (style.fontSize) doc.fontSize = style.fontSize;
    if (style.color) { doc.applyFill = true; doc.fillColor = [style.color[0], style.color[1], style.color[2]]; }
    try { if (style.tracking != null) doc.tracking = style.tracking; } catch (etr) {}
    try { if (style.family) doc.font = resolveFont(style.family, style.style); } catch (e0) {}
    applyParagraphStyle(doc, style);
    applyFigmaPunctuation(doc, doc.text);
    applyTextStroke(doc, style);
    try {
      if (align === 'CENTER') doc.justification = ParagraphJustification.CENTER_JUSTIFY;
      else if (align === 'RIGHT') doc.justification = ParagraphJustification.RIGHT_JUSTIFY;
      else doc.justification = ParagraphJustification.LEFT_JUSTIFY;
    } catch (e1) {}
    tp.setValue(doc);
    if (style.stroke) addStrokeStyle(tl, style.stroke, style.fillOpacity);
    else applyTextFillOpacity(tl, [{characters:doc.text,opacity:style.fillOpacity}]);
  }
  // one text layer; px = left x (or center/right per align), py = baseline
  function makeOneText(comp, chars, style, px, py, align, boxW) {
    if (chars == null || chars === "") return null;
    var tl = comp.layers.addText(aeLines(chars));
    _applyDoc(tl, style, align);
    var x = px;
    if (align === 'CENTER') x = px + (boxW || 0) / 2;
    else if (align === 'RIGHT') x = px + (boxW || 0);
    var tg = tl.property("ADBE Transform Group");
    tg.property("ADBE Anchor Point").setValue([0, 0, 0]);
    tg.property("ADBE Position").setValue([x, py, 0]);
    if (style.opacity != null && style.opacity < 1) tg.property("ADBE Opacity").setValue(style.opacity * 100);
    return tl;
  }
  // align a text layer's rendered box to the Figma bbox (centre vertically, left/centre/right horiz)
  // Measure a text layer's rendered box, robust to the "0-size right after create" glitch.
  function measureRect(comp, tl) {
    var r = null;
    try { r = tl.sourceRectAtTime(comp.time, false); } catch (e) {}
    if (r && r.width > 0 && r.height > 0) return r;
    try { r = tl.sourceRectAtTime(0, false); } catch (e2) {}
    if (r && r.width > 0 && r.height > 0) return r;
    return null;
  }

  function positionToBBox(comp, tl, t, align) {
    var tg = tl.property("ADBE Transform Group");
    tg.property("ADBE Anchor Point").setValue([0, 0, 0]);
    var r = measureRect(comp, tl);
    if (r) _txtOk++; else _txtNo++;
    var ax, ay;
    if (r) {
      // Align AE's rendered ink to Figma's rendered ink (t.ink) when we have it — the layer
      // bbox is the LINE box (glyphs sit low in it), so centring there lifts text ~5px too high.
      var bx = t.ink ? t.ink.x : t.x, bw = t.ink ? t.ink.w : (t.w || 0);
      var by = t.ink ? t.ink.y : t.y, bh = t.ink ? t.ink.h : (t.h || 0);
      if (align === 'CENTER') ax = (bx + bw / 2) - (r.left + r.width / 2);
      else if (align === 'RIGHT') ax = (bx + bw) - (r.left + r.width);
      else ax = bx - r.left;
      ay = (by + bh / 2) - (r.top + r.height / 2);
    } else {
      // no measurement: rely on the paragraph justification (anchor = pen origin at [0,0]).
      // CENTER-justified text distributes around Position.x, so put x at the bbox centre.
      if (align === 'CENTER') ax = t.x + (t.w || 0) / 2;
      else if (align === 'RIGHT') ax = t.x + (t.w || 0);
      else ax = t.x;
      // baseline so the glyph vertical centre lands at the Figma bbox centre (cap ~0.35*fs above baseline)
      ay = t.y + (t.h || 0) / 2 + (t.fontSize || 16) * 0.35;
    }
    tg.property("ADBE Position").setValue([ax, ay, 0]);
    return tg;
  }

  // Rotated text: rotate around the rendered-text centre and drop that centre on the Figma
  // bbox centre. The Figma bbox is axis-aligned, but its centre == the node's visual centre,
  // so this matches regardless of rotation pivot or paragraph alignment.
  function placeRotated(comp, tl, t) {
    var tg = tl.property("ADBE Transform Group");
    var r = measureRect(comp, tl);
    if (r) { _txtOk++; tg.property("ADBE Anchor Point").setValue([r.left + r.width / 2, r.top + r.height / 2, 0]); }
    else { _txtNo++; tg.property("ADBE Anchor Point").setValue([0, 0, 0]); }
    var rcx = t.ink ? (t.ink.x + t.ink.w / 2) : (t.x + (t.w || 0) / 2);
    var rcy = t.ink ? (t.ink.y + t.ink.h / 2) : (t.y + (t.h || 0) / 2);
    tg.property("ADBE Position").setValue([rcx, rcy, 0]);
    try { tg.property("ADBE Rotate Z").setValue(t.rotation || 0); } catch (e) { try { tg.property("ADBE Rotation").setValue(t.rotation || 0); } catch (e2) {} }
    return tg;
  }

  // RICH text as ONE layer via per-character styling (AE 24.3+ characterRange).
  // Creates the layer + applies per-run styling but does NOT position it (pass 2 does).
  // Returns the layer, or null if the caller should fall back to makeRunLayers (old AE).
  function createRich(comp, t) {
    var full = "", k;
    for (k = 0; k < t.segs.length; k++) full += aeLines(t.segs[k].characters);
    if (full === "") return null;

    // Box text when the paragraph wraps, otherwise point text (same rule as plain text).
    // Without this, every multi-style paragraph became one endless non-wrapping line.
    var tl = null;
    if (t.box) { try { tl = comp.layers.addBoxText([t.w || 100, t.h || 100], full); } catch (eb) { tl = null; } }
    if (!tl) tl = comp.layers.addText(full);
    var tp = tl.property("ADBE Text Properties").property("ADBE Text Document");

    var supportsRange = false;
    try { supportsRange = (typeof tp.value.characterRange === "function"); } catch (e) {}
    if (!supportsRange) { tl.remove(); return null; }   // old AE -> split

    // PATTERN 1 (verified): edit ONE copy of the doc, then commit with a single setValue.
    var doc = tp.value, applied = false, idx = 0;
    applyParagraphStyle(doc, t);
    for (k = 0; k < t.segs.length; k++) {
      var sg = t.segs[k], len = sg.characters.length;
      if (len > 0) {
        var cr = doc.characterRange(idx, idx + len);
        try { cr.fillColor = [sg.color[0], sg.color[1], sg.color[2]]; applied = true; } catch (ec) {}
        try { if (sg.fontSize) cr.fontSize = sg.fontSize; } catch (efs) {}
        try { if (sg.tracking != null) cr.tracking = sg.tracking; } catch (etr) {}
        try { cr.font = resolveFont(sg.family, sg.style); } catch (ef) {}
        if (sg.leading != null) { cr.autoLeading = false; cr.leading = sg.leading; }
      }
      idx += len;
    }
    applyFigmaPunctuation(doc, full);
    applyTextStroke(doc, t);
    try { tp.setValue(doc); } catch (esv) { tl.remove(); return null; }
    if (!applied) { tl.remove(); return null; }
    var fillOpacity = t.segs[0].opacity == null ? 1 : t.segs[0].opacity;
    for (k = 1; k < t.segs.length; k++)
      if ((t.segs[k].opacity == null ? 1 : t.segs[k].opacity) !== fillOpacity) { fillOpacity = null; break; }
    if (t.stroke && fillOpacity != null) addStrokeStyle(tl, t.stroke, fillOpacity);
    else { applyTextFillOpacity(tl, t.segs); addStrokeStyle(tl, t.stroke); }
    return tl;
  }

  // Nudge AE to evaluate freshly-created text layers so sourceRectAtTime() returns real
  // sizes in pass 2 (right after addText it often reports 0 / throws). Toggling comp.time
  // and reading each doc forces the render tree to refresh.
  function forceEval(comp, pending) {
    try { var tt = comp.time; comp.time = (tt > 0 ? 0 : Math.min(comp.duration / 2, 1)); comp.time = tt; } catch (e) {}
    for (var i = 0; i < pending.length; i++) {
      try { var v = pending[i].tl.property("ADBE Text Properties").property("ADBE Text Document").value; if (v) {} } catch (e2) {}
    }
  }

  // advance width of a run INCLUDING trailing spaces (sourceRectAtTime trims trailing whitespace)
  function runAdvance(comp, runLayer, seg) {
    var base = 0; try { base = runLayer.sourceRectAtTime(comp.time, false).width; } catch (e) { base = (seg.fontSize || 16) * 0.55 * seg.characters.length; }
    if (/\s$/.test(seg.characters)) {
      try {
        var a = comp.layers.addText(seg.characters + "."); _applyDoc(a, seg, 'LEFT');
        var wA = a.sourceRectAtTime(comp.time, false).width; a.remove();
        var b = comp.layers.addText("."); _applyDoc(b, seg, 'LEFT');
        var wB = b.sourceRectAtTime(comp.time, false).width; b.remove();
        var adv = wA - wB;                 // "...text " advance without the dot's own width
        if (adv > base) base = adv;
      } catch (e2) {}
    }
    return base;
  }

  // rich text: one AE text layer per style run, laid out left->right, then the whole block
  // is aligned to the Figma bbox (top-left, or centre/right) via measured rects.
  function makeRunLayers(comp, t) {
    var segs = t.segs, made = 0, k;
    var maxSize = 0; for (k = 0; k < segs.length; k++) if (segs[k].fontSize > maxSize) maxSize = segs[k].fontSize;
    var provBaseline = t.y + (maxSize || 16) * 0.8;
    var cx = t.x, info = [];
    for (k = 0; k < segs.length; k++) {
      var sg = segs[k];
      if (sg.characters == null || sg.characters === "") continue;
      var runStyle = {}; for (var key in sg) if (sg.hasOwnProperty(key)) runStyle[key] = sg[key];
      runStyle.fillOpacity = sg.opacity; runStyle.opacity = t.opacity;
      var tl = makeOneText(comp, sg.characters, runStyle, cx, provBaseline, 'LEFT', 0);
      if (!tl) continue;
      var r = null; try { r = tl.sourceRectAtTime(comp.time, false); } catch (e) {}
      info.push({ tl: tl, x: cx, r: r });
      cx += runAdvance(comp, tl, sg);
      made++;
    }
    if (info.length) {
      // horizontal: align the block per justification
      var first = info[0], last = info[info.length - 1];
      var leftEdge = first.x + (first.r ? first.r.left : 0);
      var rightEdge = last.x + (last.r ? (last.r.left + last.r.width) : 0);
      var dx;
      if (t.align === 'CENTER') dx = (t.x + (t.w || 0) / 2) - (leftEdge + rightEdge) / 2;
      else if (t.align === 'RIGHT') dx = (t.x + (t.w || 0)) - rightEdge;
      else dx = t.x - leftEdge;
      // vertical: centre the whole run block inside the Figma bbox
      var minTop = 1e9, maxBot = -1e9;
      for (k = 0; k < info.length; k++) if (info[k].r) {
        minTop = Math.min(minTop, provBaseline + info[k].r.top);
        maxBot = Math.max(maxBot, provBaseline + info[k].r.top + info[k].r.height);
      }
      var dy = (minTop < 1e9) ? ((t.y + (t.h || 0) / 2) - (minTop + maxBot) / 2) : 0;
      for (k = 0; k < info.length; k++) {
        var tg = info[k].tl.property("ADBE Transform Group");
        var p = tg.property("ADBE Position").value;
        tg.property("ADBE Position").setValue([p[0] + dx, p[1] + dy, 0]);
      }
    }
    return made;
  }

  // TWO-PASS: create every text layer first, then position — so sourceRectAtTime() has real
  // sizes to work with. (Measuring right after addText inside the same loop returns 0/throws,
  // which was dumping all text into the crude fallback and misplacing the whole scene.)
  function createTextLayers(comp, texts) {
    if (!comp || !(comp instanceof CompItem) || !texts || !texts.length) return 0;
    beginUndo("SVG -> Text");
    var made = 0, pending = [];
    _txtOk = 0; _txtNo = 0;
    try {
      // PASS 1 — create + style, no positioning.
      // Each text is isolated: a single bad node used to throw and abort the whole loop,
      // which is why an entire scene could come in with NO text layers at all.
      var nErr = 0, firstTxtErr = "";
      for (var i = 0; i < texts.length; i++) {
        try {
          var t = texts[i];
          if (t.runs && t.segs && t.segs.length) {
            var rl = createRich(comp, t);
            if (rl) { pending.push({ tl: rl, t: t, box: !!t.box, rich: true }); made++; }
            else { made += makeRunLayers(comp, t); }      // old-AE fallback: fully creates + positions
            continue;
          }
          if (t.characters == null || t.characters === "") continue;
          // Box text MUST be created as box text — otherwise it never wraps, and a centred
          // paragraph sprawls into one long line (that was the "text flies off" case).
          var tl = null, isBox = !!t.box;
          if (isBox) {
            try { tl = comp.layers.addBoxText([t.w || 100, t.h || 100], aeLines(t.characters)); }
            catch (eb) { tl = null; isBox = false; }
          }
          if (!tl) tl = comp.layers.addText(aeLines(t.characters));
          try { _applyDoc(tl, t, t.align); } catch (ed2) { if (!firstTxtErr) firstTxtErr = "doc:" + String(ed2).substr(0, 45); }
          pending.push({ tl: tl, t: t, box: isBox, rich: false });
          made++;
        } catch (eItem) {
          nErr++;
          if (!firstTxtErr) firstTxtErr = String(eItem).substr(0, 55);
        }
      }
      if (nErr || firstTxtErr) _diag.push("TXT skipped " + nErr + "/" + texts.length + (firstTxtErr ? " (" + firstTxtErr + ")" : ""));

      forceEval(comp, pending);                            // make the new layers measurable

      // PASS 2 — position now that layers can be measured
      for (var j = 0; j < pending.length; j++) {
        try {
        var p = pending[j], tt = p.t;
        if (tt.rotation) {
          // rotated text (box or point/rich): centre-anchor + rotate
          var tgr = placeRotated(comp, p.tl, tt);
          var opr = tt.opacity;
          if (opr != null && opr < 1) tgr.property("ADBE Opacity").setValue(opr * 100);
        } else if (p.box && tt.ink) {
          // Wrapped paragraph: match AE's rendered ink to Figma's rendered ink on BOTH axes.
          // Centre-to-centre is alignment-agnostic, so left/centre/right and top/middle
          // vertical settings all land correctly without special-casing each.
          var tgb = p.tl.property("ADBE Transform Group");
          tgb.property("ADBE Anchor Point").setValue([0, 0, 0]);
          var rb = measureRect(comp, p.tl);
          if (rb) _txtOk++; else _txtNo++;
          var pxb = rb ? (tt.ink.x + tt.ink.w / 2 - (rb.left + rb.width / 2)) : tt.x;
          var pyb = rb ? (tt.ink.y + tt.ink.h / 2 - (rb.top + rb.height / 2)) : tt.y;
          tgb.property("ADBE Position").setValue([pxb, pyb, 0]);
          if (tt.opacity != null && tt.opacity < 1) tgb.property("ADBE Opacity").setValue(tt.opacity * 100);
        } else if (p.box) {
          var tgb2 = p.tl.property("ADBE Transform Group");
          tgb2.property("ADBE Anchor Point").setValue([0, 0, 0]);
          tgb2.property("ADBE Position").setValue([tt.x, tt.y, 0]);
          if (tt.opacity != null && tt.opacity < 1) tgb2.property("ADBE Opacity").setValue(tt.opacity * 100);
        } else {
          var tg = positionToBBox(comp, p.tl, tt, tt.align);
          var op = tt.opacity;
          if (op != null && op < 1) tg.property("ADBE Opacity").setValue(op * 100);
        }
        if (tt.name) { try { p.tl.name = tt.name; } catch (enm) {} }   // keep Figma's layer name
        applyBlend(p.tl, tt.blend);
        p.tl = scaleStrokeLayer(p.tl, tt.stroke);
        // Track BEFORE the decoration: a gradient fill turns this very layer into a matte, and
        // pairMatte has to find the record that already exists to re-tag it.
        var textMatte = applyNodeMask(p.tl, tt);
        trackLayer(p.tl, tt.path, tt.z, textMatte);
        if (textMatte) trackLayer(textMatte, tt.path, tt.z, null, true);
        applyTextDecor(comp, p.tl, tt);   // drop shadow / blur / gradient overlay on the text layer
        // Hidden in Figma (its own eye or a parent's) -> hidden here too.
        if (tt.hidden) { try { p.tl.enabled = false; } catch (ehd) {} }
        } catch (ePos) { _diag.push("TXTpos:" + String(ePos).substr(0, 40)); }
      }
    } finally { endUndo(); }
    return made;
  }

  // ---- IMAGES: real footage + a shape track matte when the picture is cropped ----
  function copyGradeControlsToPlacement(placement, grade) {
    // AE only exposes slider display ranges through the UI. Copy the already
    // configured stock effects from the grade, keeping the new placement's
    // native anchor, timing and stack position.
    var comp = placement.containingComp;
    grade.layer('Figma 设计值').copyToComp(comp);
    var layer = comp.layer(1);
    layer.property('ADBE Effect Parade').property('ADBE Apply Color LUT2').remove();
    layer.opacity.expression = '';
    layer.opacity.setValue(100);
    layer.replaceSource(placement.source, false);
    layer.anchorPoint.setValue(placement.anchorPoint.value);
    layer.position.setValue(placement.position.value);
    layer.startTime = placement.startTime;
    layer.inPoint = placement.inPoint;
    layer.outPoint = placement.outPoint;
    layer.moveBefore(placement);
    placement.remove();
    return layer;
  }

  function bindImageGradeControls(layer, filters, publishComp) {
    var keys = ['exposure','contrast','saturation','temperature','tint','highlights','shadows'];
    var labels = ['曝光','对比度','饱和度','白平衡','着色','高光','阴影'];
    for (var i = 0; i < keys.length; i++) {
      var label = labels[i], input = '输入 · ' + label;
      var fx = layer.property('ADBE Effect Parade').property(label);
      var slider = fx.property(1);
      slider.setValue((filters[keys[i]] || 0) * 100);
      slider.expression = 'clamp(value, -100, 100);';
      layer.essentialProperty.property(input).expression =
        'var control = thisLayer.effect("' + label + '");\ncontrol.active ? control(1).value : 0;';
      if (publishComp && !slider.addToMotionGraphicsTemplateAs(publishComp, input))
        throw new Error('无法连接图片调色属性 ' + label);
    }
  }

  function createImageFootage(comp, im, folder, gradeSource) {
    // ExtendScript decodes URI escapes even when given a filesystem path.
    var f = new File(File.encode(folder + "/" + im.file));
    if (!f.exists) throw new Error("IMG missing " + im.file);

    // Reuse footage the project already holds for this exact file — importing the same
    // picture again on every run piled up duplicates in the project panel.
    var item = gradeSource || null;
    if (!item) try {
      for (var pi = 1; pi <= app.project.numItems; pi++) {
        var it = app.project.item(pi);
        if (it instanceof FootageItem && it.mainSource && it.mainSource.file &&
            it.mainSource.file.fsName === f.fsName) { item = it; break; }
      }
    } catch (eScan) {}
    if (!item) item = app.project.importFile(new ImportOptions(f));
    var lyr = comp.layers.add(item);
    if (gradeSource) lyr = copyGradeControlsToPlacement(lyr, gradeSource);
    lyr.name = im.name || "Image";

    // Fit the footage to the Figma box. FIT keeps it inside; everything else (FILL,
    // CROP, TILE) covers the box and the overflow is hidden by the matte.
    // Use the node's OWN size/centre (cw/ch/cx/cy) — the bounding box is axis-aligned and
    // therefore too big for a rotated picture, which skewed both the fit and the crop.
    var fw = (im.cw != null ? im.cw : im.w), fh = (im.ch != null ? im.ch : im.h);
    var fx0 = (im.cx != null ? im.cx : im.x + im.w / 2), fy0 = (im.cy != null ? im.cy : im.y + im.h / 2);
    var nw = im.natW || item.width || 1, nh = im.natH || item.height || 1;
    var sx = fw / nw, sy = fh / nh;
    // Baked PNGs already carry the Figma scale. Integer pixel padding must not resize them.
    var sc = im.rasterScale ? 1 / im.rasterScale : (im.scaleMode === 'FIT') ? Math.min(sx, sy) : Math.max(sx, sy);
    var tg = lyr.property("ADBE Transform Group");
    tg.property("ADBE Anchor Point").setValue([gradeSource ? item.width / 2 : nw / 2, gradeSource ? item.height / 2 : nh / 2, 0]);
    tg.property("ADBE Position").setValue([fx0, fy0, 0]);
    tg.property("ADBE Scale").setValue([sc * 100, sc * 100, 100]);
    if (im.rotation) { try { tg.property("ADBE Rotate Z").setValue(im.rotation); } catch (er) {} }
    if (im.imageMatrix) {
      var m = im.imageMatrix, a = m[0] / nw, b = m[1] / nw, c = m[2] / nh, d = m[3] / nh;
      var scaleX = Math.sqrt(a * a + b * b), scaleY = (a * d - b * c) / scaleX;
      if (Math.abs(a * c + b * d) > 0.00001 * Math.max(scaleX * Math.abs(scaleY), 0.00000001))
        throw new Error('暂不支持该图片裁剪倾斜');
      tg.property("ADBE Scale").setValue([scaleX * 100, scaleY * 100, 100]);
      tg.property("ADBE Rotate Z").setValue(Math.atan2(b, a) * 180 / Math.PI);
      tg.property("ADBE Position").setValue([m[4] + (m[0] + m[2]) / 2, m[5] + (m[1] + m[3]) / 2, 0]);
    }
    if (im.opacity != null && im.opacity < 1) tg.property("ADBE Opacity").setValue(im.opacity * 100);

    var mt = null;
    if (im.matte) {
      mt = comp.layers.addShape();
      mt.name = (im.name || "Image") + " matte";
      var contents = mt.property("ADBE Root Vectors Group");
      var grp = contents.addProperty("ADBE Vector Group");
      grp.name = "Crop";
      var gc = grp.property("ADBE Vectors Group");
      // Build the crop shape around the ORIGIN, then rotate/position the whole layer —
      // that way the matte turns with the picture instead of staying axis-aligned.
      if (im.matte.kind === 'ellipse') {
        var el = gc.addProperty("ADBE Vector Shape - Ellipse");
        el.property("ADBE Vector Ellipse Size").setValue([fw, fh]);
        el.property("ADBE Vector Ellipse Position").setValue([0, 0]);
      } else {
        var rc = gc.addProperty("ADBE Vector Shape - Rect");
        rc.property("ADBE Vector Rect Size").setValue([fw, fh]);
        rc.property("ADBE Vector Rect Position").setValue([0, 0]);
        if (im.matte.r) rc.property("ADBE Vector Rect Roundness").setValue(im.matte.r);
      }
      var fl = gc.addProperty("ADBE Vector Graphic - Fill");
      fl.property("ADBE Vector Fill Color").setValue([1, 1, 1, 1]);
      var mtg = mt.property("ADBE Transform Group");
      mtg.property("ADBE Anchor Point").setValue([0, 0, 0]);
      mtg.property("ADBE Position").setValue([fx0, fy0, 0]);
      if (im.rotation) { try { mtg.property("ADBE Rotate Z").setValue(im.rotation); } catch (er2) {} }
      mt.moveBefore(lyr);                       // a matte must sit directly above
      try { lyr.setTrackMatte(mt, TrackMatteType.ALPHA); }   // AE 23+
      catch (e1) { try { lyr.trackMatteType = TrackMatteType.ALPHA; } catch (e2) {} }
      mt.enabled = false;                       // matte layers render off, as usual
    }
    // Two different masks cannot share one AE track-matte slot. More importantly, a crop
    // matte must never be separated from its footage by a later group precompose. Pack the
    // pair into its own small comp immediately; the Figma mask (if any) can then be applied
    // to this precomp on the outside.
    if (mt) {
      try {
        var cropIndices = [mt.index, lyr.index];
        var cropComp = comp.layers.precompose(cropIndices, (im.name || "Image") + " crop", true);
        if (gradeSource) {
          for (var ci = 1; ci <= cropComp.numLayers; ci++) {
            if (cropComp.layer(ci).source === gradeSource) {
              bindImageGradeControls(cropComp.layer(ci), im.imageFilters, cropComp);
              break;
            }
          }
        }
        var cropLayer = null;
        for (var cp = 1; cp <= comp.numLayers; cp++) {
          if (comp.layer(cp).source === cropComp) { cropLayer = comp.layer(cp); break; }
        }
        if (!cropLayer) throw new Error("crop precomp layer not found");
        lyr = gradeSource ? copyGradeControlsToPlacement(cropLayer, gradeSource) : cropLayer;
        lyr.name = im.name || "Image";
        mt = null;
      } catch (eipc) { throw new Error("IMG crop precomp: " + String(eipc)); }
    }
    if (gradeSource) bindImageGradeControls(lyr, im.imageFilters);
    return lyr;
  }

  function buildImages(comp, images, folder) {
    if (!comp || !(comp instanceof CompItem) || !images || !images.length) return 0;
    registerImageMasks(images, folder);
    var made = 0;
    beginUndo("Figma -> Images");
    try {
      var gradeSources = {}, gradeProject, missingGrades = 0;
      for (var gi = 0; gi < images.length; gi++) {
        if (images[gi].gradeProject && gradeSources[images[gi].gradeComp] === undefined) {
          gradeProject = images[gi].gradeProject;
          gradeSources[images[gi].gradeComp] = null;
          missingGrades++;
        }
      }
      // Reusing a prepared source also keeps one owner for its expression links.
      function indexGrades(items) {
        for (var j = 1; j <= items.numItems && missingGrades; j++) {
          var child = items.item(j);
          if (child instanceof CompItem && gradeSources[child.name] === null) {
            gradeSources[child.name] = child;
            missingGrades--;
          }
        }
      }
      if (missingGrades) indexGrades(app.project);
      if (missingGrades) {
        app.project.importFile(new ImportOptions(new File(File.encode(gradeProject))));
        indexGrades(app.project);
      }
      for (var i = 0; i < images.length; i++) {
        try {
          var im = images[i];
          if (im.maskSource) { made++; continue; }
          if (im.gradeComp && !gradeSources[im.gradeComp]) throw Error("找不到图片调色合成");
          var lyr = createImageFootage(comp, im, folder, im.gradeComp && gradeSources[im.gradeComp]);
          // References stay outside the artwork hierarchy and never consume image slots.
          if (im.reference) {
            lyr.enabled = false; lyr.moveToBeginning(); _referenceLayers.push(lyr);
            made++; continue;
          }

          var mt = null, slotZ = null;
          // Put the footage back where it belongs in the stack: find the placeholder left by
          // the SVG pass (matched on centre) and move the layer(s) there.
          if (!im.shadow && !im.mergedBlend) {
          try {
            var icx = (im.cx != null ? im.cx : im.x + im.w / 2);
            var icy = (im.cy != null ? im.cy : im.y + im.h / 2);
            var best = -1, bestD = 1e9;
            for (var si = 0; si < _imgSlots.length; si++) {
              var sl = _imgSlots[si];
              if (!sl || sl.used) continue;
              var sb = sl.bb;
              var d = Math.abs((sb.x + sb.w / 2) - icx) + Math.abs((sb.y + sb.h / 2) - icy);
              if (d < bestD) { bestD = d; best = si; }
            }
            if (best >= 0 && bestD < Math.max(40, (im.w + im.h) * 0.5)) {
              var slot = _imgSlots[best];
              slotZ = slot.z;                     // the placeholder already knew the paint order
              var topLayer = (im.matte && mt) ? mt : lyr;      // keep matte directly above
              topLayer.moveBefore(slot.lyr);
              if (im.matte && mt) lyr.moveAfter(mt);
              if (slot.blur) addBlur(lyr, slot.blur);
              slot.used = true;
              try { slot.lyr.remove(); } catch (erm) {}
            }
          } catch (ez) { _diag.push("IMGz:" + String(ez).substr(0, 30)); }
          }
          applyBlend(lyr, im.blend);
          // A Figma mask mattes footage directly; the crop+mask case was nested just above.
          var nodeMatte = null;
          if (im.maskId && !mt) nodeMatte = applyNodeMask(lyr, { maskId: im.maskId, name: im.name });
          else if (im.maskId && mt) _diag.push("IMG mask+crop nesting failed " + (im.name || ""));
          // Fall back to the slot's paint index: the placeholder sat in the right place already.
          var imz = (im.z != null) ? im.z : (slotZ != null ? slotZ : 0);
          if (mt) _mattePairs.push({ lyr: lyr, mt: mt });
          trackLayer(lyr, im.path, imz, nodeMatte || mt, false, im.external);
          if (mt) trackLayer(mt, im.path, im.z, null, true);   // rides with its footage
          if (nodeMatte) trackLayer(nodeMatte, im.path, imz, null, true);
          if (im.hidden) { try { lyr.enabled = false; } catch (ehi) {} }
          made++;
        } catch (eImg) { _diag.push("IMG:" + String(eImg).substr(0, 40)); }
      }
    } finally { endUndo(); }
    return made;
  }

  return { withUndo: withUndo, build: build, buildText: createTextLayers, buildImages: buildImages, organize: organize,
    // Flat imports need the same z correction as precomposed ones, but without building groups.
    restack: function (comp) { restackByZ(); relinkMattes(); refreshTextSkewPivots(comp); verifyStack(comp); placeReferences(comp); },
    getDiag: function () {
    var d = _diag.slice(0);
    if (_txtOk + _txtNo > 0) d.push("TXT measured " + _txtOk + "/" + (_txtOk + _txtNo));
    if (_fontMissList.length) d.push("fonts substituted: " + _fontMissList.join(", ") + " (install to restore typeface)");
    return d.join(" || ");
  } };
})();
