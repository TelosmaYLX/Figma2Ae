// Build the delivery demo project for the "Figma Background Blur" AE plug-in.
// - imports the Figma original PNG as reference footage
// - builds a live demo comp (moving glass card over moving backdrop)
// - builds side-by-side comparison comp
// - renders stills and measures render time
// Run inside AE via F2A ae_run_script_file.

(function () {
    var BASE = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/";
    var OUT = BASE + "rea-work/ae-plugin-test/out/";
    var FIGMA_PNG = BASE + "rea-work/figma-ab/figma_original_1x.png";
    var report = { steps: [], errors: [], timing: [] };

    function folder(name) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof FolderItem && it.name === name) return it;
        }
        return app.project.items.addFolder(name);
    }

    function removeComp(name) {
        for (var i = app.project.numItems; i >= 1; i--) {
            var it = app.project.item(i);
            if (it instanceof CompItem && it.name === name) it.remove();
        }
    }

    function newComp(name, w, h, dur, fps, parentFolder) {
        removeComp(name);
        var c = app.project.items.addComp(name, w, h, 1, dur, fps);
        if (parentFolder) c.parentFolder = parentFolder;
        return c;
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

    function addText(comp, str, size, rgb8, x, y, justify) {
        var t = comp.layers.addText(str);
        t.name = "Label_" + str.substring(0, 12);
        var td = t.property("Source Text").value;
        td.fontSize = size;
        td.fillColor = [rgb8[0] / 255, rgb8[1] / 255, rgb8[2] / 255];
        td.applyFill = true;
        try { td.font = "Arial-BoldMT"; } catch (e) { }
        t.property("Source Text").setValue(td);
        t.property("Transform").property("Position").setValue([x, y]);
        if (justify === "right") {
            t.property("Transform").property("Anchor Point").setValue([t.sourceRectAtTime(0, false).width, 0]);
        }
        return t;
    }

    function buildScene(comp, withRedTest) {
        addSolid(comp, "BG", [20, 18, 43], comp.width, comp.height);
        var p = addEllipse(comp, "Circle_Purple", 120, 100, 520, 520, [108, 92, 231]);
        var c = addEllipse(comp, "Circle_Cyan", 740, 60, 380, 380, [0, 194, 203]);
        addEllipse(comp, "Circle_Orange", 880, 480, 280, 280, [225, 112, 85]);
        addRect(comp, "Rect_Yellow", 140, 560, 280, 170, 24, [253, 203, 110]);
        addEllipse(comp, "Circle_White", 560, 250, 220, 220, [255, 255, 255]);
        if (withRedTest) addRect(comp, "RED_ClampTest", 216, 330, 80, 80, 0, [255, 59, 48]);
        return { purple: p, cyan: c };
    }

    function importFigma(folderItem) {
        var f = new File(FIGMA_PNG);
        var io = new ImportOptions(f);
        var footage = app.project.importFile(io);
        footage.name = "Figma_Original_1200x800";
        if (folderItem) footage.parentFolder = folderItem;
        return footage;
    }

    var fDemo = folder("01_Demo");
    var fRef = folder("02_Reference");
    var fCmp = folder("03_Compare");
    var fCal = folder("04_Calibration");

    // ---------- reference comp ----------
    try {
        var refc = newComp("REF_Figma_Original", 1200, 800, 5, 30, fRef);
        var foot = importFigma(fRef);
        var refLayer = refc.layers.add(foot);
        addText(refc, "FIGMA ORIGINAL  (1200x800, bg blur R=40)", 16, [255, 255, 255], 24, 30);
        report.steps.push({ comp: "REF_Figma_Original", footage: foot.name });
    } catch (e) {
        report.errors.push("REF: " + e.toString());
    }

    // ---------- live demo comp ----------
    try {
        var demo = newComp("DEMO_Realtime_MovingGlassCard", 1200, 800, 5, 30, fDemo);
        var moved = buildScene(demo, true);
        var adj = addBlurAdjustment(demo, "BlurAdj", 40, 480, 400, 560, 340, 32, true);
        // card moves 480 -> 760 -> 480 over 5 s, background elements drift
        var fx = adj.fx;
        fx.property(2).setValueAtTime(0, 480);
        fx.property(2).setValueAtTime(2.5, 760);
        fx.property(2).setValueAtTime(5, 480);
        var card = addCard(demo, "GlassCard", 200, 230, 560, 340, 32, 14, 30, 2);
        var fillPos = card.fill.property("Transform").property("Position");
        var strokePos = card.stroke.property("Transform").property("Position");
        fillPos.setValueAtTime(0, [480, 400]);
        fillPos.setValueAtTime(2.5, [760, 400]);
        fillPos.setValueAtTime(5, [480, 400]);
        strokePos.setValueAtTime(0, [480, 400]);
        strokePos.setValueAtTime(2.5, [760, 400]);
        strokePos.setValueAtTime(5, [480, 400]);
        addCard(demo, "ControlCard", 900, 640, 220, 120, 20, 10, 25, 2);
        // background drift (makes the live blur visibly re-render)
        var purplePos = moved.purple.property("Transform").property("Position");
        purplePos.setValueAtTime(0, [380, 360]);
        purplePos.setValueAtTime(5, [420, 320]);
        var cyanPos = moved.cyan.property("Transform").property("Position");
        cyanPos.setValueAtTime(0, [930, 250]);
        cyanPos.setValueAtTime(5, [890, 300]);
        // labels
        addText(demo, "FIGMA BACKGROUND BLUR  -  AE PLUG-IN  (REALTIME)", 22, [255, 255, 255], 24, 40);
        addText(demo, "moving glass card  |  triangular kernel + shape clamp  |  R=40 px", 14, [210, 210, 225], 24, 66);
        report.steps.push({ comp: "DEMO_Realtime_MovingGlassCard" });
        demo.saveFrameToPng(0, new File(OUT + "DEMO_t0.png"));
        demo.saveFrameToPng(2.5, new File(OUT + "DEMO_t2p5.png"));
    } catch (e) {
        report.errors.push("DEMO: " + e.toString());
    }

    // ---------- side-by-side comparison comp ----------
    try {
        var cmp = newComp("CMP_Figma_vs_AE", 2400, 860, 5, 30, fCmp);
        // background bars
        addSolid(cmp, "BG", [12, 12, 18], 2400, 860);
        var refCompLayer = cmp.layers.add(refc);
        refCompLayer.property("Transform").property("Position").setValue([600, 430]);
        // add AB_R40_HARD comp layer (plugin render)
        var abComp = null;
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem && it.name === "AB_R40_HARD") { abComp = it; break; }
        }
        if (abComp) {
            var aeLayer = cmp.layers.add(abComp);
            aeLayer.property("Transform").property("Position").setValue([1800, 430]);
        }
        addText(cmp, "FIGMA ORIGINAL", 20, [255, 255, 255], 600, 40);
        addText(cmp, "AE PLUG-IN (Figma Background Blur)", 20, [255, 255, 255], 1800, 40);
        // divider line
        var div = cmp.layers.addShape();
        div.name = "divider";
        var g = div.property("Contents").addProperty("ADBE Vector Group");
        var rc = g.property("Contents").addProperty("ADBE Vector Shape - Rect");
        rc.property("Size").setValue([2, 860]);
        var fl = g.property("Contents").addProperty("ADBE Vector Graphic - Fill");
        fl.property("Color").setValue([1, 1, 1]);
        div.property("Transform").property("Anchor Point").setValue([0, 0]);
        div.property("Transform").property("Position").setValue([1200, 430]);
        div.property("Transform").property("Opacity").setValue(18);
        cmp.saveFrameToPng(0, new File(OUT + "CMP_Figma_vs_AE.png"));
        report.steps.push({ comp: "CMP_Figma_vs_AE" });
    } catch (e) {
        report.errors.push("CMP: " + e.toString());
    }

    // ---------- render time measurement ----------
    try {
        var timingComp = null;
        for (var j = 1; j <= app.project.numItems; j++) {
            var item = app.project.item(j);
            if (item instanceof CompItem && item.name === "AB_R40_HARD") { timingComp = item; break; }
        }
        if (timingComp) {
            var adjLayer = timingComp.layer("BlurAdj");
            var effect = adjLayer.property("Effects").property(1);
            for (var t = 0; t < 4; t++) {
                effect.property(1).setValue(40 + t * 0.1); // invalidate cache
                var t0 = new Date().getTime();
                timingComp.saveFrameToPng(0, new File(OUT + "_timing_temp.png"));
                var dt = new Date().getTime() - t0;
                report.timing.push(dt);
            }
            effect.property(1).setValue(40);
        }
    } catch (e) {
        report.errors.push("timing: " + e.toString());
    }

    return JSON.stringify(report);
})();