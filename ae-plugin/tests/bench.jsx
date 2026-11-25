// Measure real render time of the plug-in across unique (uncached) frames of the DEMO comp.
(function () {
    var OUT = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/rea-work/ae-plugin-test/out/";
    var report = { times: [], errors: [] };
    var demo = null;
    for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof CompItem && it.name === "DEMO_Realtime_MovingGlassCard") demo = it;
    }
    if (!demo) return JSON.stringify({ error: "demo comp not found" });
    var t0 = new Date().getTime();
    demo.saveFrameToPng(0, new File(OUT + "_bench_first.png"));
    report.firstFrameMs = new Date().getTime() - t0;
    var sampleTimes = [3.1, 3.33, 3.55, 3.77, 4.0];
    for (var k = 0; k < sampleTimes.length; k++) {
        var st = new Date().getTime();
        demo.saveFrameToPng(sampleTimes[k], new File(OUT + "_bench_" + k + ".png"));
        report.times.push({ time: sampleTimes[k], ms: new Date().getTime() - st });
    }
    return JSON.stringify(report);
})();