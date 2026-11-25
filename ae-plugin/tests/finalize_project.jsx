// Finalize the delivery project: tidy labels/folders, activate demo comp, return comp ids.
(function () {
    var report = { comps: [], errors: [] };

    function getFolder(name, create) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof FolderItem && it.name === name) return it;
        }
        return create ? app.project.items.addFolder(name) : null;
    }

    function findComp(name) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem && it.name === name) return it;
        }
        return null;
    }

    try {
        var refc = findComp("REF_Figma_Original");
        if (refc) {
            for (var l = refc.numLayers; l >= 1; l--) {
                var L = refc.layer(l);
                if (L.name.indexOf("Label_") === 0) L.remove();
            }
        }
    } catch (e) { report.errors.push("ref label: " + e.toString()); }

    try {
        var cal = getFolder("04_Calibration", true);
        var names = ["PLUGIN_Impulse_R8", "PLUGIN_Step_R40", "AB_R40_HARD", "AB_R39_HARD", "AB_R385_HARD", "AB_R40_SOFT", "AB_MOVE"];
        for (var k = 0; k < names.length; k++) {
            var c = findComp(names[k]);
            if (c) { c.parentFolder = cal; report.comps.push({ name: c.name, id: c.id, folder: "04_Calibration" }); }
        }
    } catch (e) { report.errors.push("cal folder: " + e.toString()); }

    try {
        var demo = findComp("DEMO_Realtime_MovingGlassCard");
        if (demo) {
            demo.parentFolder = getFolder("01_Demo", true);
            app.project.activeItem = demo;
            report.comps.push({ name: demo.name, id: demo.id, folder: "01_Demo" });
        }
        var ref = findComp("REF_Figma_Original");
        if (ref) report.comps.push({ name: ref.name, id: ref.id, folder: "02_Reference" });
        var cmp = findComp("CMP_Figma_vs_AE");
        if (cmp) report.comps.push({ name: cmp.name, id: cmp.id, folder: "03_Compare" });
    } catch (e) { report.errors.push("folders: " + e.toString()); }

    report.project = app.project.file ? app.project.file.fsName : "(unsaved)";
    return JSON.stringify(report);
})();