// Stimulus for profiling: render distinct frames of the demo comps so AE really
// renders them (saveFrameToPng returns before the async render finishes, so this
// script only queues work; read the FGB_PROFILE_LOG afterwards).
(function () {
    var BASE = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/";
    var OUT = BASE + "rea-work/ae-plugin-test/out/";
    var r = { errors: [], queued: [] };

    function findComp(name) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem && it.name === name) return it;
        }
        return null;
    }

    try {
        var names = ["DEMO_Progressive", "DEMO_Uniform"];
        for (var n = 0; n < names.length; n++) {
            var c = findComp(names[n]);
            if (!c) continue;
            for (var f = 0; f < 12; f++) {
                c.saveFrameToPng(f / 30, new File(OUT + "_prof_" + names[n] + ".png"));
            }
            r.queued.push(names[n]);
        }
    } catch (e) {
        r.errors.push(e.toString());
    }
    return JSON.stringify(r);
})();
