// Build the v1.6 plug-in demo project:
//   REF_Figma_Progressive  - the Figma export (reference)
//   AB_PROG                - the plug-in render used for the fidelity metrics
//   DEMO_Progressive       - animated glass card, progressive ramp keyframed
//   DEMO_Uniform           - same scene in uniform mode (shows the greyed-out
//                            progressive-only parameters)
//   CMP_Progressive        - Figma | plug-in side by side
// Also renders the stills and the 150 PNG frames for the demo movie.
// Run inside AE via F2A ae_run_script_file.
(function () {
    var BASE = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/";
    var OUT = BASE + "rea-work/ae-plugin-test/out/";
    var FRAMES = OUT + "demo_frames_v16/";
    var FIGMA_PNG = BASE + "rea-work/figma-progressive/505-1200.png";
    var DELIV = BASE + "deliverables/FigmaBackgroundBlurPlugin/";
    var r = { steps: [], errors: [], timing: [], params: {} };

    function ensureDir(p) {
        var f = new Folder(p);
        if (!f.exists) f.create();
        return f;
    }
    ensureDir(FRAMES);

    function folder(name) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof FolderItem && it.name === name) return it;
        }
        return app.project.items.addFolder(name);
    }

    function newComp(name, w, h, dur, fps, parentFolder) {
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

    function addLabel(comp, text, size, rgb8, x, y, bold) {
        var t = comp.layers.addText(text);
        t.name = "Label_" + text.substring(0, 14);
        var td = t.property("Source Text").value;
        td.fontSize = size;
        td.fillColor = [rgb8[0] / 255, rgb8[1] / 255, rgb8[2] / 255];
        td.applyFill = true;
        try {
            td.font = bold ? "Arial-BoldMT" : "ArialMT";
        } catch (e) { }
        t.property("Source Text").setValue(td);
        t.property("Transform").property("Anchor Point").setValue([0, 0]);
        t.property("Transform").property("Position").setValue([x, y]);
        return t;
    }

    function buildScene(comp) {
        addSolid(comp, "BG", [20, 18, 43], comp.width, comp.height);
        var purple = addEllipse(comp, "Circle_Purple", 120, 100, 520, 520, [108, 92, 231]);
        var cyan = addEllipse(comp, "Circle_Cyan", 740, 60, 380, 380, [0, 194, 203]);
        addEllipse(comp, "Circle_Orange", 880, 480, 280, 280, [225, 112, 85]);
        addRect(comp, "Rect_Yellow", 140, 560, 280, 170, 24, [253, 203, 110]);
        addEllipse(comp, "Circle_White", 560, 250, 220, 220, [255, 255, 255]);
        addRect(comp, "RED_ClampTest", 216, 330, 80, 80, 0, [255, 59, 48]);
        return { purple: purple, cyan: cyan };
    }

    function addBlurAdjustment(comp) {
        var lyr = addSolid(comp, "BlurAdj", [0, 0, 0], comp.width, comp.height);
        lyr.adjustmentLayer = true;
        var fx = lyr.property("Effects").addProperty("F2A Figma Background Blur");
        return { layer: lyr, fx: fx };
    }

    function paramNames(fx) {
        var names = {};
        for (var i = 1; i <= fx.numProperties; i++) names[i] = fx.property(i).name;
        return names;
    }

    function pad3(n) {
        var s = "" + n;
        while (s.length < 3) s = "0" + s;
        return s;
    }

    try {
        // The project is cleared by the caller (F2A ae_new_project) so AE does
        // not pop a "save changes?" dialog in the middle of the script.
        var fDemo = folder("01_Demo");
        var fRef = folder("02_Reference");
        var fCmp = folder("03_Compare");

        // ---------- reference (Figma export) ----------
        var refc = newComp("REF_Figma_Progressive", 1200, 800, 5, 30, fRef);
        var io = new ImportOptions(new File(FIGMA_PNG));
        var footage = app.project.importFile(io);
        footage.name = "Figma_Progressive_1200x800";
        footage.parentFolder = fRef;
        refc.layers.add(footage);
        addLabel(refc, "FIGMA ORIGINAL  (progressive: start 0 / end 40)", 16, [255, 255, 255], 24, 30, true);
        r.steps.push({ comp: "REF_Figma_Progressive" });

        // ---------- AB_PROG: the plug-in render used for the metrics ----------
        var ab = newComp("AB_PROG", 1200, 800, 5, 30, fCmp);
        buildScene(ab);
        // Layering matters: the adjustment layer sits ABOVE the backdrop shapes
        // and BELOW the glass card, exactly like Figma's backdrop-blur (blur the
        // backdrop, then draw the translucent fill and its stroke on top).
        var abAdj = addBlurAdjustment(ab);
        var abCard = addCard(ab, "GlassCard", 320, 230, 560, 340, 32, 14, 30, 2);
        addCard(ab, "ControlCard", 900, 640, 220, 120, 20, 10, 25, 2);
        abAdj.fx.property(8).setValue(abCard.fill.index); // Alpha源 -> ramp snaps to the card
        abAdj.fx.property(1).setValue(2); // 模式 = 渐变
        abAdj.fx.property(3).setValue(0); // 开始半径
        abAdj.fx.property(4).setValue(40); // 结束半径
        abAdj.fx.property(7).setValue(0); // 柔化边缘 = off (same as Figma's hard discard)
        r.params["AB_PROG"] = paramNames(abAdj.fx);
        ab.saveFrameToPng(0, new File(OUT + "AB_V16_final.png"));
        r.steps.push({ comp: "AB_PROG", png: OUT + "AB_V16_final.png" });

        // ---------- DEMO_Progressive: animated card, keyframed ramp ----------
        var demo = newComp("DEMO_Progressive", 1200, 800, 5, 30, fDemo);
        var demoScene = buildScene(demo);
        var demoAdj = addBlurAdjustment(demo);
        var demoCard = addCard(demo, "GlassCard", 200, 230, 560, 340, 32, 14, 30, 2);
        addCard(demo, "ControlCard", 900, 640, 220, 120, 20, 10, 25, 2);
        demoAdj.fx.property(8).setValue(demoCard.fill.index);
        demoAdj.fx.property(1).setValue(2);
        demoAdj.fx.property(3).setValue(0);
        demoAdj.fx.property(4).setValue(40);

        // card moves 480 -> 760 -> 480
        var fillPos = demoCard.fill.property("Transform").property("Position");
        var strokePos = demoCard.stroke.property("Transform").property("Position");
        fillPos.setValueAtTime(0, [480, 400]);
        fillPos.setValueAtTime(2.5, [760, 400]);
        fillPos.setValueAtTime(5, [480, 400]);
        strokePos.setValueAtTime(0, [480, 400]);
        strokePos.setValueAtTime(2.5, [760, 400]);
        strokePos.setValueAtTime(5, [480, 400]);

        // the ramp endpoints follow the card (they are layer-space pixels)
        var rampStart = demoAdj.fx.property(5);
        var rampEnd = demoAdj.fx.property(6);
        rampStart.setValueAtTime(0, [480, 230]);
        rampStart.setValueAtTime(2.5, [760, 230]);
        rampStart.setValueAtTime(5, [480, 230]);
        rampEnd.setValueAtTime(0, [480, 570]);
        rampEnd.setValueAtTime(2.5, [760, 570]);
        rampEnd.setValueAtTime(5, [480, 570]);

        // background drift
        demoScene.purple.property("Transform").property("Position").setValueAtTime(0, [380, 360]);
        demoScene.purple.property("Transform").property("Position").setValueAtTime(5, [420, 320]);
        demoScene.cyan.property("Transform").property("Position").setValueAtTime(0, [930, 250]);
        demoScene.cyan.property("Transform").property("Position").setValueAtTime(5, [890, 300]);

        addLabel(demo, "FIGMA BACKGROUND BLUR  -  AE PLUG-IN  (progressive)", 22, [255, 255, 255], 24, 40, true);
        addLabel(demo, "start 0 px  ->  end 40 px   |   ramp = card top-centre -> bottom-centre", 14, [210, 210, 225], 24, 68, false);
        r.steps.push({ comp: "DEMO_Progressive" });
        demo.saveFrameToPng(0, new File(OUT + "DEMO_V16_t0.png"));
        demo.saveFrameToPng(2.5, new File(OUT + "DEMO_V16_t2p5.png"));

        // ---------- DEMO_Uniform: uniform mode (progressive params greyed) ----------
        var uni = newComp("DEMO_Uniform", 1200, 800, 5, 30, fDemo);
        var uniScene = buildScene(uni);
        var uniAdj = addBlurAdjustment(uni);
        var uniCard = addCard(uni, "GlassCard", 320, 230, 560, 340, 32, 14, 30, 2);
        addCard(uni, "ControlCard", 900, 640, 220, 120, 20, 10, 25, 2);
        uniAdj.fx.property(8).setValue(uniCard.fill.index);
        uniAdj.fx.property(1).setValue(1); // 均匀
        uniAdj.fx.property(2).setValue(40); // 背景模糊半径
        uniScene.purple.property("Transform").property("Position").setValueAtTime(0, [380, 360]);
        uniScene.purple.property("Transform").property("Position").setValueAtTime(5, [420, 320]);
        addLabel(uni, "UNIFORM MODE  (progressive-only parameters are greyed out)", 20, [255, 255, 255], 24, 40, true);
        uni.saveFrameToPng(0, new File(OUT + "DEMO_V16_uniform.png"));
        r.steps.push({ comp: "DEMO_Uniform" });

        // ---------- CMP_Progressive: side by side ----------
        var cmp = newComp("CMP_Progressive", 2400, 860, 5, 30, fCmp);
        addSolid(cmp, "BG", [12, 12, 18], 2400, 860);
        var refLayer = cmp.layers.add(refc);
        refLayer.property("Transform").property("Anchor Point").setValue([0, 0]);
        refLayer.property("Transform").property("Position").setValue([0, 30]);
        var abLayer = cmp.layers.add(ab);
        abLayer.property("Transform").property("Anchor Point").setValue([0, 0]);
        abLayer.property("Transform").property("Position").setValue([1200, 30]);
        addLabel(cmp, "FIGMA ORIGINAL", 20, [255, 255, 255], 24, 8, true);
        addLabel(cmp, "AE PLUG-IN  (Figma Background Blur v1.6)", 20, [255, 255, 255], 1224, 8, true);
        cmp.saveFrameToPng(0, new File(OUT + "CMP_V16.png"));
        r.steps.push({ comp: "CMP_Progressive" });

        // ---------- render the demo movie frames ----------
        var t0 = new Date().getTime();
        var fps = 30;
        var total = Math.round(demo.duration * fps);
        for (var f = 0; f < total; f++) {
            demo.saveFrameToPng(f / fps, new File(FRAMES + "f_" + pad3(f) + ".png"));
        }
        var t1 = new Date().getTime();
        r.timing.push({ frames: total, ms: t1 - t0, ms_per_frame: (t1 - t0) / total });

        // ---------- save the project ----------
        // The project is saved by the caller (F2A ae_save_project) so AE does
        // not pop a Save As dialog in the middle of the script.
    } catch (e) {
        r.errors.push(e.toString() + " @ line " + (e.line || "?"));
    }

    return JSON.stringify(r, null, 1);
})();
