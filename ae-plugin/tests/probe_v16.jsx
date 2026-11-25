// Probe the v1.6 "Figma Background Blur" plug-in: default parameter values,
// progressive-mode setup and a reference render.
// Run inside AE via F2A ae_run_script_file.
(function () {
    var BASE = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/";
    var OUT = BASE + "rea-work/ae-plugin-test/out/";
    var r = { params: [], errors: [], notes: [] };

    function ensureDir(p) {
        var f = new Folder(p);
        if (!f.exists) f.create();
    }
    ensureDir(OUT);

    function addSolid(comp, name, rgb8, w, h) {
        return comp.layers.addSolid([rgb8[0] / 255, rgb8[1] / 255, rgb8[2] / 255], name, w, h, 1);
    }

    function setPos(lyr, cx, cy) {
        var t = lyr.property("Transform");
        t.property("Anchor Point").setValue([0, 0]);
        t.property("Position").setValue([cx, cy]);
    }

    function addEllipse(comp, name, x, y, w, h, rgb8) {
        var lyr = comp.layers.addShape();
        lyr.name = name;
        var grp = lyr.property("Contents").addProperty("ADBE Vector Group");
        var el = grp.property("Contents").addProperty("ADBE Vector Shape - Ellipse");
        el.property("Size").setValue([w, h]);
        var fill = grp.property("Contents").addProperty("ADBE Vector Graphic - Fill");
        fill.property("Color").setValue([rgb8[0] / 255, rgb8[1] / 255, rgb8[2] / 255]);
        setPos(lyr, x + w / 2, y + h / 2);
        return lyr;
    }

    function addRect(comp, name, x, y, w, h, roundness, rgb8) {
        var lyr = comp.layers.addShape();
        lyr.name = name;
        var grp = lyr.property("Contents").addProperty("ADBE Vector Group");
        var rc = grp.property("Contents").addProperty("ADBE Vector Shape - Rect");
        rc.property("Size").setValue([w, h]);
        rc.property("Roundness").setValue(roundness || 0);
        var fill = grp.property("Contents").addProperty("ADBE Vector Graphic - Fill");
        fill.property("Color").setValue([rgb8[0] / 255, rgb8[1] / 255, rgb8[2] / 255]);
        setPos(lyr, x + w / 2, y + h / 2);
        return lyr;
    }

    function addCard(comp, name, x, y, w, h, roundness, fillOpacityPct, strokeOpacityPct, strokeWidth) {
        var cx = x + w / 2;
        var cy = y + h / 2;

        var fillLyr = comp.layers.addShape();
        fillLyr.name = name + "_fill";
        var g1 = fillLyr.property("Contents").addProperty("ADBE Vector Group");
        var r1 = g1.property("Contents").addProperty("ADBE Vector Shape - Rect");
        r1.property("Size").setValue([w, h]);
        r1.property("Roundness").setValue(roundness || 0);
        var f1 = g1.property("Contents").addProperty("ADBE Vector Graphic - Fill");
        f1.property("Color").setValue([1, 1, 1]);
        f1.property("Opacity").setValue(fillOpacityPct);
        setPos(fillLyr, cx, cy);

        var strokeLyr = comp.layers.addShape();
        strokeLyr.name = name + "_stroke";
        var g2 = strokeLyr.property("Contents").addProperty("ADBE Vector Group");
        var r2 = g2.property("Contents").addProperty("ADBE Vector Shape - Rect");
        var inset = (strokeWidth || 2) / 2;
        r2.property("Size").setValue([w - 2 * inset, h - 2 * inset]);
        r2.property("Roundness").setValue(Math.max(0, (roundness || 0) - inset));
        var s2 = g2.property("Contents").addProperty("ADBE Vector Graphic - Stroke");
        s2.property("Color").setValue([1, 1, 1]);
        s2.property("Opacity").setValue(strokeOpacityPct);
        s2.property("Stroke Width").setValue(strokeWidth);
        setPos(strokeLyr, cx, cy);

        return { fill: fillLyr, stroke: strokeLyr };
    }

    try {
        app.newProject();
        var comp = app.project.items.addComp("PROBE_V16", 1200, 800, 1, 5, 30);

        addSolid(comp, "BG", [20, 18, 43], 1200, 800);
        addEllipse(comp, "Circle_Purple", 120, 100, 520, 520, [108, 92, 231]);
        addEllipse(comp, "Circle_Cyan", 740, 60, 380, 380, [0, 194, 203]);
        addEllipse(comp, "Circle_Orange", 880, 480, 280, 280, [225, 112, 85]);
        addRect(comp, "Rect_Yellow", 140, 560, 280, 170, 24, [253, 203, 110]);
        addEllipse(comp, "Circle_White", 560, 250, 220, 220, [255, 255, 255]);
        addRect(comp, "RED_ClampTest", 216, 330, 80, 80, 0, [255, 59, 48]);

        var adj = addSolid(comp, "BlurAdj", [0, 0, 0], comp.width, comp.height);
        adj.adjustmentLayer = true;
        var fx = adj.property("Effects").addProperty("F2A Figma Background Blur");

        // --- read every parameter (defaults straight after apply) ---
        var n = fx.numProperties;
        r.notes.push("numProperties=" + n);
        for (var i = 1; i <= n; i++) {
            var p = fx.property(i);
            var v = null;
            try {
                v = p.value;
            } catch (e) {
                v = "ERR:" + e.toString();
            }
            r.params.push({ i: i, name: p.name, matchName: p.matchName, value: v });
        }

        var card = addCard(comp, "GlassCard", 320, 230, 560, 340, 32, 14, 30, 2);

        // --- Alpha源 = the card fill layer ---
        fx.property(8).setValue(card.fill.index); // FGB_MASK_LAYER (index in comp)
        r.notes.push("alphaSource=" + card.fill.index + " (" + card.fill.name + ")");

        // --- progressive mode (Figma node 505:1207: start 0 end 40,
        //     blurStartOffset {0.5,0}, blurEndOffset {0.5,1} on a
        //     320,230 560x340 card) ---
        fx.property(1).setValue(2); // 模式 = 渐变
        fx.property(4).setValue(0); // 开始半径
        fx.property(5).setValue(40); // 结束半径
        fx.property(6).setValue([600, 230]); // 渐变起点 (layer px)
        fx.property(7).setValue([600, 570]); // 渐变终点 (layer px)

        // read back what we set
        var readback = [];
        for (var j = 1; j <= n; j++) {
            var p2 = fx.property(j);
            var v2 = null;
            try {
                v2 = p2.value;
            } catch (e) {
                v2 = "ERR";
            }
            readback.push({ i: j, name: p2.name, value: v2 });
        }
        r.readback = readback;

        comp.openInViewer();
        adj.selected = true;
        comp.time = 0;

        comp.saveFrameToPng(0, new File(OUT + "PROBE_V16.png"));
        r.notes.push("rendered PROBE_V16.png");
    } catch (e) {
        r.errors.push(e.toString() + " @ " + (e.line || "?"));
    }

    return JSON.stringify(r, null, 1);
})();
