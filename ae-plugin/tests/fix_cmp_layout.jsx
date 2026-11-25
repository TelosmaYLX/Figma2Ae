// Tidy the CMP_Progressive layout (labels were clipped at the top) and re-render it.
(function () {
    var BASE = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/";
    var OUT = BASE + "rea-work/ae-plugin-test/out/";
    var r = { steps: [], errors: [] };

    function findComp(name) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem && it.name === name) return it;
        }
        return null;
    }

    try {
        var cmp = findComp("CMP_Progressive");
        if (!cmp) throw new Error("CMP_Progressive not found");
        for (var i = 1; i <= cmp.numLayers; i++) {
            var L = cmp.layer(i);
            if (L.name.indexOf("Label_") === 0) {
                L.property("Transform").property("Anchor Point").setValue([0, 0]);
                L.property("Transform").property("Position").setValue([L.name.indexOf("AE") >= 0 ? 1224 : 24, 20]);
            } else if (L.source instanceof CompItem) {
                L.property("Transform").property("Position").setValue([L.source.name.indexOf("REF") === 0 ? 0 : 1200, 52]);
            }
        }
        cmp.saveFrameToPng(0, new File(OUT + "CMP_V16.png"));
        r.steps.push({ comp: cmp.name, png: OUT + "CMP_V16.png" });
    } catch (e) {
        r.errors.push(e.toString() + " @ line " + (e.line || "?"));
    }
    return JSON.stringify(r);
})();
