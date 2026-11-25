// Build the render-queue benchmark project for the "Figma 调色" plug-in.
//
// Two render queue items over the same footage and comp settings:
//   1) BENCH_ON  - effect enabled with the design values
//   2) BENCH_OFF - no effect
// aerender renders each item separately (-rqindex), so the wall-clock difference
// is the plug-in's own per-frame cost.
(function () {
    var BASE = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/rea-work/perf-grade/";
    var OUT = BASE + "aerender/";
    var r = { steps: [], errors: [] };

    function ensureDir(p) {
        var f = new Folder(p);
        if (!f.exists) f.create();
        return f;
    }
    ensureDir(OUT);

    var photoPath = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/rea-work/image-grade/grade_photo.png";
    var DESIGN = [-17, 5, 18, -26, 21, -21, 13];
    var FRAMES = 45;

    try {
        var photo = app.project.importFile(new ImportOptions(new File(photoPath)));

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

        var on = makeComp("BENCH_ON", true);
        var off = makeComp("BENCH_OFF", false);

        function queue(comp, tag) {
            var item = app.project.renderQueue.items.add(comp);
            var om = item.outputModule(1);
            // Keep the host's default output module (MP4 here). The encoder cost is
            // the same for both passes, so the ON-OFF difference still isolates the
            // plug-in's render cost.
            om.file = new File(OUT + tag + ".mp4");
            item.render = true;
            return item;
        }
        queue(on, "on");
        queue(off, "off");

        r.steps.push("queue built", app.project.renderQueue.numItems + " items", FRAMES + " frames each");
        r.projectPath = BASE + "bench.aep";
    } catch (e) {
        r.errors.push(e.toString() + " @ line " + (e.line || "?"));
    }
    return JSON.stringify(r, null, 1);
})();
