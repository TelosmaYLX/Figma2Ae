// Build AE test comps for the "Figma Background Blur" plug-in and render PNG frames (v2).
// Card strokes are emulated with an inset stroke layer (Figma uses an INSIDE stroke;
// AE shape strokes are always centre-aligned, so we inset the stroke path by 1px).
// Run inside AE via F2A ae_run_script_file.
// Outputs PNGs into rea-work/ae-plugin-test/out/

(function () {
    var OUT = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/rea-work/ae-plugin-test/out/";
    var reports = { steps: [], errors: [], out: OUT };

    function ensureDir(path) {
        var f = new Folder(path);
        if (!f.exists) f.create();
    }
    ensureDir(OUT);

    function removeComp(name) {
        for (var i = app.project.numItems; i >= 1; i--) {
            var it = app.project.item(i);
            if (it instanceof CompItem && it.name === name) it.remove();
        }
    }

    function newComp(name, w, h, dur, fps) {
        removeComp(name);
        return app.project.items.addComp(name, w, h, 1, dur, fps);
    }

    function addSolid(comp, name, rgb, w, h) {
        return comp.layers.addSolid([rgb[0] / 255, rgb[1] / 255, rgb[2] / 255], name, w, h, 1);
    }

    function setPos(lyr, cx, cy) {
        var t = lyr.property("Transform");
        t.property("Anchor Point").setValue([0, 0]);
        t.property("Position").setValue([cx, cy]);
    }

    function addEllipse(comp, name, x, y, w, h, rgb8) {
        var lyr = comp.layers.addShape();
        lyr.name = name;
        var grp = lyr.property("Contents").addProperty("ADBE Vector Group");
        var el = grp.property("Contents").addProperty("ADBE Vector Shape - Ellipse");
        el.property("Size").setValue([w, h]);
        var fill = grp.property("Contents").addProperty("ADBE Vector Graphic - Fill");
        fill.property("Color").setValue([rgb8[0] / 255, rgb8[1] / 255, rgb8[2] / 255]);
        setPos(lyr, x + w / 2, y + h / 2);
        return lyr;
    }

    function addRect(comp, name, x, y, w, h, roundness, rgb8) {
        var lyr = comp.layers.addShape();
        lyr.name = name;
        var grp = lyr.property("Contents").addProperty("ADBE Vector Group");
        var rc = grp.property("Contents").addProperty("ADBE Vector Shape - Rect");
        rc.property("Size").setValue([w, h]);
        rc.property("Roundness").setValue(roundness || 0);
        var fill = grp.property("Contents").addProperty("ADBE Vector Graphic - Fill");
        fill.property("Color").setValue([rgb8[0] / 255, rgb8[1] / 255, rgb8[2] / 255]);
        setPos(lyr, x + w / 2, y + h / 2);
        return lyr;
    }

    // Card = fill layer (full size) + inset stroke layer (simulates Figma INSIDE stroke).
    function addCard(comp, name, x, y, w, h, roundness, fillOpacityPct, strokeOpacityPct, strokeWidth) {
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
        setPos(fillLyr, cx, cy);

        var strokeLyr = comp.layers.addShape();
        strokeLyr.name = name + "_stroke";
        var g2 = strokeLyr.property("Contents").addProperty("ADBE Vector Group");
        var r2 = g2.property("Contents").addProperty("ADBE Vector Shape - Rect");
        var inset = (strokeWidth || 2) / 2;
        r2.property("Size").setValue([w - 2 * inset, h - 2 * inset]);
        r2.property("Roundness").setValue(Math.max(0, (roundness || 0) - inset));
        var s2 = g2.property("Contents").addProperty("ADBE Vector Graphic - Stroke");
        s2.property("Color").setValue([1, 1, 1]);
        s2.property("Opacity").setValue(strokeOpacityPct);
        s2.property("Stroke Width").setValue(strokeWidth);
        setPos(strokeLyr, cx, cy);

        return { fill: fillLyr, stroke: strokeLyr };
    }

    function addBlurAdjustment(comp, name, radius, cx, cy, w, h, corner, softAA) {
        var lyr = comp.layers.addSolid([0, 0, 0], name, comp.width, comp.height, 1);
        lyr.adjustmentLayer = true;
        var fx = lyr.property("Effects").addProperty("F2A Figma Background Blur");
        fx.property(1).setValue(radius);
        fx.property(2).setValue(cx);
        fx.property(3).setValue(cy);
        fx.property(4).setValue(w);
        fx.property(5).setValue(h);
        fx.property(6).setValue(corner);
        fx.property(7).setValue(softAA ? 1 : 0);
        return { layer: lyr, fx: fx };
    }

    function savePng(comp, time, file) {
        var f = new File(OUT + file);
        comp.saveFrameToPng(time, f);
        return f.fsName;
    }

    // ---------- 1) impulse response comp: radius 8 ----------
    try {
        var imp = newComp("PLUGIN_Impulse_R8", 400, 200, 2, 30);
        addSolid(imp, "black", [16, 16, 16], 400, 200);
        addRect(imp, "line1px", 200, 30, 1, 140, 0, [255, 255, 255]);
        addBlurAdjustment(imp, "BlurAdj", 8, 200, 100, 400, 200, 0, false);
        reports.steps.push({ comp: "PLUGIN_Impulse_R8", png: savePng(imp, 0, "impulse_r8.png") });
    } catch (e) {
        reports.errors.push("impulse: " + e.toString());
    }

    // ---------- 2) step response comp: radius 40 ----------
    try {
        var stepc = newComp("PLUGIN_Step_R40", 400, 200, 2, 30);
        addSolid(stepc, "black", [16, 16, 16], 400, 200);
        addRect(stepc, "white_edge", 250, 30, 140, 140, 0, [255, 255, 255]);
        addBlurAdjustment(stepc, "BlurAdj", 40, 200, 100, 400, 200, 0, false);
        reports.steps.push({ comp: "PLUGIN_Step_R40", png: savePng(stepc, 0, "step_r40.png") });
    } catch (e) {
        reports.errors.push("step: " + e.toString());
    }

    // ---------- 3) full A/B scene comps ----------
    var variants = [
        { name: "AB_R40_HARD", radius: 40, soft: false },
        { name: "AB_R39_HARD", radius: 39, soft: false },
        { name: "AB_R385_HARD", radius: 38.5, soft: false },
        { name: "AB_R40_SOFT", radius: 40, soft: true }
    ];

    for (var vi = 0; vi < variants.length; vi++) {
        var v = variants[vi];
        try {
            var comp = newComp(v.name, 1200, 800, 5, 30);
            addSolid(comp, "BG", [20, 18, 43], 1200, 800);
            addEllipse(comp, "Circle_Purple", 120, 100, 520, 520, [108, 92, 231]);
            addEllipse(comp, "Circle_Cyan", 740, 60, 380, 380, [0, 194, 203]);
            addEllipse(comp, "Circle_Orange", 880, 480, 280, 280, [225, 112, 85]);
            addRect(comp, "Rect_Yellow", 140, 560, 280, 170, 24, [253, 203, 110]);
            addEllipse(comp, "Circle_White", 560, 250, 220, 220, [255, 255, 255]);
            addRect(comp, "RED_ClampTest", 216, 330, 80, 80, 0, [255, 59, 48]);
            addBlurAdjustment(comp, "BlurAdj", v.radius, 600, 400, 560, 340, 32, v.soft);
            addCard(comp, "GlassCard", 320, 230, 560, 340, 32, 14, 30, 2);
            addCard(comp, "ControlCard", 900, 640, 220, 120, 20, 10, 25, 2);
            var png = savePng(comp, 0, v.name + ".png");
            reports.steps.push({ comp: v.name, png: png });
        } catch (e) {
            reports.errors.push(v.name + ": " + e.toString());
        }
    }

    // ---------- 4) moving-card comp (realtime test) ----------
    try {
        var mv = newComp("AB_MOVE", 1200, 800, 5, 30);
        addSolid(mv, "BG", [20, 18, 43], 1200, 800);
        addEllipse(mv, "Circle_Purple", 120, 100, 520, 520, [108, 92, 231]);
        addEllipse(mv, "Circle_Cyan", 740, 60, 380, 380, [0, 194, 203]);
        addEllipse(mv, "Circle_Orange", 880, 480, 280, 280, [225, 112, 85]);
        addRect(mv, "Rect_Yellow", 140, 560, 280, 170, 24, [253, 203, 110]);
        addEllipse(mv, "Circle_White", 560, 250, 220, 220, [255, 255, 255]);
        addRect(mv, "RED_ClampTest", 216, 330, 80, 80, 0, [255, 59, 48]);
        var adj = addBlurAdjustment(mv, "BlurAdj", 40, 600, 400, 560, 340, 32, false);
        var fx = adj.fx;
        // keyframe the card center: 600 -> 820 over 3s
        fx.property(2).setValueAtTime(0, 600);
        fx.property(2).setValueAtTime(3, 820);
        var card2 = addCard(mv, "GlassCard", 320, 230, 560, 340, 32, 14, 30, 2);
        var fillPos = card2.fill.property("Transform").property("Position");
        var strokePos = card2.stroke.property("Transform").property("Position");
        fillPos.setValueAtTime(0, [600, 400]);
        fillPos.setValueAtTime(3, [820, 400]);
        strokePos.setValueAtTime(0, [600, 400]);
        strokePos.setValueAtTime(3, [820, 400]);
        addCard(mv, "ControlCard", 900, 640, 220, 120, 20, 10, 25, 2);
        reports.steps.push({
            comp: "AB_MOVE",
            png0: savePng(mv, 0, "AB_MOVE_t0.png"),
            png2: savePng(mv, 2.5, "AB_MOVE_t2p5.png")
        });
    } catch (e) {
        reports.errors.push("AB_MOVE: " + e.toString());
    }

    return JSON.stringify(reports);
})();