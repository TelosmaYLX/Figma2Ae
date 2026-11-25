// Render DEMO comp frames 0..149 to PNG using the GUI AE instance (no aerender).
// Usage: ae_run_script_file. Returns the number of frames written.
(function () {
    var OUT = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/rea-work/ae-plugin-test/demo_frames/";
    var f = new Folder(OUT);
    if (!f.exists) f.create();
    var comp = null;
    for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof CompItem && it.name === "DEMO_Realtime_MovingGlassCard") comp = it;
    }
    if (!comp) return JSON.stringify({ error: "DEMO comp not found" });

    var total = Math.round(comp.duration * comp.frameRate); // 150
    var written = 0;
    var errors = [];
    for (var fr = 0; fr < total; fr++) {
        var name = OUT + "f_" + ("0000" + fr).slice(-4) + ".png";
        var file = new File(name);
        try {
            comp.saveFrameToPng(fr / comp.frameRate, file);
            written++;
        } catch (e) {
            errors.push("frame " + fr + ": " + e.toString());
            if (errors.length > 3) break;
        }
    }
    return JSON.stringify({ comp: comp.name, total: total, written: written, errors: errors, out: OUT });
})();