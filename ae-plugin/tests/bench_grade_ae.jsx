// End-to-end render timing for the "Figma 调色" plug-in.
//
// Renders the same comp twice through the render queue (synchronous) - once with
// the effect enabled and once disabled - and reports the per-frame difference,
// which is the plug-in's own render cost (PNG encoding etc. cancels out).
(function () {
    var BASE = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/rea-work/perf-grade/";
    var OUT = BASE + "rq/";
    var r = { rows: [], errors: [], notes: [] };

    function ensureDir(p) {
        var f = new Folder(p);
        if (!f.exists) f.create();
        return f;
    }
    function countPngs() {
        var f = new Folder(OUT);
        var files = f.getFiles("*.png");
        return files ? files.length : 0;
    }
    ensureDir(OUT);

    var photoPath = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/rea-work/image-grade/grade_photo.png";
    var pickPath = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/rea-work/figma-user-pick/source/481ada345282c1b47e5d36dd188f55a09c72b2df.png";
    var DESIGN = [-17, 5, 18, -26, 21, -21, 13];
    var FRAMES = 15;

    function buildComp(name, footage, w, h) {
        var comp = app.project.items.addComp(name, w, h, 1, FRAMES / 30, 30);
        var layer = comp.layers.add(footage);
        layer.property("Transform").property("Position").setValue([w / 2, h / 2]);
        var fx = layer.property("Effects").addProperty("F2A Figma Image Grade");
        for (var i = 0; i < 7; i++) fx.property(i + 1).setValue(DESIGN[i]);
        return { comp: comp, fx: fx };
    }

    function timeRender(comp, tag) {
        var item = app.project.renderQueue.items.add(comp);
        var om = item.outputModule(1);
        om.file = new File(OUT + tag + "_[####].png");
        var templateOk = false;
        try {
            om.applyTemplate("PNG序列");
            templateOk = true;
        } catch (e) {
            try {
                om.applyTemplate("PNG Sequence");
                templateOk = true;
            } catch (e2) { }
        }
        var before = countPngs();
        item.render = true;
        var t0 = new Date().getTime();
        app.project.renderQueue.render();
        var ms = new Date().getTime() - t0;
        item.render = false;
        return { ms: ms, templateOk: templateOk, written: countPngs() - before };
    }

    try {
        var photo = app.project.importFile(new ImportOptions(new File(photoPath)));
        var pick = app.project.importFile(new ImportOptions(new File(pickPath)));

        var cases = [
            { label: "1200x800", footage: photo, w: 1200, h: 800 },
            { label: "2560x1440", footage: pick, w: 2560, h: 1440 }
        ];

        for (var c = 0; c < cases.length; c++) {
            var cfg = cases[c];
            var built = buildComp("BENCH_" + cfg.label, cfg.footage, cfg.w, cfg.h);
            var on = timeRender(built.comp, cfg.label + "_on");
            built.fx.enabled = false;
            var off = timeRender(built.comp, cfg.label + "_off");
            built.fx.enabled = true;
            r.rows.push({
                size: cfg.label,
                frames: FRAMES,
                ms_on_per_frame: Math.round(on.ms / FRAMES * 10) / 10,
                ms_off_per_frame: Math.round(off.ms / FRAMES * 10) / 10,
                ms_plugin_per_frame: Math.round((on.ms - off.ms) / FRAMES * 10) / 10,
                templateOk: on.templateOk && off.templateOk,
                pngs_on: on.written,
                pngs_off: off.written
            });
        }
    } catch (e) {
        r.errors.push(e.toString() + " @ line " + (e.line || "?"));
    }
    return JSON.stringify(r, null, 1);
})();
