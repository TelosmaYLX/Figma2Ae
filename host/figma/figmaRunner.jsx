/*
 * figmaRunner.jsx — ExtendScript entry for the Figma module of f2a.
 * Loaded by the panel AFTER svgParser.js and aeShapeBuilder.jsx (which define the
 * SVGParser and AEShapeBuilder globals). No #include here — the panel evalFiles the
 * three files in order into the one persistent ExtendScript engine.
 *
 * Exposes the global the panel calls:
 *   runSvgToShapes(pathOrSvg)  -> status string   (called by the WebSocket bridge through
 *                                                  runImportBatch; the panel has no manual
 *                                                  import button any more)
 */

function _mkReadFile(file) {
  file.encoding = "UTF-8";
  file.open("r");
  var txt = file.read();
  file.close();
  return txt;
}

// Move the whole parsed model so the FRAME's top-left lands on the comp origin. With clipping
// disabled the exported SVG grows past the frame (e.g. a glow bleeding 412px to the left), and
// every coordinate in it is measured from that larger canvas — without this the shapes came in
// correct but the entire scene sat offset from the text, which is frame-relative.
function _mkShiftModel(model, dx, dy) {
  if (!dx && !dy) return;
  var i, j, k, sh, sub;
  for (i = 0; i < model.shapes.length; i++) {
    sh = model.shapes[i];
    for (j = 0; j < sh.subpaths.length; j++) {
      sub = sh.subpaths[j];
      for (k = 0; k < sub.verts.length; k++) { sub.verts[k][0] -= dx; sub.verts[k][1] -= dy; }
    }
    if (sh.prim) { sh.prim.cx -= dx; sh.prim.cy -= dy; }
    if (sh.gradient) { sh.gradient.start[0] -= dx; sh.gradient.start[1] -= dy; sh.gradient.end[0] -= dx; sh.gradient.end[1] -= dy; }
    if (sh.strokeGradient) { sh.strokeGradient.start[0] -= dx; sh.strokeGradient.start[1] -= dy; sh.strokeGradient.end[0] -= dx; sh.strokeGradient.end[1] -= dy; }
  }
}

var _mkNodeOrigin = { x: 0, y: 0 };     // frame origin for node mode, set by the panel

function runSvgToShapes(pathOrSvg, gradientPresets, effects, shiftX, shiftY, imageMasks, imageFolder) {
  try {
    if (typeof SVGParser === "undefined" || typeof AEShapeBuilder === "undefined")
      return "ERROR: Figma 引擎未加载。";
    var comp = app.project ? app.project.activeItem : null;
    if (!comp || !(comp instanceof CompItem)) return "ERROR: 请先打开一个合成。";

    var svgString, name = "Figma UI";
    if (pathOrSvg.indexOf("<svg") !== -1) {
      svgString = pathOrSvg;
    } else {
      var f = new File(pathOrSvg);
      if (!f.exists) return "ERROR: 文件不存在：" + pathOrSvg;
      svgString = _mkReadFile(f);
      name = f.name.replace(/\.svg$/i, "");
    }

    var model = SVGParser.parse(svgString);
    _mkShiftModel(model, Number(shiftX) || 0, Number(shiftY) || 0);
    if (!model.shapes.length) return "ERROR: 没有支持的形状（路径、矩形、圆形、椭圆、直线或多边形）。";

    var layers = AEShapeBuilder.build(model, { comp: comp, oneLayer: false, name: name, gradientPresets: gradientPresets || null,
                                             effects: effects || null, imageMasks: imageMasks, imageFolder: imageFolder });
    return "OK: 已从 " + model.shapes.length + " 个形状创建 " + layers.length + " 个形状图层。";
  } catch (e) {
    return "ERROR: " + e.toString();
  }
}

// Full import from the plugin: SVG shapes + editable text layers.
// textsPath -> a temp .json array of { characters, x, y, w, h, fontSize, family, color, opacity, align }.
function _mkReadJson(pathStr) {
  if (!pathStr) return null;
  var f = new File(pathStr);
  if (!f.exists) return null;
  f.encoding = "UTF-8"; f.open("r"); var txt = f.read(); f.close();
  return eval('(' + txt + ')');            // our own JSON (ExtendScript has no JSON)
}

var _mkContainers = null;    // organize mode: collapsed only after text AND images are in

// Collapse every Figma container into its own precomp. Runs LAST, from the panel, because
// pictures arrive in a separate message — precomposing before them would leave the footage
// outside the group it belongs to.
function runOrganize() {
  try {
    var comp = app.project ? app.project.activeItem : null;
    if (!comp || !(comp instanceof CompItem)) return "ERROR: 请先打开一个合成。";
    return AEShapeBuilder.withUndo("Figma -> Organize", function () {
    // No containers (or the user disabled precomps): still reconcile the late text/image passes.
    // The optimized restack is a no-op when the comp is already ordered.
    if (!_mkContainers || !_mkContainers.length) {
      AEShapeBuilder.restack(comp);
      var fd = ""; try { fd = AEShapeBuilder.getDiag(); } catch (ef) {}
      return "no groups" + (fd ? " | " + fd : "");
    }
    var n = 0;
    n = AEShapeBuilder.organize(comp, _mkContainers);
    _mkContainers = null;
    var d = ""; try { d = AEShapeBuilder.getDiag(); } catch (ed) {}
    return n + " 个预合成" + (d ? " | " + d : "");
    });
  } catch (e) { _mkContainers = null; return "organize error: " + e.toString(); }
}

// The panel waits for the complete payload, then calls this ONCE. An undo group must never
// span asynchronous CEP callbacks: AE closes script groups at the end of each evaluation.
function mkFigmaTargetCompId() {
  var comp = app.project ? app.project.activeItem : null;
  return comp && comp instanceof CompItem ? String(comp.id) : "0";
}

// ---- Project organization -------------------------------------------------
// The live import mirrors the AEP writer (scripts/aep/writer.py): one folder per import,
// with Assets/ for the footage and Precomps/ for the compositions it created. Re-importing the
// same frame REUSES that folder instead of stacking "Assets 2", "Precomps 3" every run.
function _mkProjectIds() {
  var seen = {}, total = app.project ? app.project.numItems : 0;
  for (var i = 1; i <= total; i++) seen[app.project.item(i).id] = true;
  return seen;
}
function _mkChildFolder(parent, name) {
  for (var i = 1; i <= parent.numItems; i++) {
    var item = parent.item(i);
    if (item instanceof FolderItem && item.name === name) return item;
  }
  return parent.items.addFolder(name);
}
function _mkOrganizeImport(before, name) {
  // Collect first: an import that only added layers needs no folders, and empty Assets/
  // Precomps pairs would just be clutter in the project panel.
  var fresh = [], total = app.project.numItems, i, item;
  for (i = 1; i <= total; i++) {
    item = app.project.item(i);
    if (before[item.id]) continue;
    if (item instanceof CompItem || item instanceof FootageItem) fresh.push(item);
  }
  if (!fresh.length) return { name: "", moved: 0 };
  var root = app.project.rootFolder;
  var label = String(name == null ? "" : name).replace(/[\\\/:*?"<>|\r\n\t]+/g, "_").replace(/^\s+|\s+$/g, "");
  if (!label) label = "F2A 导入";
  if (label.length > 60) label = label.substr(0, 60);
  var top = _mkChildFolder(root, label);
  var assets = _mkChildFolder(top, "Assets");
  var precomps = _mkChildFolder(top, "Precomps");
  var moved = 0;
  for (i = 0; i < fresh.length; i++) {
    item = fresh[i];
    try {
      item.parentFolder = (item instanceof CompItem) ? precomps : assets;
      moved++;
    } catch (eMove) {}                       // read-only items keep their place; never abort the import
  }
  return { name: top.name, moved: moved };
}

function runImportBatch(jobPath) {
  try {
    var job = _mkReadJson(jobPath);
    if (!job) return "ERROR: 导入数据不存在。";
    var comp = app.project ? app.project.activeItem : null;
    if (job.compId != null) {
      comp = null;
      for (var ci = 1; ci <= app.project.numItems; ci++) {
        var candidate = app.project.item(ci);
        if (candidate.id === job.compId && candidate instanceof CompItem) { comp = candidate; break; }
      }
      if (!comp) return "ERROR: 导入目标合成不存在。";
      if (app.project.activeItem !== comp) comp.openInViewer();
    }
    if (!comp || !(comp instanceof CompItem)) return "ERROR: 请先打开一个合成。";
    return AEShapeBuilder.withUndo("Figma -> AE", function () {
      var before = _mkProjectIds();
      try {
        var status = runImport(job.svgPath, job.textsPath, job.gradMapPath, job.effectsPath,
                               job.shiftX || 0, job.shiftY || 0, job.nodesPath, job.containersPath,
                               job.imagesPath ? _mkReadJson(job.imagesPath) : null, job.imageFolder);
        if (/^(ERROR|node error)/i.test(status)) return status;
        if (job.imagesPath && job.imageFolder) {
          var images = runImportImages(job.imagesPath, job.imageFolder);
          if (/^(ERROR|image error)/i.test(images)) return status + " | " + images;
        }
        var result = status + (images ? " | " + images.split(" | ")[0] : "") + " | " + runOrganize();
        // Organize AFTER the precomps exist, so newly created compositions land in Precomps too.
        try {
          var placed = _mkOrganizeImport(before, job.name);
          if (placed && placed.moved > 0) result = result + " | " + placed.moved + " 项已整理到「" + placed.name + "」";
        } catch (eOrg) { result = result + " | 整理失败：" + eOrg; }
        return result;
      } finally { _mkContainers = null; }
    });
  } catch (e) { return "batch error: " + e.toString(); }
}

function runImport(svgPath, textsPath, gradMapPath, effectsPath, shiftX, shiftY, nodesPath, containersPath, imageMasks, imageFolder) {
  var gradPresets = null, effects = null;
  try { gradPresets = _mkReadJson(gradMapPath); } catch (eg) {}
  try { effects = _mkReadJson(effectsPath); } catch (ee) {}
  _mkContainers = null;
  try { if (containersPath && containersPath.length) _mkContainers = _mkReadJson(containersPath); } catch (ec) {}

  var status;
  var nodes = null;
  try { nodes = _mkReadJson(nodesPath); } catch (en) {}
  if (nodes) {
    // NODE MODE: geometry comes from the Figma tree, so one Figma layer is one AE layer.
    // An EMPTY array still means node mode: complex groups may have been routed to Figma PNGs,
    // so falling back to the SVG here would import their shapes a second time.
    try {
      var compN = app.project ? app.project.activeItem : null;
      if (!compN || !(compN instanceof CompItem)) status = "ERROR: open a composition first.";
      else {
        var modelN = SVGParser.fromNodes(nodes, compN.width, compN.height, { x: 0, y: 0 });   // already frame-relative
        // Leaf shadows ride on the node itself; only the GROUP-level ones are left to the
        // bounding-box matcher, otherwise a leaf would get its shadow applied twice.
        var effN = null;
        if (effects && effects.length) {
          effN = [];
          for (var q = 0; q < effects.length; q++) if (!effects[q].leaf) effN.push(effects[q]);
          if (!effN.length) effN = null;
        }
        var lyrsN = AEShapeBuilder.build(modelN, { comp: compN, oneLayer: false, name: "Figma UI",
                                                   gradientPresets: gradPresets || null, effects: effN, imageMasks: imageMasks, imageFolder: imageFolder });
        status = "可编辑模式：已从 " + nodes.length + " 个 Figma 图层创建 " + lyrsN.length + " 个图层。";
      }
    } catch (eN) { status = "node error: " + eN.toString(); }
  } else {
    status = runSvgToShapes(svgPath, gradPresets, effects, shiftX, shiftY, imageMasks, imageFolder);
  }

  try {
    if (textsPath && textsPath.length) {
      var texts = _mkReadJson(textsPath);
      if (texts && texts.length) {
        var comp = app.project ? app.project.activeItem : null;
        var n = AEShapeBuilder.buildText(comp, texts);
        status = status + "，以及 " + n + " 个文本图层";
      }
    }
  } catch (e) {
    status = status + " | text error: " + e.toString();
  }
  try { var d = AEShapeBuilder.getDiag(); if (d) status = status + " | GRAD " + d; } catch (ed) {}
  return status;
}

// Ask the user where the pictures should live. AE's own folder picker, so the panel gets a
// real path it can write into (footage must live on disk — AE links to it, never embeds).
function mkChooseImageFolder(hint) {
  try {
    var f = Folder.selectDialog(hint || "请选择导入图片的保存文件夹");
    return f ? f.fsName.replace(/\\/g, "/") : "";
  } catch (e) { return "ERROR: 无法打开目录窗口：" + String(e); }
}

// Import the saved pictures as footage (+ track mattes for cropped ones).
function runImportImages(imagesJsonPath, folder) {
  try {
    if (!folder || !imagesJsonPath) return "no images";
    var comp = app.project ? app.project.activeItem : null;
    if (!comp || !(comp instanceof CompItem)) return "ERROR: 请先打开一个合成。";
    var images = _mkReadJson(imagesJsonPath);
    if (!images || !images.length) return "no images";
    var n = AEShapeBuilder.buildImages(comp, images, folder);
    var d = ""; try { d = AEShapeBuilder.getDiag(); } catch (ed) {}
    return "已导入 " + n + "/" + images.length + " 张图片" + (d ? " | " + d : "");
  } catch (e) { return "image error: " + e.toString(); }
}
