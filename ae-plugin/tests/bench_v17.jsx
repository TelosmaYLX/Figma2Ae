// Performance bench: measure the plug-in's per-frame render cost by comparing
// the same animated comp with the effect enabled vs disabled (the cache is
// invalidated by the enabled-flag change, so both passes really render).
(function () {
    var BASE = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/";
    var OUT = BASE + "rea-work/ae-plugin-test/out/";
    var r = { results: [], errors: [] };

    function addSolid(comp, name, rgb8, w, h) {
        return comp.layers.addSolid([rgb8[0] / 255, rgb8[1] / 255, rgb8[2] / 255], name, w, h, 1);
    }
    function addEllipse(comp, name, x, y, w, h, rgb8) {
        var lyr = comp.layers.addShape();
        lyr.name = name;
        var grp = lyr.property("Contents").addProperty("ADBE Vector Group");
        var el = grp.property("Contents").addProperty("ADBE Vector Shape - Ellipse");
        el.property("Size").setValue([w, h]);
        var fill = grp.property("Contents").addProperty("ADBE Vector Graphic - Fill");
        fill.property("Color").setValue([rgb8[0] / 255, rgb8[1] / 255, rgb8[2] / 255]);
        lyr.property("Transform").property("Anchor Point").setValue([0, 0]);
        lyr.property("Transform").property("Position").setValue([x + w / 2, y + h / 2]);
        return lyr;
    }
    function addRect(comp, name, x, y, w, h, rgb8) {
        var lyr = comp.layers.addShape();
        lyr.name = name;
        var grp = lyr.property("Contents").addProperty("ADBE Vector Group");
        var rc = grp.property("Contents").addProperty("ADBE Vector Shape - Rect");
        rc.property("Size").setValue([w, h]);
        var fill = grp.property("Contents").addProperty("ADBE Vector Graphic - Fill");
        fill.property("Color").setValue([rgb8[0] / 255, rgb8[1] / 255, rgb8[2] / 255]);
        lyr.property("Transform").property("Anchor Point").setValue([0, 0]);
        lyr.property("Transform").property("Position").setValue([x + w / 2, y + h / 2]);
        return lyr;
    }
    function addCard(comp, name, x, y, w, h, roundness, fillOpacityPct) {
        var cx = x + w / 2;
        var cy = y + h / 2;
        var fillLyr = comp.layers.addShape();
        fillLyr.name = name + "_fill";
        var g1 = fillLyr.property("Contents").addProperty("ADBE Vector Group");
        var r1 = g1.property("Contents").addProperty("ADBE Vector Shape - Rect");
        r1.property("Size").setValue([w, h]);
        r1.property("Roundness").setValue(roundness || 0);
        var f1 = g1.property("Contents").addProperty("ADBE Vector Graphic - Fill");
        f1.property("Color").setValue([1, 1, 1]);
        f1.property("Opacity").setValue(fillOpacityPct);
        fillLyr.property("Transform").property("Anchor Point").setValue([0, 0]);
        fillLyr.property("Transform").property("Position").setValue([cx, cy]);
        return fillLyr;
    }
    function roundedRectShape(x0, y0, x1, y1, rad) {
        var s = new Shape();
        var k = rad * 0.5523;
        var v = [], it = [], ot = [];
        function push(p, tin, tout) {
            v.push(p); it.push(tin); ot.push(tout);
        }
        push([x0 + rad, y0], [-k, 0], [0, 0]);
        push([x1 - rad, y0], [0, 0], [k, 0]);
        push([x1, y0 + rad], [0, -k], [0, 0]);
        push([x1, y1 - rad], [0, 0], [0, k]);
        push([x1 - rad, y1], [k, 0], [0, 0]);
        push([x0 + rad, y1], [0, 0], [-k, 0]);
        push([x0, y1 - rad], [0, k], [0, 0]);
        push([x0, y0 + rad], [0, 0], [0, -k]);
        s.vertices = v;
        s.closed = true;
        s.inTangents = it;
        s.outTangents = ot;
        return s;
    }

    // build an animated scene (frames must differ so AE cannot reuse frames)
    function buildComp(name, w, h, mode) {
        var c = app.project.items.addComp(name, w, h, 1, 2, 30);
        addSolid(c, "BG", [20, 18, 43], w, h);
        var p = addEllipse(c, "Circle_Purple", w * 0.1, h * 0.12, w * 0.43, h * 0.65, [108, 92, 231]);
        var cy = addEllipse(c, "Circle_Cyan", w * 0.62, h * 0.08, w * 0.32, h * 0.48, [0, 194, 203]);
        addRect(c, "Rect_Yellow", w * 0.12, h * 0.7, w * 0.23, h * 0.21, [253, 203, 110]);
        addEllipse(c, "Circle_White", w * 0.47, h * 0.31, w * 0.18, h * 0.28, [255, 255, 255]);
        // animate the backdrop so every frame is a real render
        p.property("Transform").property("Position").setValueAtTime(0, [w * 0.31, h * 0.45]);
        p.property("Transform").property("Position").setValueAtTime(2, [w * 0.38, h * 0.42]);
        cy.property("Transform").property("Position").setValueAtTime(0, [w * 0.78, h * 0.32]);
        cy.property("Transform").property("Position").setValueAtTime(2, [w * 0.72, h * 0.35]);

        var adj = addSolid(c, "BlurAdj", [0, 0, 0], w, h);
        adj.adjustmentLayer = true;
        var fx = adj.property("Effects").addProperty("F2A Figma Background Blur");
        var mask = adj.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
        mask.property("ADBE Mask Shape").setValue(roundedRectShape(w * 0.27, h * 0.29, w * 0.73, h * 0.71, 32));
        mask.maskMode = MaskMode.ADD;
        mask.property("ADBE Mask Feather").setValue([0, 0]);
        if (mode === "uniform") {
            fx.property(1).setValue(1);
            fx.property(2).setValue(40);
        } else {
            fx.property(1).setValue(2);
            fx.property(3).setValue(0);
            fx.property(4).setValue(40);
        }
        addCard(c, "GlassCard", w * 0.27, h * 0.29, w * 0.46, h * 0.42, 32, 14);
        return { comp: c, fx: fx };
    }

    function timeFrames(comp, startFrame, count, fps) {
        var t0 = new Date().getTime();
        for (var i = 0; i < count; i++) {
            comp.saveFrameToPng((startFrame + i) / fps, new File(OUT + "_bench_tmp.png"));
        }
        return new Date().getTime() - t0;
    }

    try {
        var fps = 30;
        var frames = 24;
        var cases = [
            { name: "1200x800 progressive", w: 1200, h: 800, mode: "progressive" },
            { name: "1200x800 uniform", w: 1200, h: 800, mode: "uniform" },
            { name: "3840x2160 progressive", w: 3840, h: 2160, mode: "progressive" }
        ];
        for (var ci = 0; ci < cases.length; ci++) {
            var cfg = cases[ci];
            var built = buildComp("BENCH_" + ci, cfg.w, cfg.h, cfg.mode);
            var comp = built.comp;
            // warm-up render of one frame, then measure with the effect on
            comp.saveFrameToPng(0, new File(OUT + "_bench_tmp.png"));
            var on = timeFrames(comp, 0, frames, fps);
            built.fx.enabled = false;
            var off = timeFrames(comp, 0, frames, fps); // cache invalidated by the flag change
            built.fx.enabled = true;
            r.results.push({
                label: cfg.name,
                frames: frames,
                ms_on_per_frame: Math.round(on / frames * 10) / 10,
                ms_off_per_frame: Math.round(off / frames * 10) / 10,
                ms_plugin_per_frame: Math.round((on - off) / frames * 10) / 10
            });
            comp.remove();
        }
    } catch (e) {
        r.errors.push(e.toString() + " @ line " + (e.line || "?"));
    }
    return JSON.stringify(r, null, 1);
})();
