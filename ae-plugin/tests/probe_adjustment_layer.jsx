// Probe how After Effects treats effects on ADJUSTMENT layers:
//   A) does the adjustment layer's transform move the effect result?
//   B) does the adjustment layer's own mask clip the effect result?
//   C) does a masked+parented adjustment layer follow the shape layer?
(function () {
    var BASE = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/";
    var OUT = BASE + "rea-work/ae-plugin-test/out/";
    var r = { steps: [], errors: [] };

    function addSolid(comp, name, rgb8, w, h) {
        return comp.layers.addSolid([rgb8[0] / 255, rgb8[1] / 255, rgb8[2] / 255], name, w, h, 1);
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
    // rounded-rect mask path in layer space
    function roundedRectShape(x0, y0, x1, y1, rad) {
        var s = new Shape();
        var k = rad * 0.5523;
        var v = [];
        var it = [];
        var ot = [];
        function push(p, tin, tout) {
            v.push(p);
            it.push(tin);
            ot.push(tout);
        }
        // start at top-left after the corner, going clockwise
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
    function buildScene(comp) {
        addSolid(comp, "BG", [20, 18, 43], comp.width, comp.height);
        addEllipse(comp, "Circle_Purple", 120, 100, 520, 520, [108, 92, 231]);
        addEllipse(comp, "Circle_Cyan", 740, 60, 380, 380, [0, 194, 203]);
        addEllipse(comp, "Circle_Orange", 880, 480, 280, 280, [225, 112, 85]);
        addRect(comp, "Rect_Yellow", 140, 560, 280, 170, 24, [253, 203, 110]);
        addEllipse(comp, "Circle_White", 560, 250, 220, 220, [255, 255, 255]);
        addRect(comp, "RED_ClampTest", 216, 330, 80, 80, 0, [255, 59, 48]);
    }

    function addBlurAdjustment(comp) {
        var lyr = addSolid(comp, "BlurAdj", [0, 0, 0], comp.width, comp.height);
        lyr.adjustmentLayer = true;
        var fx = lyr.property("Effects").addProperty("F2A Figma Background Blur");
        return { layer: lyr, fx: fx };
    }

    try {
        // The project is reset by the caller before running this probe.

        // ---------- A) does the adjustment layer transform move the result? ----------
        var a = app.project.items.addComp("TEST_XFORM", 1200, 800, 1, 5, 30);
        buildScene(a);
        var aAdj = addBlurAdjustment(a);
        var aCard = addCard(a, "GlassCard", 320, 230, 560, 340, 32, 14, 30, 2);
        aAdj.fx.property(8).setValue(aCard.fill.index); // Alpha源 = card fill
        aAdj.fx.property(1).setValue(1); // uniform
        aAdj.fx.property(2).setValue(40);
        aAdj.fx.property(7).setValue(0);
        a.saveFrameToPng(0, new File(OUT + "TEST_XFORM_base.png"));
        // move the adjustment layer by +120/+80 and render again
        aAdj.layer.property("Transform").property("Position").setValue([720, 480]);
        a.saveFrameToPng(0, new File(OUT + "TEST_XFORM_moved.png"));
        aAdj.layer.property("Transform").property("Position").setValue([600, 400]);
        r.steps.push({ test: "A", base: "TEST_XFORM_base.png", moved: "TEST_XFORM_moved.png" });

        // ---------- B) does the adjustment layer's own mask clip the result? ----------
        var b = app.project.items.addComp("TEST_MASK", 1200, 800, 1, 5, 30);
        buildScene(b);
        var bAdj = addBlurAdjustment(b);
        var bCard = addCard(b, "GlassCard", 320, 230, 560, 340, 32, 14, 30, 2);
        // NO Alpha源 (0) -> the plug-in blurs the whole frame and outputs it
        bAdj.fx.property(8).setValue(0);
        bAdj.fx.property(1).setValue(1); // uniform
        bAdj.fx.property(2).setValue(40);
        bAdj.fx.property(7).setValue(0);
        // rounded-rect mask in the shape of the card (layer space = comp space here)
        var maskGroup = bAdj.layer.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
        maskGroup.property("ADBE Mask Shape").setValue(roundedRectShape(320, 230, 880, 570, 32));
        maskGroup.maskMode = MaskMode.ADD;
        maskGroup.property("ADBE Mask Feather").setValue([0, 0]);
        b.saveFrameToPng(0, new File(OUT + "TEST_MASK.png"));
        r.steps.push({ test: "B", png: "TEST_MASK.png" });

        // ---------- C) masked + parented adjustment layer follows a moving card ----------
        var c = app.project.items.addComp("TEST_PARENT", 1200, 800, 1, 5, 30);
        buildScene(c);
        var cAdj = addBlurAdjustment(c);
        var cCard = addCard(c, "GlassCard", 200, 230, 560, 340, 32, 14, 30, 2);
        cAdj.fx.property(8).setValue(0);
        cAdj.fx.property(1).setValue(1);
        cAdj.fx.property(2).setValue(40);
        cAdj.fx.property(7).setValue(0);
        var cMask = cAdj.layer.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
        cMask.property("ADBE Mask Shape").setValue(roundedRectShape(200, 230, 760, 570, 32));
        cMask.maskMode = MaskMode.ADD;
        cMask.property("ADBE Mask Feather").setValue([0, 0]);
        // parent the adjustment layer to the card fill layer, then move the card
        cAdj.layer.parent = cCard.fill;
        var pos = cCard.fill.property("Transform").property("Position");
        pos.setValueAtTime(0, [480, 400]);
        pos.setValueAtTime(2.5, [760, 400]);
        cCard.stroke.property("Transform").property("Position").setValueAtTime(0, [480, 400]);
        cCard.stroke.property("Transform").property("Position").setValueAtTime(2.5, [760, 400]);
        c.saveFrameToPng(0, new File(OUT + "TEST_PARENT_t0.png"));
        c.saveFrameToPng(2.5, new File(OUT + "TEST_PARENT_t2p5.png"));
        r.steps.push({ test: "C", t0: "TEST_PARENT_t0.png", t25: "TEST_PARENT_t2p5.png" });
    } catch (e) {
        r.errors.push(e.toString() + " @ line " + (e.line || "?"));
    }
    return JSON.stringify(r);
})();
