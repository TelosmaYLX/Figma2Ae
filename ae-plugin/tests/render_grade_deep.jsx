// Render the grade card at 16 bpc and 32 bpc for the deep-colour regression test.
(function () {
    var BASE = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/rea-work/";
    var OUT = BASE + "perf-grade/";
    var DESIGN = [-17, 5, 18, -26, 21, -21, 13];
    var r = { steps: [], errors: [] };
    try {
        var source = app.project.importFile(new ImportOptions(new File(BASE + "image-grade/grade_card_512.png")));

        function renderAt(bits, tag) {
            app.project.bitsPerChannel = bits;
            var comp = app.project.items.addComp("CARD_" + tag, 512, 512, 1, 1, 30);
            var layer = comp.layers.add(source);
            layer.property("Transform").property("Position").setValue([256, 256]);
            var fx = layer.property("Effects").addProperty("F2A Figma Image Grade");
            for (var i = 0; i < 7; i++) fx.property(i + 1).setValue(DESIGN[i]);
            comp.saveFrameToPng(0, new File(OUT + "v13_card_" + tag + ".png"));
            r.steps.push(tag + " queued");
        }

        renderAt(16, "16bpc");
        renderAt(32, "32bpc");
    } catch (e) {
        r.errors.push(e.toString() + " @ line " + (e.line || "?"));
    }
    return JSON.stringify(r);
})();
