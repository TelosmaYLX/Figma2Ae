// Measure the plug-in render time on AB_PROG (progressive) and AB_UNI (uniform):
// a tiny parameter change invalidates the cache before each timed frame.
(function () {
    var BASE = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/";
    var OUT = BASE + "rea-work/ae-plugin-test/out/";
    var r = { progressive: [], uniform: [], errors: [] };

    function findComp(name) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem && it.name === name) return it;
        }
        return null;
    }

    function timeComp(compName, paramIndex, base) {
        var comp = findComp(compName);
        if (!comp) throw new Error(compName + " not found");
        var lyr = comp.layer("BlurAdj");
        var fx = lyr.property("Effects").property(1);
        var times = [];
        for (var k = 0; k < 5; k++) {
            fx.property(paramIndex).setValue(base + (k + 1) * 0.01);
            var t0 = new Date().getTime();
            comp.saveFrameToPng(0, new File(OUT + "_timing_" + compName + ".png"));
            var dt = new Date().getTime() - t0;
            times.push(dt);
        }
        fx.property(paramIndex).setValue(base);
        return times;
    }

    try {
        r.progressive = timeComp("AB_PROG", 4, 40); // 结束半径
        r.uniform = timeComp("AB_UNI", 2, 40); // 背景模糊半径
    } catch (e) {
        r.errors.push(e.toString() + " @ line " + (e.line || "?"));
    }
    return JSON.stringify(r);
})();
