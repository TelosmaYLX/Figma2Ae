// AE Motion 2.26.0 (42e14e8350473ea4b246f0b4aa20f250fe168dd6), MIT.
// Only the four preset commands and their ExtendScript helpers are included.
var C = {};
// host/core/util.ts
// Small helpers used everywhere: errors, argument checks, arrays, time snapping.
var EPS = 1e-6;
// Throw a structured error; dispatch() turns it into {ok:false, error:{code,message,hint}}.
// code is one of NOT_FOUND, BAD_ARGS, AE_ERROR, UNSUPPORTED, EXISTS (see src/errors.ts).
function fail(code, message, hint) { throw { aem: true, code: code, message: message, hint: hint || "" }; }
// A type guard, so if (has(a, "time")) lets the code use a.time as a number; k must be one of o's fields.
function has(o, k) { return o[k] !== undefined && o[k] !== null; }
function need(a, names) {
    for (var i = 0; i < names.length; i++)
        if (!has(a, names[i]))
            fail("BAD_ARGS", "Missing argument: " + names[i]);
}
// Run fn and return its result, or undefined if it throws (for optional DOM reads that differ between versions).
function safe(fn) { try {
    return fn();
}
catch (e) {
    return undefined;
} }
// After Effects returns array-like values; copy them into plain arrays so they serialize.
function copyArr(v) { var o = [], i; for (i = 0; i < v.length; i++)
    o.push(v[i]); return o; }
// Colors arrive as [r,g,b] (0-1); After Effects color properties want [r,g,b,a].
function rgba(c) { return c.length === 3 ? [c[0], c[1], c[2], 1] : c; }
// Snap a time to the nearest whole frame of comp.
function snapT(comp, t) { var fd = comp.frameDuration; return Math.round(t / fd) * fd; }
// host/core/timing.ts
// Setting inPoint also moves outPoint (the layer keeps its length), so put outPoint back. Never assign inPoint directly.
function setIn(l, t) {
    var o = l.outPoint;
    l.inPoint = t;
    if (Math.abs(l.outPoint - o) > 1e-6)
        l.outPoint = o;
}
// host/core/lookup.ts
// Find project items, layers and properties from the ids and paths the MCP tools send.
var ALIAS = {
    position: ["ADBE Transform Group", "ADBE Position"],
    scale: ["ADBE Transform Group", "ADBE Scale"],
    rotation: ["ADBE Transform Group", "ADBE Rotate Z"],
    opacity: ["ADBE Transform Group", "ADBE Opacity"],
    anchor: ["ADBE Transform Group", "ADBE Anchor Point"],
    // after set_layer separate_dimensions: true
    x_position: ["ADBE Transform Group", "ADBE Position_0"],
    y_position: ["ADBE Transform Group", "ADBE Position_1"],
    z_position: ["ADBE Transform Group", "ADBE Position_2"],
    // audio levels in dB, [left, right] (a single number sets both: coerce)
    volume: ["ADBE Audio Group", "ADBE Audio Levels"]
};
function getItem(id) {
    var it = null;
    try {
        it = app.project.itemByID(id);
    }
    catch (e) { }
    if (!it)
        fail("NOT_FOUND", "Item id " + id + " not found", "Use get_project");
    return it;
}
function getComp(id) {
    var it = getItem(id);
    if (!(it instanceof CompItem))
        fail("BAD_ARGS", "Item " + id + " is not a composition", "get_project with type: comp lists the comp ids");
    return it;
}
// Layer ids and project.layerByID both arrived in After Effects 22.0, the minimum version in the manifest.
// Typed AVLayer, the kind nearly every command works with: camera and light layers lack its properties, and the code
// that may meet them checks instanceof CameraLayer / LightLayer or reads those properties through safe().
function getLayer(id) {
    var l = null;
    try {
        l = app.project.layerByID(id);
    }
    catch (e) { }
    if (!l)
        fail("NOT_FOUND", "Layer id " + id + " not found", "Use get_comp to list layer ids");
    return l;
}
// path: an ALIAS name, a single match name, or an array of match names / 1-based indexes.
// T: what the path leads to (a property unless the caller says otherwise, e.g. resolvePath<PropertyGroup>).
function resolvePath(layer, path) {
    if (typeof path === "string")
        path = ALIAS[path] ? ALIAS[path] : [path];
    if (!(path instanceof Array) || !path.length)
        fail("BAD_ARGS", "path must be an alias or a non-empty array of match names");
    var p = layer, i, nxt;
    for (i = 0; i < path.length; i++) {
        nxt = null;
        try {
            nxt = p.property(path[i]);
        }
        catch (e) {
            nxt = null;
        }
        if (!nxt)
            fail("NOT_FOUND", "Property not found at '" + path[i] + "'", "Use list_properties to see valid match names");
        p = nxt;
    }
    return p;
}
// Look up several layers; with comp, every layer must belong to it.
function pickLayers(ids, comp) {
    var out = [], i, l;
    if (!(ids instanceof Array) || !ids.length)
        fail("BAD_ARGS", "layer_ids must be a non-empty array");
    for (i = 0; i < ids.length; i++) {
        l = getLayer(ids[i]);
        if (comp && l.containingComp.id !== comp.id)
            fail("BAD_ARGS", "Layer " + ids[i] + " is not in comp " + comp.id, "get_comp lists the comp's layers");
        out.push(l);
    }
    return out;
}
// Return the comp shared by all layers, or fail.
function sameComp(layers) {
    var comp = layers[0].containingComp, i;
    for (i = 1; i < layers.length; i++)
        if (layers[i].containingComp.id !== comp.id)
            fail("BAD_ARGS", "All layers must be in the same composition", "Make one call per comp");
    return comp;
}
function assertUnlocked(layers) {
    var i;
    for (i = 0; i < layers.length; i++)
        if (layers[i].locked)
            fail("BAD_ARGS", "Layer " + layers[i].id + " is locked", "Unlock it with set_layer locked:false");
}
// Shorthand for a layer's transform property by match name.
function tp(l, match) { return l.property("ADBE Transform Group").property(match); }
// host/core/shapes.ts
function zeros(n) { var o = [], i; for (i = 0; i < n; i++)
    o.push([0, 0]); return o; }
// Build a Shape from vertices with optional tangents (default: straight segments). Closed unless closed === false.
function mkShape(v, it, ot, closed) {
    if (!(v instanceof Array) || v.length < 2)
        fail("BAD_ARGS", "A path needs at least 2 vertices");
    var s = new Shape();
    s.vertices = v;
    s.inTangents = it && it.length === v.length ? it : zeros(v.length);
    s.outTangents = ot && ot.length === v.length ? ot : zeros(v.length);
    s.closed = closed !== false;
    return s;
}
// A rect or ellipse as a 4-vertex bezier path centered on (cx, cy), vertices clockwise from the top-left.
// The ellipse's vertices sit on the diagonals, matching the rect's corners, so rect <-> ellipse keyframes
// morph without twisting (a 4-point bezier circle is equally accurate at any rotation).
function boxShape(type, cx, cy, w, h) {
    var rx = w / 2, ry = h / 2, k = 0.5522847498, v = [], it = [], ot = [], i, a, c, s; // k: bezier circle constant
    if (type === "ellipse") {
        for (i = 0; i < 4; i++) {
            a = (i * 90 - 135) * Math.PI / 180;
            c = Math.cos(a);
            s = Math.sin(a); // -135 = top-left (y down)
            v.push([cx + rx * c, cy + ry * s]);
            ot.push([-k * rx * s, k * ry * c]);
            it.push([k * rx * s, -k * ry * c]);
        }
        return mkShape(v, it, ot, true);
    }
    return mkShape([[cx - rx, cy - ry], [cx + rx, cy - ry], [cx + rx, cy + ry], [cx - rx, cy + ry]], null, null, true);
}
var LINE_CAPS = { butt: 1, round: 2, square: 3 };
var LINE_JOINS = { miter: 1, round: 2, bevel: 3 };
// Check a shape spec's stroke options before anything is created (add_layer calls it before adding the layer).
function checkShapeSpec(s) {
    if (has(s, "line_cap") && !LINE_CAPS[s.line_cap])
        fail("BAD_ARGS", "line_cap must be butt, round or square");
    if (has(s, "line_join") && !LINE_JOINS[s.line_join])
        fail("BAD_ARGS", "line_join must be miter, round or bevel");
    if (has(s, "dashes") && (!(s.dashes instanceof Array) || s.dashes.length < 1 || s.dashes.length > 6))
        fail("BAD_ARGS", "dashes must be 1 to 6 numbers: dash, gap, dash, gap and so on");
    if ((has(s, "dashes") || has(s, "line_cap") || has(s, "line_join") || has(s, "stroke_width") || has(s, "stroke_opacity")) && !s.stroke)
        fail("BAD_ARGS", "Stroke options need a stroke color", "Add stroke_color (and stroke_width)");
}
// Add one shape group (rect | ellipse | star | polygon | path) with optional fill and stroke to a shape layer and
// return the group. Stroke extras: stroke_opacity, dashes [dash, gap, dash, gap] (up to 3 pairs), line_cap, line_join.
// Group extras: name, position (offset inside the layer), rotation, opacity; fill_opacity.
// Property groups are reached by match name; "any" because what property() returns depends on the name.
function addShapeContent(l, s) {
    var root, grp, g, sh, f, st, d, i, tg;
    checkShapeSpec(s);
    root = l.property("ADBE Root Vectors Group");
    grp = root.addProperty("ADBE Vector Group");
    g = grp.property("ADBE Vectors Group");
    if (s.name)
        grp.name = s.name;
    if (s.type === "star" || s.type === "polygon") {
        sh = g.addProperty("ADBE Vector Shape - Star");
        sh.property("ADBE Vector Star Type").setValue(s.type === "star" ? 1 : 2);
        sh.property("ADBE Vector Star Points").setValue(has(s, "points") ? s.points : 5);
        sh.property("ADBE Vector Star Outer Radius").setValue(has(s, "outer_radius") ? s.outer_radius : 100);
        if (s.type === "star")
            sh.property("ADBE Vector Star Inner Radius").setValue(has(s, "inner_radius") ? s.inner_radius : 40);
    }
    else if (s.type === "path") {
        sh = g.addProperty("ADBE Vector Shape - Group");
        sh.property("ADBE Vector Shape").setValue(mkShape(s.vertices, s.in_tangents, s.out_tangents, s.closed));
    }
    else if (s.type === "ellipse") {
        sh = g.addProperty("ADBE Vector Shape - Ellipse");
        sh.property("ADBE Vector Ellipse Size").setValue(s.size || [100, 100]);
    }
    else {
        sh = g.addProperty("ADBE Vector Shape - Rect");
        sh.property("ADBE Vector Rect Size").setValue(s.size || [100, 100]);
        if (s.roundness !== undefined)
            sh.property("ADBE Vector Rect Roundness").setValue(s.roundness);
    }
    if (s.fill) {
        f = g.addProperty("ADBE Vector Graphic - Fill");
        f.property("ADBE Vector Fill Color").setValue(rgba(s.fill));
        if (has(s, "fill_opacity"))
            f.property("ADBE Vector Fill Opacity").setValue(s.fill_opacity);
    }
    if (s.stroke) {
        st = g.addProperty("ADBE Vector Graphic - Stroke");
        st.property("ADBE Vector Stroke Color").setValue(rgba(s.stroke));
        st.property("ADBE Vector Stroke Width").setValue(s.stroke_width || 4);
        if (has(s, "stroke_opacity"))
            st.property("ADBE Vector Stroke Opacity").setValue(s.stroke_opacity);
        if (has(s, "line_cap"))
            st.property("ADBE Vector Stroke Line Cap").setValue(LINE_CAPS[s.line_cap]);
        if (has(s, "line_join"))
            st.property("ADBE Vector Stroke Line Join").setValue(LINE_JOINS[s.line_join]);
        if (has(s, "dashes")) {
            // adding "Dash n" / "Gap n" activates that pair; After Effects lists all three pairs but only renders active ones
            d = st.property("ADBE Vector Stroke Dashes");
            for (i = 0; i < s.dashes.length; i++)
                d.addProperty("ADBE Vector Stroke " + (i % 2 ? "Gap " : "Dash ") + (Math.floor(i / 2) + 1)).setValue(s.dashes[i]);
        }
    }
    tg = grp.property("ADBE Vector Transform Group");
    if (has(s, "position"))
        tg.property("ADBE Vector Position").setValue([s.position[0], s.position[1]]);
    if (has(s, "rotation"))
        tg.property("ADBE Vector Rotation").setValue(s.rotation);
    if (has(s, "opacity"))
        tg.property("ADBE Vector Group Opacity").setValue(s.opacity);
    return grp;
}
// host/core/keys.ts
// ---------- springs ----------
// A spring (or bounce) segment runs from a key to the next one as a closed-form step response, in one expression
// per property marked // ae-motion spring; its S list names the sprung segments by their first key's time. Values
// are pure functions of time, the keys stay linear, and other segments keep their own easing.
var SPRING_TAG = "// ae-motion spring";
// Step responses: x(u) = 1 - e^(-a u) cos(b u), normalised so x(1) = 1. spring overshoots about 13 % once and
// settles; bounce folds the cosine (|.|) so the value hits the target and bounces back off it, like a dropped object
// (b = 4.5 pi puts cos(b) = 0 at the end, so it lands exactly and never passes the target).
var SPRINGS = { spring: [6, 9.42, 0], bounce: [5, 14.137, 1] };
// The expression a spring property carries; S lists the springy segments as [start time, a, b, fold].
function springExpr(S) {
    return SPRING_TAG + "\nvar S=" + JSON.stringify(S) + ";\n" +
        "var n=0,y=value;\n" +
        "if(numKeys>1){n=nearestKey(time).index;if(key(n).time>time)n--;}\n" +
        "if(n>=1&&n<numKeys){var t0=key(n).time,t1=key(n+1).time,j,m=-1;\n" +
        "for(j=0;j<S.length;j++)if(Math.abs(S[j][0]-t0)<0.001)m=j;\n" +
        "if(m>=0){var a=S[m][1],b=S[m][2],u=(time-t0)/(t1-t0),e=Math.exp(-a*u)*Math.cos(b*u),E=Math.exp(-a)*Math.cos(b);\n" +
        "if(S[m][3]){e=Math.abs(e);E=Math.abs(E);}\n" +
        "y=add(key(n).value,mul(sub(key(n+1).value,key(n).value),(1-e)/(1-E)));}}\ny";
}
// The spring segments already on p (from its expression), or null if p has some other expression.
function springList(p) {
    var m;
    if (!p.expressionEnabled || !p.expression)
        return [];
    if (p.expression.indexOf(SPRING_TAG) !== 0)
        return null;
    m = /var S=(\[.*\]);/.exec(p.expression);
    return m ? JSON.parse(m[1]) : [];
}
function addSpring(p, t0, kind) {
    var S = springList(p) || [], out = [], i, sp = SPRINGS[kind];
    for (i = 0; i < S.length; i++)
        if (Math.abs(S[i][0] - t0) >= 0.001)
            out.push(S[i]);
    out.push([Math.round(t0 * 1e6) / 1e6, sp[0], sp[1], sp[2]]);
    out.sort(function (x, y) { return x[0] - y[0]; });
    p.expression = springExpr(out);
}
// Stop the segment starting at t0 from springing (the expression goes when no segment is left).
function removeSpring(p, t0) {
    var S = springList(p), out = [], i;
    if (!S || !S.length)
        return;
    for (i = 0; i < S.length; i++)
        if (Math.abs(S[i][0] - t0) >= 0.001)
            out.push(S[i]);
    p.expression = out.length ? springExpr(out) : "";
}
// "spring" / "bounce" if the segment starting at t0 springs, else "".
function springAt(p, t0) {
    var S = springList(p), i;
    for (i = 0; S && i < S.length; i++)
        if (Math.abs(S[i][0] - t0) < 0.001)
            return S[i][3] ? "bounce" : "spring";
    return "";
}
// "easy" (After Effects' Easy Ease) or {speed, influence}.
function mkEase(spec) {
    if (spec === "easy")
        return new KeyframeEase(0, 33.333333);
    var inf = spec.influence === undefined ? 33.333333 : spec.influence;
    inf = Math.max(0.1, Math.min(100, inf));
    return new KeyframeEase(spec.speed === undefined ? 0 : spec.speed, inf);
}
// Apply a key spec's interp / ease_in / ease_out to the key at idx. Easing implies bezier.
function applyKeyMeta(prop, idx, k) {
    var interp = k.interp, typ, dims, inE, outE, e, d;
    if (SPRINGS[interp]) {
        if (springList(prop) === null)
            fail("BAD_ARGS", "interp " + interp + " needs the property's expression slot, which holds another expression", "Clear it with set_expression and an empty expression");
        prop.setInterpolationTypeAtKey(idx, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
        if (idx < prop.numKeys)
            prop.setInterpolationTypeAtKey(idx + 1, prop.keyInInterpolationType(idx + 1) === KeyframeInterpolationType.HOLD ? KeyframeInterpolationType.HOLD : KeyframeInterpolationType.LINEAR, prop.keyOutInterpolationType(idx + 1));
        addSpring(prop, prop.keyTime(idx), interp);
        return;
    }
    if (interp && springAt(prop, prop.keyTime(idx)))
        removeSpring(prop, prop.keyTime(idx));
    if ((k.ease_in || k.ease_out) && !interp)
        interp = "bezier";
    if (interp) {
        typ = interp === "linear" ? KeyframeInterpolationType.LINEAR : (interp === "hold" ? KeyframeInterpolationType.HOLD : KeyframeInterpolationType.BEZIER);
        prop.setInterpolationTypeAtKey(idx, typ, typ);
    }
    if (k.ease_in || k.ease_out) {
        // spatial properties take one ease; other multi-dimensional properties take one per dimension
        dims = prop.isSpatial ? 1 : (prop.value instanceof Array ? prop.value.length : 1);
        inE = prop.keyInTemporalEase(idx);
        outE = prop.keyOutTemporalEase(idx);
        if (k.ease_in) {
            e = mkEase(k.ease_in);
            inE = [];
            for (d = 0; d < dims; d++)
                inE.push(e);
        }
        if (k.ease_out) {
            e = mkEase(k.ease_out);
            outE = [];
            for (d = 0; d < dims; d++)
                outE.push(e);
        }
        prop.setTemporalEaseAtKey(idx, inE, outE);
    }
    // the end of a sprung segment stays linear coming in (the spring shapes that side)
    if ((interp || k.ease_in || k.ease_out) && idx > 1 && springAt(prop, prop.keyTime(idx - 1)))
        prop.setInterpolationTypeAtKey(idx, KeyframeInterpolationType.LINEAR, prop.keyOutInterpolationType(idx));
}
// ---------- full-fidelity key snapshots ----------
// A snapshot holds everything about a key: value, interpolation, temporal ease and continuity, and for spatial
// properties the motion-path tangents, auto-bezier, continuity and roving. Each read and write is guarded because
// not every property type supports every attribute.
function snapKey(p, i) {
    var k = { t: p.keyTime(i), v: p.keyValue(i) };
    try {
        k.ii = p.keyInInterpolationType(i);
        k.oi = p.keyOutInterpolationType(i);
    }
    catch (e1) { }
    try {
        k.ie = p.keyInTemporalEase(i);
        k.oe = p.keyOutTemporalEase(i);
    }
    catch (e2) { }
    try {
        k.tc = p.keyTemporalContinuous(i);
        k.ta = p.keyTemporalAutoBezier(i);
    }
    catch (e3) { }
    if (p.isSpatial) {
        try {
            k.si = p.keyInSpatialTangent(i);
            k.so = p.keyOutSpatialTangent(i);
        }
        catch (e4) { }
        try {
            k.sc = p.keySpatialContinuous(i);
            k.sa = p.keySpatialAutoBezier(i);
        }
        catch (e5) { }
        try {
            k.rov = p.keyRoving(i);
        }
        catch (e6) { }
    }
    return k;
}
function snapAll(p) { var out = [], i; for (i = 1; i <= p.numKeys; i++)
    out.push(snapKey(p, i)); return out; }
// Apply a snapshot's settings (not its value or time) to key idx. Roving is applied separately (restoreRoving),
// after every key exists, because After Effects only allows it between other keys.
// Ease goes before the interpolation type: setting an ease switches a linear key to bezier.
function restoreKey(p, idx, k) {
    if (k.ie) {
        try {
            p.setTemporalEaseAtKey(idx, k.ie, k.oe);
        }
        catch (e2) { }
    }
    if (k.ii !== undefined) {
        try {
            p.setInterpolationTypeAtKey(idx, k.ii, k.oi);
        }
        catch (e1) { }
    }
    if (k.tc !== undefined) {
        try {
            p.setTemporalContinuousAtKey(idx, k.tc);
            p.setTemporalAutoBezierAtKey(idx, k.ta);
        }
        catch (e3) { }
    }
    if (p.isSpatial) {
        if (k.sc !== undefined) {
            try {
                p.setSpatialContinuousAtKey(idx, k.sc);
                p.setSpatialAutoBezierAtKey(idx, k.sa);
            }
            catch (e4) { }
        }
        // explicit tangents only when the key was not auto-bezier (setting tangents switches auto-bezier off)
        if (k.si && !k.sa) {
            try {
                p.setSpatialTangentsAtKey(idx, k.si, k.so);
            }
            catch (e5) { }
        }
    }
}
function restoreRoving(p, idx, k) {
    if (k.rov) {
        try {
            p.setRovingAtKey(idx, true);
        }
        catch (e) { }
    }
}
// Make keys the only keys on p, moved by dt seconds, with all their settings. New keys are added before old ones
// are removed, because removing every key switches some properties off (time remapping).
function replaceKeys(p, keys, dt) {
    var oldT = [], i, j, same, ix, idx = [];
    // roving keys re-time themselves whenever other keys change, so pin them first or they cannot be found again
    if (p.isSpatial)
        for (i = 1; i <= p.numKeys; i++) {
            try {
                if (p.keyRoving(i))
                    p.setRovingAtKey(i, false);
            }
            catch (e) { }
        }
    for (i = 1; i <= p.numKeys; i++)
        oldT.push(p.keyTime(i));
    for (i = 0; i < keys.length; i++)
        p.setValueAtTime(keys[i].t + dt, keys[i].v);
    for (j = 0; j < oldT.length; j++) {
        same = false;
        for (i = 0; i < keys.length; i++)
            if (Math.abs(keys[i].t + dt - oldT[j]) < 0.0001)
                same = true;
        if (same)
            continue;
        ix = p.nearestKeyIndex(oldT[j]);
        if (Math.abs(p.keyTime(ix) - oldT[j]) < 0.0001)
            p.removeKey(ix);
    }
    for (i = 0; i < keys.length; i++) {
        idx.push(p.nearestKeyIndex(keys[i].t + dt));
        restoreKey(p, idx[i], keys[i]);
    }
    for (i = 0; i < keys.length; i++)
        restoreRoving(p, idx[i], keys[i]);
}
// Move every key on p by dt seconds, keeping all key settings.
function shiftKeys(p, dt) { replaceKeys(p, snapAll(p), dt); }
function clearKeysBetween(p, t0, t1) {
    var i;
    for (i = p.numKeys; i >= 1; i--)
        if (p.keyTime(i) >= t0 - EPS && p.keyTime(i) <= t1 + EPS)
            p.removeKey(i);
}
// host/core/describe.ts
// What tools that change layers return: enough to address the layer again (get_layer has the rest).
function layerRef(l) { return { id: l.id, index: l.index, name: l.name }; }
// layerRef plus timing, for the timeline tools.
function layerTiming(l) {
    var o = layerRef(l), st = safe(function () { return l.stretch; });
    o["in"] = l.inPoint;
    o.out = l.outPoint;
    o.start = l.startTime;
    if (st !== undefined && st !== 100)
        o.stretch = st;
    return o;
}
// host/commands/motion.ts
var REVEAL_TAG = "// ae-motion reveal";
var MOVES = { fade: 1, pop: 1, grow: 1, slide: 1, drop: 1, spin: 1, push: 1, drift: 1 };
// Moves that keep a layer alive through a hold instead of bringing it in or out: a slow scale push-in, or a slow
// float in a direction. They start where the layer's animation ends and run to its out point unless told otherwise.
var CONTINUOUS = { push: 1, drift: 1 };
var MOVE_STYLES = { snappy: 1, smooth: 1, spring: 1, bounce: 1, linear: 1 };
// One side of a key: "linear", or bezier with speed 0 and the given influence.
function keySide(p, idx, side, influence) {
    var dims = p.isSpatial ? 1 : (p.value instanceof Array ? p.value.length : 1), inE = p.keyInTemporalEase(idx), outE = p.keyOutTemporalEase(idx), inT = p.keyInInterpolationType(idx), outT = p.keyOutInterpolationType(idx), e = [], d, B = KeyframeInterpolationType.BEZIER, L = KeyframeInterpolationType.LINEAR;
    if (influence !== null) {
        for (d = 0; d < dims; d++)
            e.push(new KeyframeEase(0, influence));
        if (side === "in")
            inE = e;
        else
            outE = e;
        p.setTemporalEaseAtKey(idx, inE, outE); // switches the key to bezier: set the interpolation types after
    }
    if (side === "in")
        inT = influence === null ? L : B;
    else
        outT = influence === null ? L : B;
    p.setInterpolationTypeAtKey(idx, inT, outT);
}
// Curve of the segment from key i0 to key i1. Entrances decelerate (snappy: fast start, long settle), exits
// accelerate, smooth eases both ends. Springs keep linear keys: the expression shapes the motion.
function shapeSegment(p, i0, i1, curve) {
    var c = { snappy: [null, 85], smooth: [70, 70], accelerate: [85, null], linear: [null, null] }[curve] || [70, 70];
    keySide(p, i0, "out", c[0]);
    keySide(p, i1, "in", c[1]);
}
// The property a move animates; position is split into x / y when its dimensions are separated.
function moveProp(l, what, axis) {
    var pos;
    if (what !== "position")
        return tp(l, { scale: "ADBE Scale", rotation: "ADBE Rotate Z", opacity: "ADBE Opacity" }[what]);
    pos = tp(l, "ADBE Position");
    if (pos.dimensionsSeparated)
        return tp(l, axis === "y" ? "ADBE Position_1" : "ADBE Position_0");
    return pos;
}
// What a move changes: [property, axis, function(rest value) -> off-state value, fraction of the duration, springs?]
function movePlan(l, move, dir, dist) {
    var dx = dir === "left" ? -dist : (dir === "right" ? dist : 0), dy = dir === "up" ? -dist : (dir === "down" ? dist : 0), sep, out = [];
    function scaled(f) { return function (v) { var o = [], i; for (i = 0; i < v.length; i++)
        o.push(v[i] * f); return o; }; }
    function zero() { return 0; }
    // the off-state sits behind the direction of travel: moving up, the layer comes from below
    function offset(v) { var o = copyArr(v); o[0] -= dx; o[1] -= dy; return o; }
    if (move === "fade")
        out.push(["opacity", "", zero, 1, false]);
    if (move === "pop" || move === "spin") {
        out.push(["scale", "", scaled(0), 1, true]);
        out.push(["opacity", "", zero, 0.35, false]);
    }
    if (move === "spin")
        out.push(["rotation", "", function (v) { return v - 90; }, 1, true]);
    if (move === "grow") {
        out.push(["scale", "", scaled(0.8), 1, true]);
        out.push(["opacity", "", zero, 0.6, false]);
    }
    if (move === "slide" || move === "drop") {
        sep = tp(l, "ADBE Position").dimensionsSeparated;
        if (sep) {
            if (dx)
                out.push(["position", "x", function (v) { return v - dx; }, 1, true]);
            if (dy)
                out.push(["position", "y", function (v) { return v - dy; }, 1, true]);
        }
        else
            out.push(["position", "", offset, 1, true]);
        out.push(["opacity", "", zero, move === "drop" ? 0.25 : 0.5, false]);
    }
    return out;
}
// Key one part of a move between t0 and t1 (rest -> off for exits, off -> rest for entrances), replacing keys
// inside that span.
function keyMove(p, part, t0, t1, phase, curve) {
    var tRest = phase === "in" ? t1 : t0, rest = p.valueAtTime(tRest, true), off = part[2](rest), ta = t0, tb, a, b, i0, i1;
    tb = phase === "in" ? t0 + (t1 - t0) * part[3] : t1;
    if (phase === "out")
        ta = t1 - (t1 - t0) * part[3];
    a = phase === "in" ? off : rest;
    b = phase === "in" ? rest : off;
    clearKeysBetween(p, ta, tb);
    p.setValueAtTime(ta, a);
    p.setValueAtTime(tb, b);
    i0 = p.nearestKeyIndex(ta);
    i1 = p.nearestKeyIndex(tb);
    if (SPRINGS[curve] && part[4] && phase === "in") {
        shapeSegment(p, i0, i1, "linear");
        addSpring(p, ta, curve);
    }
    else
        shapeSegment(p, i0, i1, SPRINGS[curve] ? (phase === "in" ? "snappy" : "accelerate") : curve);
}
// The last transform key of a layer (where its entrance has landed), or its in point when nothing is keyed.
function lastTransformKey(l) {
    var names = ["ADBE Position", "ADBE Scale", "ADBE Rotate Z", "ADBE Opacity"], t = l.inPoint, i, p;
    for (i = 0; i < names.length; i++) {
        p = safe(function () { return tp(l, names[i]); });
        if (p && p.numKeys)
            t = Math.max(t, p.keyTime(p.numKeys));
    }
    return t;
}
// Key one property from its value at t0 to target(value) at t1 with a gentle ease at both ends. A key already at t0
// (an entrance landing) is kept with its incoming ease: only the segment after it is shaped. Keys inside (t0, t1] go.
function keyContinuous(p, t0, t1, target, curve, fd) {
    var rest = p.valueAtTime(t0, true), i0, i1, k, lin = KeyframeInterpolationType.LINEAR;
    for (k = p.numKeys; k >= 1; k--)
        if (p.keyTime(k) > t0 + fd / 2 && p.keyTime(k) <= t1 + EPS)
            p.removeKey(k);
    if (!p.numKeys || Math.abs(p.keyTime(p.nearestKeyIndex(t0)) - t0) > fd / 2)
        p.setValueAtTime(t0, rest);
    p.setValueAtTime(t1, target(rest));
    i0 = p.nearestKeyIndex(t0);
    i1 = p.nearestKeyIndex(t1);
    if (curve === "linear") {
        p.setInterpolationTypeAtKey(i0, p.keyInInterpolationType(i0), lin);
        p.setInterpolationTypeAtKey(i1, lin, p.keyOutInterpolationType(i1));
    }
    else {
        keySide(p, i0, "out", 45);
        keySide(p, i1, "in", 45);
    }
}
C.animate = function (a) {
    need(a, ["layer_ids", "move"]);
    var ls = pickLayers(a.layer_ids), c = sameComp(ls), phase = a.phase || "in", move = a.move, i, j, l, plan, t0, dur, curve, list = [], p, out = [], order;
    if (!MOVES[move])
        fail("BAD_ARGS", "move must be fade, pop, grow, slide, drop, spin, push or drift");
    if (CONTINUOUS[move])
        return animateContinuous(a, ls, c);
    if (phase !== "in" && phase !== "out")
        fail("BAD_ARGS", "phase must be in or out");
    curve = a.style || (move === "pop" || move === "spin" ? "spring" : (move === "drop" ? "bounce" : (phase === "in" ? "snappy" : "accelerate")));
    if (!MOVE_STYLES[curve] && curve !== "accelerate")
        fail("BAD_ARGS", "style must be snappy, smooth, spring, bounce or linear");
    dur = has(a, "duration") ? a.duration : (phase === "in" ? 0.6 : 0.4);
    if (!(dur > 0))
        fail("BAD_ARGS", "duration must be above 0");
    assertUnlocked(ls);
    order = copyArr(ls);
    if (a.order === "reverse")
        order.reverse();
    // check every property before changing anything: another expression on it would fight the keys
    for (i = 0; i < order.length; i++) {
        l = order[i];
        if (!l.property("ADBE Transform Group"))
            fail("BAD_ARGS", "Layer " + l.id + " has no transform", "For cameras use camera_move; for lights set_light");
        plan = movePlan(l, move, a.direction || (move === "drop" ? "down" : "up"), has(a, "distance") ? a.distance : (move === "drop" ? c.height * 0.25 : c.height * 0.08));
        for (j = 0; j < plan.length; j++) {
            p = moveProp(l, plan[j][0], plan[j][1]);
            if (springList(p) === null)
                fail("BAD_ARGS", "Layer " + l.id + ": " + p.name + " has an expression", "Clear it with set_expression and an empty expression");
        }
        t0 = has(a, "time") ? a.time : (phase === "in" ? l.inPoint : l.outPoint - dur);
        t0 = snapT(c, t0 + i * (a.stagger || 0));
        if (t0 < 0)
            fail("BAD_ARGS", "The move would start before 0 s", "Pass a later time or a shorter duration");
        list.push({ l: l, plan: plan, t0: t0 });
    }
    for (i = 0; i < list.length; i++) {
        for (j = 0; j < list[i].plan.length; j++)
            keyMove(moveProp(list[i].l, list[i].plan[j][0], list[i].plan[j][1]), list[i].plan[j], list[i].t0, snapT(c, list[i].t0 + dur), phase, curve);
        out.push({ id: list[i].l.id, start: list[i].t0, end: snapT(c, list[i].t0 + dur) });
    }
    return { move: move, phase: phase, style: curve, layers: out };
};
// push / drift: from where each layer's animation lands (or time) to its out point (or time + duration).
function animateContinuous(a, ls, c) {
    var fd = c.frameDuration, curve = a.style || "smooth", amt = (has(a, "amount") ? a.amount : 4) / 100, dir = a.direction || "up", dist = has(a, "distance") ? a.distance : Math.round(c.height * 0.02), dx = dir === "left" ? -dist : (dir === "right" ? dist : 0), dy = dir === "up" ? -dist : (dir === "down" ? dist : 0), out = [], order = copyArr(ls), i, l, t0, t1, p;
    if (curve !== "smooth" && curve !== "linear")
        fail("BAD_ARGS", "push and drift take style smooth (default) or linear");
    assertUnlocked(ls);
    if (a.order === "reverse")
        order.reverse();
    for (i = 0; i < order.length; i++) {
        l = order[i];
        t0 = snapT(c, (has(a, "time") ? a.time : lastTransformKey(l)) + i * (a.stagger || 0));
        t1 = snapT(c, has(a, "duration") ? t0 + a.duration : l.outPoint - fd);
        if (t1 - t0 < 0.25)
            fail("BAD_ARGS", "Layer " + l.id + ": less than 0.25 s left for the " + a.move + " (from " + t0 + " s)", "Pass time and duration");
        if (a.move === "push") {
            p = tp(l, "ADBE Scale");
            if (springList(p) === null)
                fail("BAD_ARGS", "Layer " + l.id + ": Scale has an expression", "Clear it with set_expression and an empty expression, or pick another move");
            keyContinuous(p, t0, t1, function (v) { var o = [], k; for (k = 0; k < v.length; k++)
                o.push(v[k] * (1 + amt)); return o; }, curve, fd);
        }
        else {
            p = tp(l, "ADBE Position");
            if (p.dimensionsSeparated) {
                if (dx)
                    keyContinuous(tp(l, "ADBE Position_0"), t0, t1, function (v) { return v + dx; }, curve, fd);
                if (dy)
                    keyContinuous(tp(l, "ADBE Position_1"), t0, t1, function (v) { return v + dy; }, curve, fd);
            }
            else {
                if (springList(p) === null)
                    fail("BAD_ARGS", "Layer " + l.id + ": Position has an expression", "Clear it with set_expression and an empty expression, or pick another move");
                keyContinuous(p, t0, t1, function (v) { var o = copyArr(v); o[0] += dx; o[1] += dy; return o; }, curve, fd);
            }
        }
        out.push({ id: l.id, start: t0, end: t1 });
    }
    return { move: a.move, phase: "hold", style: curve, layers: out };
}
// ---------- text reveals ----------
var REVEAL_BASED = { chars: 1, words: 3, lines: 4 };
// The curve u (0-1) -> e (0-1) as expression code. The power*/expo*/back*/wave curves are the
// motion vocabulary distilled from React Bits (reactbits.dev) entrances; they are closed-form
// GSAP-compatible easings so the same per-character timing survives in an AE text animator.
var REVEAL_CURVES = {
    linear: "u",
    smooth: "u<.5?4*u*u*u:1-Math.pow(-2*u+2,3)/2",
    snappy: "(1-Math.pow(2,-10*u))/(1-Math.pow(2,-10))",
    accelerate: "u*u*u",
    spring: "(1-Math.exp(-6*u)*Math.cos(9.42*u))/(1-Math.exp(-6)*Math.cos(9.42))",
    bounce: "1-Math.abs(Math.exp(-5*u)*Math.cos(14.137*u))",
    power2Out: "1-Math.pow(1-u,2)",
    power3Out: "1-Math.pow(1-u,3)",
    power4Out: "1-Math.pow(1-u,4)",
    power2InOut: "u<.5?2*u*u:1-Math.pow(-2*u+2,2)/2",
    expoOut: "u>=1?1:1-Math.pow(2,-10*u)",
    backOut: "1+2.70158*Math.pow(u-1,3)+1.70158*Math.pow(u-1,2)",
    backInOut: "u<.5?Math.pow(2*u,2)*((3.05+1)*2*u-3.05)/2:Math.pow(2*u-2,2)*((3.05+1)*(2*u-2)+3.05)/2+1",
    wave: "1-Math.cos(u*Math.PI*1.5)*Math.pow(1-u,1.2)"
};
var REVEAL_ORDERS = { forward: 0, reverse: 1, center: 2, random: 3 };
// The Amount expression of a reveal's expression selector: 100 = the animator's off state, 0 = at rest.
function revealExpr(t0, d, st, out, ord, curve, k) {
    return REVEAL_TAG + "\nvar t0=" + t0 + ",d=" + d + ",st=" + st + ",o=" + ord + ",k=" + k + ";\n" +
        "var i=textIndex-1,n=textTotal;\n" +
        "if(o==1)i=n-1-i;else if(o==2)i=Math.abs(i-(n-1)/2);else if(o==3){var r=Math.sin((i+1)*12.9898)*43758.5453;i=Math.floor((r-Math.floor(r))*n);}\n" +
        "var u=d>0?Math.min(Math.max((time-t0-i*st)/d,0),1):(time>=t0+i*st?1:0);\n" +
        "var e=" + REVEAL_CURVES[curve] + ";\n" + (out ? "100*e" : "100*(1-e)");
}
// How many units a reveal staggers over (textTotal's count for the chosen basis).
function unitCount(txt, by) {
    var parts, n = 0, i;
    if (by === "chars")
        return txt.length;
    parts = txt.split(by === "lines" ? /[\r\n]+/ : /\s+/);
    for (i = 0; i < parts.length; i++)
        if (parts[i] !== "")
            n++;
    return n;
}
// text_reveal styles. The original six are the AE-native basics; skewIn, riseBlur, focus and zoomIn
// are the React Bits text effects (Split Text skew, Blur Text blur/zoom/focus) rebuilt with the same
// native text-animator + Amount-expression mechanism, so they stay editable and reversible.
C.text_reveal = function (a) {
    need(a, ["layer_id"]);
    var l = getLayer(a.layer_id), c = l.containingComp, style = a.style || "rise", by = a.by || "chars", phase = a.phase || "in", curve = a.ease || (style === "pop" ? "spring" : (phase === "in" ? "snappy" : "accelerate")), d, st, t0, n, an, props, sel, dist, fontSize, dir, off, r, m, pad, ms, amount, end;
    if (!(l instanceof TextLayer))
        fail("BAD_ARGS", "Layer " + l.id + " is not a text layer", "text_reveal works on text layers; animate moves any layer");
    if (!REVEAL_BASED[by])
        fail("BAD_ARGS", "by must be chars, words or lines");
    if (!REVEAL_CURVES[curve])
        fail("BAD_ARGS", "ease must be snappy, smooth, accelerate, spring, bounce, linear, power2Out, power3Out, power4Out, power2InOut, expoOut, backOut, backInOut or wave");
    if (" rise drop fade pop blur typewriter skewIn riseBlur focus zoomIn wave float ".indexOf(" " + style + " ") === -1)
        fail("BAD_ARGS", "style must be rise, drop, fade, pop, blur, typewriter, skewIn, riseBlur, focus, zoomIn, wave or float");
    if (!has(REVEAL_ORDERS, a.order || "forward"))
        fail("BAD_ARGS", "order must be forward, reverse, center or random");
    if (a.direction && " up down left right ".indexOf(" " + a.direction + " ") === -1)
        fail("BAD_ARGS", "direction must be up, down, left or right");
    d = style === "typewriter" ? 0 : (has(a, "duration") ? a.duration : 0.5);
    st = has(a, "stagger") ? a.stagger : (style === "typewriter" ? 0.05 : { chars: 0.03, words: 0.08, lines: 0.15 }[by]);
    n = unitCount(l.property("ADBE Text Properties").property("ADBE Text Document").value.text, by);
    fontSize = 0;
    safe(function () { fontSize = Number(l.property("ADBE Text Properties").property("ADBE Text Document").value.fontSize) || 0; });
    t0 = has(a, "time") ? a.time : (phase === "in" ? l.inPoint : l.outPoint - d - Math.max(0, n - 1) * st);
    if (t0 < 0)
        fail("BAD_ARGS", "The reveal would start before 0 s", "Pass a later time, or a shorter duration or stagger");
    // Default travel direction of each style (the side the unit comes from is its opposite).
    dir = a.direction || (style === "drop" ? "down" : (style === "skewIn" ? "right" : ((style === "riseBlur" || style === "zoomIn") ? "down" : "up")));
    // Distance defaults follow the component that inspired the style: Split Text 40px / 0.45em,
    // Blur Text 50px, Scroll Reveal about 0.8em, Scroll Float about 1.2em plus a small stretch.
    dist = has(a, "distance") ? a.distance : (style === "skewIn" ? Math.round(fontSize * 0.4) : (style === "wave" ? Math.round(fontSize * 0.45) : (style === "float" ? Math.round(fontSize * 1.2) : (style === "riseBlur" || style === "zoomIn" ? 50 : (style === "focus" ? 0 : Math.round(c.height * 0.05))))));
    off = [0, 0, 0];
    if (dir === "up") off = [0, dist, 0];
    else if (dir === "down") off = [0, -dist, 0];
    else if (dir === "right") off = [-dist, 0, 0];
    else off = [dist, 0, 0];
    // Blur Text's zoom only drifts a third of its distance while the blur resolves.
    if (style === "zoomIn") off = [off[0] * 0.35, off[1] * 0.35, 0];
    an = l.property("ADBE Text Properties").property("ADBE Text Animators").addProperty("ADBE Text Animator");
    an.name = "Reveal (" + style + ")";
    props = an.property("ADBE Text Animator Properties");
    props.addProperty("ADBE Text Opacity").setValue(0);
    if (style === "rise" || style === "drop" || style === "riseBlur" || style === "zoomIn" || style === "wave" || style === "float" || style === "skewIn")
        props.addProperty("ADBE Text Position 3D").setValue(off);
    if (style === "pop")
        props.addProperty("ADBE Text Scale 3D").setValue([0, 0, 0]);
    if (style === "focus")
        props.addProperty("ADBE Text Scale 3D").setValue([112, 112, 100]);
    if (style === "zoomIn")
        props.addProperty("ADBE Text Scale 3D").setValue([140, 140, 100]);
    // Scroll Float also squashes: scaleY stretch 110%, scaleX squeeze ~96% while it rises.
    if (style === "float")
        props.addProperty("ADBE Text Scale 3D").setValue([96.5, 110, 100]);
    if (style === "skewIn") {
        props.addProperty("ADBE Text Skew").setValue(-24);
        safe(function () { props.addProperty("ADBE Text Skew Axis").setValue(0); });
    }
    if (style === "blur")
        props.addProperty("ADBE Text Blur").setValue([24, 24]);
    if (style === "riseBlur")
        props.addProperty("ADBE Text Blur").setValue([10, 10]);
    if (style === "zoomIn")
        props.addProperty("ADBE Text Blur").setValue([12, 12]);
    if (style === "focus")
        props.addProperty("ADBE Text Blur").setValue([14, 14]);
    sel = an.property("ADBE Text Selectors").addProperty("ADBE Text Expressible Selector");
    safe(function () { sel.property("ADBE Text Range Type2").setValue(REVEAL_BASED[by]); });
    amount = sel.property("ADBE Text Expressible Amount");
    amount.expression = revealExpr(Math.round(t0 * 1e4) / 1e4, d, st, phase === "out", REVEAL_ORDERS[a.order || "forward"], curve, n);
    if (amount.expressionError)
        fail("AE_ERROR", "After Effects rejected the reveal expression: " + amount.expressionError);
    end = t0 + d + Math.max(0, n - 1) * st;
    // a mask along the text's baseline (rise) or cap line (drop) so letters slide out from behind a line
    if (a.mask && (style === "rise" || style === "drop") && (dir === "up" || dir === "down")) {
        r = l.sourceRectAtTime(phase === "in" ? end : t0, false);
        pad = Math.max(r.height, dist) * 1.5;
        m = l.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
        m.name = "Reveal line";
        ms = dir === "up" ? [r.top - pad, r.top + r.height + r.height * 0.12] : [r.top - r.height * 0.05, r.top + r.height + pad];
        m.property("ADBE Mask Shape").setValue(boxShape("rect", r.left + r.width / 2, (ms[0] + ms[1]) / 2, r.width + pad * 2, ms[1] - ms[0]));
    }
    return { layer: layerRef(l), animator: an.propertyIndex, units: n, start: t0, end: Math.round(end * 1e4) / 1e4 };
};
// ---------- transitions ----------
function fdHalf(c) { return c.frameDuration / 2; }
// A full-frame color move that covers the frame at time (cut the scenes there) and clears it again by
// time + duration/2: a wipe or staggered bars travelling across, an iris circle that grows to a disc and then
// opens from its centre (a ring whose stroke shrinks), a dip through the color, or two panels crossing from
// opposite sides (split = left/right, shutter = top/bottom) for page-transition style reveals.
C.transition = function (a) {
    need(a, ["comp_id", "time"]);
    var c = getComp(a.comp_id), type = a.type || "wipe", d = has(a, "duration") ? a.duration : 0.8, col = a.color || [0.05, 0.05, 0.06], dir = a.direction || "right", W = c.width, H = c.height, ts = snapT(c, a.time - d / 2), tm = snapT(c, a.time), te = snapT(c, a.time + d / 2), l, n, i, horiz, grp, pos, st, R, cx, cy, sz, sw, g, k, op, splitX, side, covered, offstart, offend;
    if (" wipe bars iris fade split shutter ".indexOf(" " + type + " ") === -1)
        fail("BAD_ARGS", "type must be wipe, bars, iris, fade, split or shutter");
    if (" left right up down ".indexOf(" " + dir + " ") === -1)
        fail("BAD_ARGS", "direction must be left, right, up or down");
    if (ts < 0)
        fail("BAD_ARGS", "The transition would start before 0 s", "Use a later time or a shorter duration");
    l = c.layers.addShape();
    l.name = "Transition (" + type + ")";
    setIn(l, ts);
    l.outPoint = Math.min(c.duration, te + c.frameDuration);
    if (type === "iris") {
        cx = a.center ? a.center[0] - W / 2 : 0;
        cy = a.center ? a.center[1] - H / 2 : 0;
        // radius that covers the farthest corner from the centre
        R = Math.sqrt(Math.pow(W / 2 + Math.abs(cx), 2) + Math.pow(H / 2 + Math.abs(cy), 2));
        grp = addShapeContent(l, { type: "ellipse", size: [1, 1], stroke: col, stroke_width: 1, name: "Iris" });
        grp.property("ADBE Vector Transform Group").property("ADBE Vector Position").setValue([cx, cy]);
        g = grp.property("ADBE Vectors Group");
        sz = g.property(1).property("ADBE Vector Ellipse Size");
        sw = g.property(2).property("ADBE Vector Stroke Width");
        sz.setValueAtTime(ts, [0, 0]);
        sz.setValueAtTime(tm, [R, R]);
        sz.setValueAtTime(te, [2 * R, 2 * R]);
        sw.setValueAtTime(ts, 0);
        sw.setValueAtTime(tm, R);
        sw.setValueAtTime(te, 0);
        for (k = 1; k <= 3; k++) {
            applyKeyMeta(sz, k, { ease_in: { influence: 60 }, ease_out: { influence: 60 } });
            applyKeyMeta(sw, k, { ease_in: { influence: 60 }, ease_out: { influence: 60 } });
        }
    }
    else if (type === "fade") {
        // dip through the colour: transparent at the start, full colour at the cut, transparent again after it
        addShapeContent(l, { type: "rect", size: [W + 4, H + 4], fill: col, name: "Fade" });
        op = l.property("ADBE Transform Group").property("ADBE Opacity");
        op.setValueAtTime(ts, 0);
        op.setValueAtTime(tm, 100);
        op.setValueAtTime(te, 0);
        for (k = 1; k <= 3; k++)
            applyKeyMeta(op, k, { ease_in: { influence: 60 }, ease_out: { influence: 60 } });
    }
    else if (type === "split" || type === "shutter") {
        // two covered panels crossing from opposite sides: left/right for split, top/bottom for shutter
        splitX = type === "split";
        for (i = 0; i < 2; i++) {
            side = i === 0 ? -1 : 1;
            grp = addShapeContent(l, { type: "rect", size: splitX ? [W / 2 + 2, H + 4] : [W + 4, H / 2 + 2], fill: col, name: "Panel " + (i + 1) });
            pos = grp.property("ADBE Vector Transform Group").property("ADBE Vector Position");
            covered = splitX ? [side * W / 4, 0] : [0, side * H / 4];
            offstart = splitX ? [side * W * 0.78, 0] : [0, side * H * 0.78];
            offend = splitX ? [-side * W * 0.78, 0] : [0, -side * H * 0.78];
            pos.setValueAtTime(ts, offstart);
            pos.setValueAtTime(tm, covered);
            pos.setValueAtTime(te, offend);
            shapeSegment(pos, 1, 2, "smooth");
            shapeSegment(pos, 2, 3, "smooth");
        }
    }
    else {
        n = type === "bars" ? Math.max(2, Math.min(20, a.bars || 5)) : 1;
        horiz = dir === "left" || dir === "right";
        // bars arrive one after another, all cover the frame at time, then leave in the same order
        st = n > 1 ? d * 0.25 / (n - 1) : 0;
        k = dir === "left" || dir === "up" ? -1 : 1;
        for (i = 0; i < n; i++) {
            grp = addShapeContent(l, { type: "rect", size: horiz ? [W + 4, H / n + 2] : [W / n + 2, H + 4], fill: col, name: "Bar " + (i + 1) });
            pos = grp.property("ADBE Vector Transform Group").property("ADBE Vector Position");
            cx = horiz ? 0 : -W / 2 + (i + 0.5) * W / n;
            cy = horiz ? -H / 2 + (i + 0.5) * H / n : 0;
            sz = [snapT(c, ts + i * st), snapT(c, tm - (n - 1 - i) * st), snapT(c, tm + i * st)];
            sz.push(snapT(c, sz[2] + (sz[1] - sz[0])));
            pos.setValueAtTime(sz[0], horiz ? [-k * (W + 4), cy] : [cx, -k * (H + 4)]);
            pos.setValueAtTime(sz[1], [cx, cy]);
            if (sz[2] > sz[1] + fdHalf(c))
                pos.setValueAtTime(sz[2], [cx, cy]);
            pos.setValueAtTime(sz[3], horiz ? [k * (W + 4), cy] : [cx, k * (H + 4)]);
            shapeSegment(pos, 1, 2, "snappy");
            shapeSegment(pos, pos.numKeys - 1, pos.numKeys, "accelerate");
        }
    }
    return { layer: layerTiming(l), covered_at: tm, type: type };
};
// host/commands/animate.ts
C.stagger = function (a) {
    need(a, ["layer_ids", "path", "offset_seconds"]);
    var ids = copyArr(a.layer_ids), props = [], i, p;
    if (a.order === "reverse")
        ids.reverse();
    for (i = 0; i < ids.length; i++) {
        p = resolvePath(getLayer(ids[i]), a.path);
        if (!p.numKeys)
            fail("BAD_ARGS", "Layer " + ids[i] + " has no keyframes on that property", "stagger offsets existing keys: animate the property first (set_keyframes or animate)");
        props.push(p);
    }
    for (i = 1; i < props.length; i++)
        shiftKeys(props[i], i * a.offset_seconds);
    return { staggered: ids.length };
};
