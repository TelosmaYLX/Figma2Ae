// Validate the "Figma 调色" plug-in against the Python reference renders.
// Renders the colour card, the photo-like image and the alpha image with several
// parameter sets into rea-work/image-grade/ae/.
(function () {
    var IN = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/rea-work/image-grade/";
    var OUT = IN + "ae/";
    var r = { steps: [], errors: [] };

    function ensureDir(p) {
        var f = new Folder(p);
        if (!f.exists) f.create();
        return f;
    }
    ensureDir(OUT);

    var sets = [
        { name: "P0_design", p: [-17, 5, 18, -26, 21, -21, 13] },
        { name: "P1_zero", p: [0, 0, 0, 0, 0, 0, 0] },
        { name: "P2_extreme", p: [100, -100, 100, -100, 100, -100, 100] },
        { name: "P3_sat", p: [0, 0, 60, 0, 0, 0, 0] },
        { name: "P4_exposure", p: [-50, 0, 0, 0, 0, 0, 0] },
        { name: "P5_warm", p: [0, 0, 0, 45, -30, 20, -20] },
        { name: "P6_mixed", p: [32, -48, 61, -44, 25, 39, -67] }
    ];

    function importPng(path) {
        var io = new ImportOptions(new File(path));
        var item = app.project.importFile(io);
        return item;
    }

    function buildComp(name, footage, params, withBlack) {
        var comp = app.project.items.addComp(name, footage.width, footage.height, 1, 1, 24);
        if (withBlack) {
            var bg = comp.layers.addSolid([0, 0, 0], "Black", comp.width, comp.height, 1);
            bg.moveToEnd();
        }
        var layer = comp.layers.add(footage);
        var fx;
        try {
            fx = layer.property("Effects").addProperty("F2A Figma Image Grade");
        } catch (e2) {
            fx = layer.property("Effects").addProperty("Figma 调色");
        }
        for (var i = 0; i < 7; i++) {
            fx.property(i + 1).setValue(params[i]);
        }
        return { comp: comp, layer: layer, fx: fx };
    }

    try {
        var card = importPng(IN + "grade_card_512.png");
        var photo = importPng(IN + "grade_photo.png");
        var alpha = importPng(IN + "grade_alpha.png");

        for (var s = 0; s < sets.length; s++) {
            var built = buildComp("CARD_" + sets[s].name, card, sets[s].p, false);
            built.comp.saveFrameToPng(0, new File(OUT + "card_" + sets[s].name + ".png"));
            r.steps.push("card_" + sets[s].name);
            built.comp.remove();
        }

        var p0 = buildComp("PHOTO_P0", photo, sets[0].p, false);
        p0.comp.saveFrameToPng(0, new File(OUT + "photo_P0_design.png"));
        p0.comp.remove();
        var p6 = buildComp("PHOTO_P6", photo, sets[6].p, false);
        p6.comp.saveFrameToPng(0, new File(OUT + "photo_P6_mixed.png"));
        p6.comp.remove();

        // alpha image on black: compares the premultiply path against a flattened reference
        var a0 = buildComp("ALPHA_P0", alpha, sets[0].p, true);
        a0.comp.saveFrameToPng(0, new File(OUT + "alpha_P0_on_black.png"));
        a0.comp.remove();
        var a1 = buildComp("ALPHA_P1", alpha, sets[1].p, true);
        a1.comp.saveFrameToPng(0, new File(OUT + "alpha_P1_on_black.png"));
        a1.comp.remove();

        // effect name + parameter names, for the report
        var probe = buildComp("PROBE", card, sets[0].p, false);
        var names = [];
        for (var k = 1; k <= probe.fx.numProperties; k++) {
            names.push(probe.fx.property(k).name + "=" + probe.fx.property(k).value);
        }
        r.params = names;
        r.matchName = probe.fx.matchName;
        probe.comp.remove();
    } catch (e) {
        r.errors.push(e.toString() + " @ line " + (e.line || "?"));
    }
    return JSON.stringify(r, null, 1);
})();
