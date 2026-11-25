// Build the v1.3 delivery project (alpha/layer-driven blur region) and render stills.
(function () {
    var OUT = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/rea-work/ae-plugin-test/out/";
    var FIG = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/deliverables/FigmaBackgroundBlurPlugin/figma_original.png";
    var rep = { steps: [], errors: [] };

    app.newProject();

    function addEllipse(comp, name, x, y, w, h, rgb) {
        var l = comp.layers.addShape(); l.name = name;
        var g = l.property("Contents").addProperty("ADBE Vector Group");
        var e = g.property("Contents").addProperty("ADBE Vector Shape - Ellipse");
        e.property("Size").setValue([w, h]);
        var f = g.property("Contents").addProperty("ADBE Vector Graphic - Fill");
        f.property("Color").setValue([rgb[0]/255, rgb[1]/255, rgb[2]/255]);
        l.property("Transform").property("Anchor Point").setValue([0, 0]);
        l.property("Transform").property("Position").setValue([x + w/2, y + h/2]);
        return l;
    }
    function addRect(comp, name, x, y, w, h, rnd, rgb) {
        var l = comp.layers.addShape(); l.name = name;
        var g = l.property("Contents").addProperty("ADBE Vector Group");
        var q = g.property("Contents").addProperty("ADBE Vector Shape - Rect");
        q.property("Size").setValue([w, h]); q.property("Roundness").setValue(rnd || 0);
        var f = g.property("Contents").addProperty("ADBE Vector Graphic - Fill");
        f.property("Color").setValue([rgb[0]/255, rgb[1]/255, rgb[2]/255]);
        l.property("Transform").property("Anchor Point").setValue([0, 0]);
        l.property("Transform").property("Position").setValue([x + w/2, y + h/2]);
        return l;
    }
    function addCard(comp, name, x, y, w, h, rnd, fillOp, strokeOp, sw) {
        var fill = comp.layers.addShape(); fill.name = name + "_fill";
        var g1 = fill.property("Contents").addProperty("ADBE Vector Group");
        var q1 = g1.property("Contents").addProperty("ADBE Vector Shape - Rect");
        q1.property("Size").setValue([w, h]); q1.property("Roundness").setValue(rnd);
        var f1 = g1.property("Contents").addProperty("ADBE Vector Graphic - Fill");
        f1.property("Color").setValue([1, 1, 1]); f1.property("Opacity").setValue(fillOp);
        fill.property("Transform").property("Anchor Point").setValue([0, 0]);
        fill.property("Transform").property("Position").setValue([x + w/2, y + h/2]);
        var stroke = comp.layers.addShape(); stroke.name = name + "_stroke";
        var g2 = stroke.property("Contents").addProperty("ADBE Vector Group");
        var q2 = g2.property("Contents").addProperty("ADBE Vector Shape - Rect");
        var inset = sw/2;
        q2.property("Size").setValue([w - 2*inset, h - 2*inset]);
        q2.property("Roundness").setValue(Math.max(0, rnd - inset));
        var s2 = g2.property("Contents").addProperty("ADBE Vector Graphic - Stroke");
        s2.property("Color").setValue([1, 1, 1]); s2.property("Opacity").setValue(strokeOp);
        s2.property("Stroke Width").setValue(sw);
        stroke.property("Transform").property("Anchor Point").setValue([0, 0]);
        stroke.property("Transform").property("Position").setValue([x + w/2, y + h/2]);
        return { fill: fill, stroke: stroke };
    }
    function addScene(comp) {
        comp.layers.addSolid([20/255, 18/255, 43/255], "BG", comp.width, comp.height, 1);
        addEllipse(comp, "Circle_Purple", 120, 100, 520, 520, [108, 92, 231]);
        addEllipse(comp, "Circle_Cyan", 740, 60, 380, 380, [0, 194, 203]);
        addEllipse(comp, "Circle_Orange", 880, 480, 280, 280, [225, 112, 85]);
        addRect(comp, "Rect_Yellow", 140, 560, 280, 170, 24, [253, 203, 110]);
        addEllipse(comp, "Circle_White", 560, 250, 220, 220, [255, 255, 255]);
        addRect(comp, "RED_ClampTest", 216, 330, 80, 80, 0, [255, 59, 48]);
    }
    function addBlur(comp, card) {
        var adj = comp.layers.addSolid([0, 0, 0], "BlurAdj", comp.width, comp.height, 1);
        adj.adjustmentLayer = true;
        var fx = adj.property("ADBE Effect Parade").addProperty("F2A Figma Background Blur");
        fx.property(1).setValue(40);   // radius
        fx.property(2).setValue(0);    // soft AA off
        fx.property(3).setValue(card.fill.index); // shape layer = card fill layer alpha
        fx.property(4).setValue(0);    // debug off
        return { adj: adj, fx: fx };
    }

    // ---------- AB comp ----------
    try {
        var ab = app.project.items.addComp("AB_AlphaLayer", 1200, 800, 1, 5, 30);
        addScene(ab);
        var blur = addBlur(ab, { fill: { index: 1 } }); // placeholder, fixed later
        var card = addCard(ab, "GlassCard", 320, 230, 560, 340, 32, 14, 30, 2);
        var ctrl = addCard(ab, "ControlCard", 900, 640, 220, 120, 20, 10, 25, 2);
        blur.fx.property(3).setValue(card.fill.index);
        ab.saveFrameToPng(0, new File(OUT + "AB_V13.png"));
        rep.steps.push("AB_AlphaLayer rendered, card fill index=" + card.fill.index);
    } catch (e) { rep.errors.push("AB: " + e.toString()); }

    // ---------- moving demo ----------
    try {
        var demo = app.project.items.addComp("DEMO_AlphaLayer_Moving", 1200, 800, 1, 5, 30);
        addScene(demo);
        var card2 = addCard(demo, "GlassCard", 200, 230, 560, 340, 32, 14, 30, 2);
        addCard(demo, "ControlCard", 900, 640, 220, 120, 20, 10, 25, 2);
        var b2 = addBlur(demo, card2);
        // animate the card (fill + stroke) 480 -> 760 -> 480
        var fp = card2.fill.property("Transform").property("Position");
        var sp = card2.stroke.property("Transform").property("Position");
        fp.setValueAtTime(0, [480, 400]);
        fp.setValueAtTime(2.5, [760, 400]);
        fp.setValueAtTime(5, [480, 400]);
        sp.setValueAtTime(0, [480, 400]);
        sp.setValueAtTime(2.5, [760, 400]);
        sp.setValueAtTime(5, [480, 400]);
        // labels
        try {
            var t = demo.layers.addText("FIGMA BACKGROUND BLUR  -  AE PLUG-IN  (region = layer alpha)");
            var td = t.property("Source Text").value;
            td.fontSize = 22; td.fillColor = [1, 1, 1]; td.applyFill = true;
            t.property("Source Text").setValue(td);
            t.property("Transform").property("Position").setValue([24, 40]);
        } catch (e3) { rep.errors.push("label: " + e3.toString()); }
        demo.saveFrameToPng(0, new File(OUT + "DEMO_V13_t0.png"));
        demo.saveFrameToPng(2.5, new File(OUT + "DEMO_V13_t2p5.png"));
        rep.steps.push("DEMO_AlphaLayer_Moving rendered");
    } catch (e) { rep.errors.push("DEMO: " + e.toString()); }

    // ---------- reference + compare ----------
    try {
        var foot = app.project.importFile(new ImportOptions(new File(FIG)));
        foot.name = "Figma_Original_1200x800";
        var ref = app.project.items.addComp("REF_Figma_Original", 1200, 800, 1, 5, 30);
        ref.layers.add(foot);
        var cmp = app.project.items.addComp("CMP_Figma_vs_AE", 2400, 860, 1, 5, 30);
        cmp.layers.addSolid([12/255, 12/255, 18/255], "BG", 2400, 860, 1);
        var l1 = cmp.layers.add(ref);
        l1.property("Transform").property("Position").setValue([600, 430]);
        var l2 = cmp.layers.add(app.project.itemByName("AB_AlphaLayer") || app.project.items.addComp("dummy", 10, 10, 1, 1, 30));
        // find AB comp properly
        var abComp = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem && it.name === "AB_AlphaLayer") abComp = it;
        }
        if (l2 && l2.source && abComp && l2.source.id !== abComp.id) { l2.remove(); l2 = cmp.layers.add(abComp); }
        else if (!l2 || !l2.source) { l2 = cmp.layers.add(abComp); }
        l2.property("Transform").property("Position").setValue([1800, 430]);
        cmp.saveFrameToPng(0, new File(OUT + "CMP_V13.png"));
        rep.steps.push("REF + CMP rendered");
    } catch (e) { rep.errors.push("REF/CMP: " + e.toString()); }

    // folder organisation
    try {
        var fDemo = app.project.items.addFolder("01_Demo");
        var fRef = app.project.items.addFolder("02_Reference");
        var fCmp = app.project.items.addFolder("03_Compare");
        for (var j = 1; j <= app.project.numItems; j++) {
            var item = app.project.item(j);
            if (item instanceof CompItem) {
                if (item.name === "DEMO_AlphaLayer_Moving") item.parentFolder = fDemo;
                else if (item.name === "REF_Figma_Original") item.parentFolder = fRef;
                else if (item.name === "CMP_Figma_vs_AE") item.parentFolder = fCmp;
                else item.parentFolder = fDemo;
            }
        }
        rep.steps.push("folders ok");
    } catch (e) { rep.errors.push("folders: " + e.toString()); }

    return JSON.stringify(rep);
})();