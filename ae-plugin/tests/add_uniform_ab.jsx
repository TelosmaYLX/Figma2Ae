// Add a clean uniform-mode A/B comp (no labels) and render it for the metrics.
(function () {
    var BASE = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/";
    var OUT = BASE + "rea-work/ae-plugin-test/out/";
    var r = { steps: [], errors: [] };

    function folder(name) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof FolderItem && it.name === name) return it;
        }
        return app.project.items.addFolder(name);
    }
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

    try {
        var cmpFolder = folder("03_Compare");
        var uni = app.project.items.addComp("AB_UNI", 1200, 800, 1, 5, 30);
        uni.parentFolder = cmpFolder;

        addSolid(uni, "BG", [20, 18, 43], 1200, 800);
        addEllipse(uni, "Circle_Purple", 120, 100, 520, 520, [108, 92, 231]);
        addEllipse(uni, "Circle_Cyan", 740, 60, 380, 380, [0, 194, 203]);
        addEllipse(uni, "Circle_Orange", 880, 480, 280, 280, [225, 112, 85]);
        addRect(uni, "Rect_Yellow", 140, 560, 280, 170, 24, [253, 203, 110]);
        addEllipse(uni, "Circle_White", 560, 250, 220, 220, [255, 255, 255]);
        addRect(uni, "RED_ClampTest", 216, 330, 80, 80, 0, [255, 59, 48]);

        var adj = addSolid(uni, "BlurAdj", [0, 0, 0], 1200, 800);
        adj.adjustmentLayer = true;
        var fx = adj.property("Effects").addProperty("F2A Figma Background Blur");

        // The card sits ABOVE the adjustment layer (Figma draws the translucent
        // fill and its stroke on top of the blurred backdrop).
        var card = addCard(uni, "GlassCard", 320, 230, 560, 340, 32, 14, 30, 2);
        addCard(uni, "ControlCard", 900, 640, 220, 120, 20, 10, 25, 2);

        fx.property(8).setValue(card.fill.index);  // Alpha源
        fx.property(1).setValue(1);                // 模式 = 均匀
        fx.property(2).setValue(40);               // 背景模糊半径
        fx.property(7).setValue(0);                // 柔化边缘 = off

        uni.saveFrameToPng(0, new File(OUT + "AB_V16_uniform.png"));
        r.steps.push({ comp: "AB_UNI", png: OUT + "AB_V16_uniform.png" });
        app.project.activeItem = uni;
    } catch (e) {
        r.errors.push(e.toString() + " @ line " + (e.line || "?"));
    }
    return JSON.stringify(r, null, 1);
})();
