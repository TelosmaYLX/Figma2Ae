// AE-level render timing for the "Figma 调色" plug-in.
//
// Builds two comps over the same footage (effect on / effect off) and renders
// them through the render queue, timing each pass. renderQueue.render() blocks,
// and an item that was queued with render=false can be enabled after the first
// pass, so both passes can be timed in one session.
(function () {
    var BASE = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/rea-work/perf-grade/";
    var OUT = BASE + "rq/";
    var r = { rows: [], errors: [] };
    var FRAMES = 30;
    var DESIGN = [-17, 5, 18, -26, 21, -21, 13];

    function ensureDir(p) {
        var f = new Folder(p);
        if (!f.exists) f.create();
        return f;
    }
    ensureDir(OUT);

    try {
        var photo = app.project.importFile(
            new ImportOptions(new File("D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/rea-work/image-grade/grade_photo.png")));

        function makeComp(name, withEffect) {
            var comp = app.project.items.addComp(name, 1200, 800, 1, FRAMES / 30, 30);
            var layer = comp.layers.add(photo);
            layer.property("Transform").property("Position").setValue([600, 400]);
            if (withEffect) {
                var fx = layer.property("Effects").addProperty("F2A Figma Image Grade");
                for (var i = 0; i < 7; i++) fx.property(i + 1).setValue(DESIGN[i]);
            }
            return comp;
        }

        var onComp = makeComp("TIME_ON", true);
        var offComp = makeComp("TIME_OFF", false);

        var onItem = app.project.renderQueue.items.add(onComp);
        onItem.outputModule(1).file = new File(OUT + "on.mp4");
        onItem.render = true;

        var offItem = app.project.renderQueue.items.add(offComp);
        offItem.outputModule(1).file = new File(OUT + "off.mp4");
        offItem.render = false;

        var t0 = new Date().getTime();
        app.project.renderQueue.render();
        var t1 = new Date().getTime();

        offItem.render = true;
        var t2 = new Date().getTime();
        app.project.renderQueue.render();
        var t3 = new Date().getTime();

        r.rows.push({
            frames: FRAMES,
            on_ms: t1 - t0,
            off_ms: t3 - t2,
            on_per_frame: Math.round((t1 - t0) / FRAMES * 10) / 10,
            off_per_frame: Math.round((t3 - t2) / FRAMES * 10) / 10,
            plugin_per_frame: Math.round(((t1 - t0) - (t3 - t2)) / FRAMES * 10) / 10
        });
    } catch (e) {
        r.errors.push(e.toString() + " @ line " + (e.line || "?"));
    }
    return JSON.stringify(r, null, 1);
})();
