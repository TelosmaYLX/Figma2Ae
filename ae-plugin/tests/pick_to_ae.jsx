// Reproduce the user's selected Figma layer in After Effects:
//   Figma node 505:1201 "Circle_Purple" - 520x520 ELLIPSE, IMAGE fill (2560x1440
//   source, scaleMode FILL), seven image filters applied.
//
// Comp: source image scaled to FILL, positioned as Figma does, ellipse alpha
// matte, "Figma 调色" with the same seven values. Renders the graded and the
// unfiltered (effect disabled) versions so the comparison can separate grade
// accuracy from image resampling / matte antialiasing.
(function () {
    var BASE = "D:/Tools/F2A/.agents/worktrees/dsh-f012f7f8-067c/rea-work/figma-user-pick/";
    var OUT = BASE + "ae/";
    var r = { steps: [], errors: [], timing: null };

    function ensureDir(p) {
        var f = new Folder(p);
        if (!f.exists) f.create();
        return f;
    }
    ensureDir(OUT);

    var NODE_W = 520;
    var NODE_H = 520;
    var VALVES = [-23, 5, -21, 21, -26, 19, -28]; // exposure, contrast, saturation, temperature, tint, highlights, shadows

    try {
        app.project.bitsPerChannel = 8;
        var source = app.project.importFile(
            new ImportOptions(new File(BASE + "source/481ada345282c1b47e5d36dd188f55a09c72b2df.png")));
        var comp = app.project.items.addComp("PICK_520", NODE_W, NODE_H, 1, 1, 30);

        // image fill: scaleMode FILL => cover the node and centre it
        var photo = comp.layers.add(source);
        var fillScale = Math.max(NODE_W / source.width, NODE_H / source.height) * 100.0;
        photo.property("Transform").property("Scale").setValue([fillScale, fillScale]);
        photo.property("Transform").property("Anchor Point").setValue([source.width / 2, source.height / 2]);
        photo.property("Transform").property("Position").setValue([NODE_W / 2, NODE_H / 2]);

        var fx = photo.property("Effects").addProperty("F2A Figma Image Grade");
        for (var i = 0; i < 7; i++) fx.property(i + 1).setValue(VALVES[i]);

        // ellipse clip, exactly the node's shape
        var matte = comp.layers.addShape();
        matte.name = "Ellipse matte";
        // addShape() places the layer at the comp centre; move it to the origin so
        // layer space == comp space and the ellipse below lands where intended.
        matte.property("Transform").property("Anchor Point").setValue([0, 0]);
        matte.property("Transform").property("Position").setValue([0, 0]);
        var group = matte.property("Contents").addProperty("ADBE Vector Group");
        var ellipse = group.property("Contents").addProperty("ADBE Vector Shape - Ellipse");
        ellipse.property("Size").setValue([NODE_W, NODE_H]);
        ellipse.property("Position").setValue([NODE_W / 2, NODE_H / 2]);
        var fill = group.property("Contents").addProperty("ADBE Vector Graphic - Fill");
        fill.property("Color").setValue([1, 1, 1]);
        photo.trackMatteType = TrackMatteType.ALPHA;

        comp.saveFrameToPng(0, new File(OUT + "ae_graded.png"));
        fx.enabled = false;
        comp.saveFrameToPng(0, new File(OUT + "ae_unfiltered.png"));
        fx.enabled = true;

        r.steps.push("rendered graded + unfiltered");
        r.fillScale = fillScale;
        r.source = source.width + "x" + source.height;
        r.params = [];
        for (var k = 1; k <= fx.numProperties; k++) r.params.push(fx.property(k).name + "=" + fx.property(k).value);
        app.project.items.addFolder("pick"); // keep AE happy; project not saved
    } catch (e) {
        r.errors.push(e.toString() + " @ line " + (e.line || "?"));
    }
    return JSON.stringify(r, null, 1);
})();
