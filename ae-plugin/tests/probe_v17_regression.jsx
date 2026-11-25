// v1.7 regression: legacy "Alpha源" mode (per-pixel alpha region) and uniform
// mode with the host mask, both still matching the Figma references.
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
    function scene(comp) {
        addSolid(comp, "BG", [20, 18, 43], comp.width, comp.height);
        addEllipse(comp, "Circle_Purple", 120, 100, 520, 520, [108, 92, 231]);
        addEllipse(comp, "Circle_Cyan", 740, 60, 380, 380, [0, 194, 203]);
        addEllipse(comp, "Circle_Orange", 880, 480, 280, 280, [225, 112, 85]);
        addRect(comp, "Rect_Yellow", 140, 560, 280, 170, 24, [253, 203, 110]);
        addEllipse(comp, "Circle_White", 560, 250, 220, 220, [255, 255, 255]);
        addRect(comp, "RED_ClampTest", 216, 330, 80, 80, 0, [255, 59, 48]);
    }

    try {
        // legacy Alpha源 mode (no mask): region from the card fill layer's alpha
        var a = app.project.items.addComp("AB_V17_ALPHA", 1200, 800, 1, 5, 30);
        scene(a);
        var aAdj = addSolid(a, "BlurAdj", [0, 0, 0], 1200, 800);
        aAdj.adjustmentLayer = true;
        var aFx = aAdj.property("Effects").addProperty("F2A Figma Background Blur");
        var aCard = addCard(a, "GlassCard", 320, 230, 560, 340, 32, 14, 30, 2);
        addCard(a, "ControlCard", 900, 640, 220, 120, 20, 10, 25, 2);
        aFx.property(10).setValue(aCard.fill.index); // Alpha源
        aFx.property(1).setValue(2);                 // 渐变
        aFx.property(3).setValue(0);
        aFx.property(4).setValue(40);
        a.saveFrameToPng(0, new File(OUT + "AB_V17_ALPHA.png"));
        r.steps.push({ comp: "AB_V17_ALPHA" });

        // uniform mode with the host mask (same look as the uniform Figma reference)
        var b = app.project.items.addComp("AB_V17_UNI", 1200, 800, 1, 5, 30);
        scene(b);
        var bAdj = addSolid(b, "BlurAdj", [0, 0, 0], 1200, 800);
        bAdj.adjustmentLayer = true;
        var bFx = bAdj.property("Effects").addProperty("F2A Figma Background Blur");
        bFx.property(1).setValue(1);  // 均匀
        bFx.property(2).setValue(40); // 背景模糊半径
        var bMask = bAdj.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
        bMask.property("ADBE Mask Shape").setValue(roundedRectShape(320, 230, 880, 570, 32));
        bMask.maskMode = MaskMode.ADD;
        bMask.property("ADBE Mask Feather").setValue([0, 0]);
        addCard(b, "GlassCard", 320, 230, 560, 340, 32, 14, 30, 2);
        addCard(b, "ControlCard", 900, 640, 220, 120, 20, 10, 25, 2);
        b.saveFrameToPng(0, new File(OUT + "AB_V17_UNI.png"));
        r.steps.push({ comp: "AB_V17_UNI" });
    } catch (e) {
        r.errors.push(e.toString() + " @ line " + (e.line || "?"));
    }
    return JSON.stringify(r);
})();
