// Build the v1.0 "Figma 调色" plug-in demo project.
//
//   REF_Figma导出      the real Figma PNG export (image fill with the seven filters)
//   AE_插件调色        the same source image graded by the plug-in (same seven values)
//   CMP_并排对比       Figma | plug-in side by side
//   ADJ_调整层调色     the effect on an adjustment layer (grades everything below)
//   DEMO_滑杆动画      keyframed exposure/contrast/saturation -> the live, re-editable path
//
// Renders stills + 90 frames for the demo movie into rea-work/image-grade/.
(function () {
    var BASE = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/";
    var IN = BASE + "rea-work/image-grade/";
    var FIGMA = IN + "figma/";
    var OUT = IN + "demo/";
    var FRAMES = OUT + "frames/";
    var r = { steps: [], errors: [] };
    var DESIGN = [-17, 5, 18, -26, 21, -21, 13];
    var MIXED = [32, -48, 61, -44, 25, 39, -67];

    function ensureDir(p) {
        var f = new Folder(p);
        if (!f.exists) f.create();
        return f;
    }
    ensureDir(OUT);
    ensureDir(FRAMES);

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
    function addLabel(comp, text, size, rgb8, x, y, bold) {
        var t = comp.layers.addText(text);
        t.name = "Label";
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
    function gradeLayer(comp, footage, values) {
        var layer = comp.layers.add(footage);
        var fx = layer.property("Effects").addProperty("F2A Figma Image Grade");
        for (var i = 0; i < 7; i++) fx.property(i + 1).setValue(values[i]);
        return { layer: layer, fx: fx };
    }
    function pad3(n) {
        var s = "" + n;
        while (s.length < 3) s = "0" + s;
        return s;
    }

    try {
        var fDemo = folder("01_Demo");
        var fRef = folder("02_Reference");
        var fCmp = folder("03_Compare");

        var source = app.project.importFile(new ImportOptions(new File(IN + "grade_photo.png")));
        source.name = "Source_Photo_1200x800";
        source.parentFolder = fRef;
        var figmaPng = app.project.importFile(new ImportOptions(new File(FIGMA + "532-555.png")));
        figmaPng.name = "Figma_Export_Mixed";
        figmaPng.parentFolder = fRef;

        // ---------- reference ----------
        var ref = app.project.items.addComp("REF_Figma导出", 1200, 800, 1, 1, 30);
        ref.parentFolder = fRef;
        ref.layers.add(figmaPng);
        addLabel(ref, "FIGMA EXPORT  (image filters: 32 -48 61 -44 25 39 -67)", 18, [255, 255, 255], 24, 30, true);
        r.steps.push("REF_Figma导出");

        // ---------- plug-in render ----------
        var ae = app.project.items.addComp("AE_插件调色", 1200, 800, 1, 1, 30);
        ae.parentFolder = fRef;
        var graded = gradeLayer(ae, source, MIXED);
        addLabel(ae, "AE PLUG-IN  Figma 调色 v1.0  (same seven values)", 18, [255, 255, 255], 24, 30, true);
        ae.saveFrameToPng(0, new File(OUT + "AE_graded.png"));
        r.steps.push("AE_插件调色");

        // ---------- side by side ----------
        var cmp = app.project.items.addComp("CMP_并排对比", 2400, 860, 1, 1, 30);
        cmp.parentFolder = fCmp;
        addSolid(cmp, "BG", [12, 12, 18], 2400, 860);
        var left = cmp.layers.add(figmaPng);
        left.property("Transform").property("Anchor Point").setValue([0, 0]);
        left.property("Transform").property("Position").setValue([0, 52]);
        var right = gradeLayer(cmp, source, MIXED);
        right.layer.property("Transform").property("Anchor Point").setValue([0, 0]);
        right.layer.property("Transform").property("Position").setValue([1200, 52]);
        addLabel(cmp, "FIGMA EXPORT", 20, [255, 255, 255], 24, 20, true);
        addLabel(cmp, "AE PLUG-IN  (Figma 调色 v1.0)", 20, [255, 255, 255], 1224, 20, true);
        cmp.saveFrameToPng(0, new File(OUT + "side_by_side.png"));
        r.steps.push("CMP_并排对比");

        // ---------- adjustment-layer variant ----------
        var adjComp = app.project.items.addComp("ADJ_调整层调色", 1200, 800, 1, 1, 30);
        adjComp.parentFolder = fDemo;
        addSolid(adjComp, "Backdrop", [30, 28, 60], 1200, 800);
        var adjLayer = addSolid(adjComp, "GradeAdj", [0, 0, 0], 1200, 800);
        adjLayer.adjustmentLayer = true;
        var adjFx = adjLayer.property("Effects").addProperty("F2A Figma Image Grade");
        for (var i = 0; i < 7; i++) adjFx.property(i + 1).setValue(DESIGN[i]);
        addCard(adjComp);
        addLabel(adjComp, "ADJUSTMENT LAYER  (grades everything below it)", 18, [255, 255, 255], 24, 30, true);
        adjComp.saveFrameToPng(0, new File(OUT + "adjustment_layer.png"));
        r.steps.push("ADJ_调整层调色");

        // ---------- keyframed demo ----------
        var demo = app.project.items.addComp("DEMO_滑杆动画", 1200, 800, 1, 3, 30);
        demo.parentFolder = fDemo;
        var d = gradeLayer(demo, source, DESIGN);
        d.fx.property(1).setValueAtTime(0, 0);
        d.fx.property(1).setValueAtTime(1.0, DESIGN[0]);
        d.fx.property(1).setValueAtTime(2.0, MIXED[0]);
        d.fx.property(1).setValueAtTime(3.0, DESIGN[0]);
        d.fx.property(2).setValueAtTime(0, 0);
        d.fx.property(2).setValueAtTime(1.0, DESIGN[1]);
        d.fx.property(2).setValueAtTime(2.0, MIXED[1]);
        d.fx.property(2).setValueAtTime(3.0, DESIGN[1]);
        d.fx.property(3).setValueAtTime(0, 0);
        d.fx.property(3).setValueAtTime(1.0, DESIGN[2]);
        d.fx.property(3).setValueAtTime(2.0, MIXED[2]);
        d.fx.property(3).setValueAtTime(3.0, DESIGN[2]);
        for (var k = 4; k <= 7; k++) {
            d.fx.property(k).setValueAtTime(1.0, DESIGN[k - 1]);
            d.fx.property(k).setValueAtTime(2.0, MIXED[k - 1]);
        }
        addLabel(demo, "FIGMA 调色  -  live sliders, keyframeable, no LUT baking", 20, [255, 255, 255], 24, 34, true);
        r.steps.push("DEMO_滑杆动画");
        demo.saveFrameToPng(0, new File(OUT + "demo_t0.png"));
        demo.saveFrameToPng(1.0, new File(OUT + "demo_t1.png"));
        demo.saveFrameToPng(2.0, new File(OUT + "demo_t2.png"));

        // ---------- demo movie frames ----------
        var t0 = new Date().getTime();
        var total = Math.round(demo.duration * 30);
        for (var f = 0; f < total; f++) {
            demo.saveFrameToPng(f / 30, new File(FRAMES + "f_" + pad3(f) + ".png"));
        }
        r.timing = { frames: total, ms: new Date().getTime() - t0 };
    } catch (e) {
        r.errors.push(e.toString() + " @ line " + (e.line || "?"));
    }

    function addCard(comp) {
        var lyr = comp.layers.addShape();
        lyr.name = "Card";
        var grp = lyr.property("Contents").addProperty("ADBE Vector Group");
        var rc = grp.property("Contents").addProperty("ADBE Vector Shape - Rect");
        rc.property("Size").setValue([460, 300]);
        rc.property("Roundness").setValue(28);
        var fill = grp.property("Contents").addProperty("ADBE Vector Graphic - Fill");
        fill.property("Color").setValue([1, 1, 1]);
        fill.property("Opacity").setValue(16);
        var stroke = grp.property("Contents").addProperty("ADBE Vector Graphic - Stroke");
        stroke.property("Color").setValue([1, 1, 1]);
        stroke.property("Opacity").setValue(32);
        stroke.property("Stroke Width").setValue(2);
        lyr.property("Transform").property("Anchor Point").setValue([0, 0]);
        lyr.property("Transform").property("Position").setValue([370, 250]);
        var t = comp.layers.addText("Graded backdrop behind this card");
        t.name = "CardText";
        var td = t.property("Source Text").value;
        td.fontSize = 22;
        td.fillColor = [1, 1, 1];
        td.applyFill = true;
        t.property("Source Text").setValue(td);
        t.property("Transform").property("Anchor Point").setValue([0, 0]);
        t.property("Transform").property("Position").setValue([400, 380]);
    }

    return JSON.stringify(r, null, 1);
})();
