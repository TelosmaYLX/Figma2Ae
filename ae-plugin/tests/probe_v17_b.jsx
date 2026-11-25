// v1.7 test B: host-mask region + parented adjustment layer + moving card.
// The mask follows the parent transform and the percentage ramp follows the
// mask bounds, so no keyframes are needed on the effect parameters.
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

    try {
        var c = app.project.items.addComp("DEMO_V17_MOVE", 1200, 800, 1, 5, 30);
        addSolid(c, "BG", [20, 18, 43], 1200, 800);
        addEllipse(c, "Circle_Purple", 120, 100, 520, 520, [108, 92, 231]);
        addEllipse(c, "Circle_Cyan", 740, 60, 380, 380, [0, 194, 203]);
        addEllipse(c, "Circle_Orange", 880, 480, 280, 280, [225, 112, 85]);
        addRect(c, "Rect_Yellow", 140, 560, 280, 170, 24, [253, 203, 110]);
        addEllipse(c, "Circle_White", 560, 250, 220, 220, [255, 255, 255]);
        addRect(c, "RED_ClampTest", 216, 330, 80, 80, 0, [255, 59, 48]);

        var adj = addSolid(c, "BlurAdj", [0, 0, 0], 1200, 800);
        adj.adjustmentLayer = true;
        var fx = adj.property("Effects").addProperty("F2A Figma Background Blur");
        fx.property(1).setValue(2);  // 渐变
        fx.property(3).setValue(0);  // 开始半径
        fx.property(4).setValue(40); // 结束半径
        // ramp stays at the defaults: 50% / 0%  ->  50% / 100% of the mask bounds

        var mask = adj.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
        mask.property("ADBE Mask Shape").setValue(roundedRectShape(200, 230, 760, 570, 32));
        mask.maskMode = MaskMode.ADD;
        mask.property("ADBE Mask Feather").setValue([0, 0]);

        var card = addCard(c, "GlassCard", 200, 230, 560, 340, 32, 14, 30, 2);
        addCard(c, "ControlCard", 900, 640, 220, 120, 20, 10, 25, 2);

        // parent the adjustment layer to the card, then animate ONLY the card
        adj.parent = card.fill;
        card.fill.property("Transform").property("Position").setValueAtTime(0, [480, 400]);
        card.fill.property("Transform").property("Position").setValueAtTime(2.5, [760, 400]);
        card.stroke.property("Transform").property("Position").setValueAtTime(0, [480, 400]);
        card.stroke.property("Transform").property("Position").setValueAtTime(2.5, [760, 400]);

        c.saveFrameToPng(0, new File(OUT + "DEMO_V17_MOVE_t0.png"));
        c.saveFrameToPng(2.5, new File(OUT + "DEMO_V17_MOVE_t2p5.png"));
        r.steps.push({ comp: c.name, t0: "DEMO_V17_MOVE_t0.png", t25: "DEMO_V17_MOVE_t2p5.png" });
    } catch (e) {
        r.errors.push(e.toString() + " @ line " + (e.line || "?"));
    }
    return JSON.stringify(r);
})();
