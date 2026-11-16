(function () {
  // Real-AE check for the panel import's project organization: one folder per import with
  // Assets/ for footage and Precomps/ for compositions, mirroring scripts/aep/writer.py.
  var base = F2A_ROOT + '/', fixture = base + 'artifacts/import-folders/';
  var oldIds = {}, previous = app.project.activeItem, errors = [], savedOnError = app.onError;
  function ids() { var out = {}; for (var i = 1; i <= app.project.numItems; i++) out[app.project.item(i).id] = true; return out; }
  function folderNamed(parent, name) {
    if (!parent) return null;
    for (var i = 1; i <= parent.numItems; i++) {
      var item = parent.item(i);
      if (item instanceof FolderItem && item.name === name) return item;
    }
    return null;
  }
  function footageIn(folder) {
    var found = [];
    if (!folder) return found;
    for (var i = 1; i <= folder.numItems; i++) if (folder.item(i) instanceof FootageItem) found.push(folder.item(i));
    return found;
  }
  function writeText(path, text) {
    var f = new File(path);
    f.encoding = 'UTF-8'; f.open('w'); f.write(text); f.close();
    return f.exists;
  }
  app.beginSuppressDialogs();
  try {
    $.evalFile(base + 'host/figma/svgParser.js');
    $.evalFile(base + 'host/figma/aeShapeBuilder.jsx');
    $.evalFile(base + 'host/figma/figmaRunner.jsx');
    oldIds = ids();

    var dir = new Folder(fixture);
    if (!dir.exists) dir.create();
    var png = new File(dir.fsName + '/pixel.png');
    if (!png.exists && !new File(base + 'artifacts/export-options/cep-log-300x320.png').copy(png))
      throw new Error('无法准备测试图片');
    var folderPath = dir.fsName.replace(/\\/g, '/');
    writeText(dir.fsName + '/nodes.json', '[]');
    writeText(dir.fsName + '/images.json',
      '[{"file":"pixel.png","name":"pixel","x":0,"y":0,"w":60,"h":60,"cw":60,"ch":60,"cx":30,"cy":30,' +
      '"scaleMode":"FILL","opacity":1,"rotation":0}]');

    app.beginUndoGroup('F2A import folders test');
    var comp = app.project.items.addComp('F2A 整理测试 目标', 240, 240, 1, 1, 24);
    app.endUndoGroup();

    var jobPath = dir.fsName + '/job.json';
    writeText(jobPath, '{"name":"F2A 整理测试","svgPath":"","textsPath":"","gradMapPath":"","effectsPath":"",' +
      '"shiftX":0,"shiftY":0,"nodesPath":"' + folderPath + '/nodes.json","containersPath":"",' +
      '"imagesPath":"' + folderPath + '/images.json","imageFolder":"' + folderPath + '","compId":' + comp.id + '}');

    var status = runImportBatch(jobPath);
    var checks = {};
    checks.imported = !/^(ERROR|node error|batch error)/i.test(String(status));
    checks.status = String(status);

    var top = folderNamed(app.project.rootFolder, 'F2A 整理测试');
    var assets = folderNamed(top, 'Assets');
    var precomps = folderNamed(top, 'Precomps');
    checks.rootFolder = !!top;
    checks.children = !!(assets && precomps);
    checks.footageInAssets = footageIn(assets).length === 1;
    checks.targetStaysPut = !!comp.parentFolder && comp.parentFolder.name !== 'Assets' && comp.parentFolder.name !== 'Precomps';

    // A composition created after the import joins Precomps; the same folders are reused.
    var before = ids();
    var extra = app.project.items.addComp('F2A 整理测试 子合成', 40, 40, 1, 1, 24);
    var placed = _mkOrganizeImport(before, 'F2A 整理测试');
    checks.compInPrecomps = !!extra.parentFolder && extra.parentFolder.name === 'Precomps' &&
      !!extra.parentFolder.parentFolder && extra.parentFolder.parentFolder.name === 'F2A 整理测试';
    checks.reused = placed.name === 'F2A 整理测试' && placed.moved === 1 &&
      folderNamed(app.project.rootFolder, 'F2A 整理测试 2') === null;

    var failed = [];
    for (var key in checks) if (typeof checks[key] === 'boolean' && !checks[key]) failed.push(key);
    return JSON.stringify({ passed: checks.imported && !failed.length, checks: checks, failures: failed, errors: errors });
  } catch (e) {
    return JSON.stringify({ passed: false, error: String(e), line: e.line, errors: errors });
  } finally {
    app.onError = savedOnError;
    app.beginUndoGroup('F2A import folders cleanup');
    try {
      var owned = [];
      for (var ci = 1; ci <= app.project.numItems; ci++) {
        var item = app.project.item(ci);
        if (!oldIds[item.id]) owned.push(item);
      }
      var trash = app.project.items.addFolder('F2A 清理 导入整理测试');
      for (var oi = 0; oi < owned.length; oi++) {
        try { if (owned[oi] !== trash) owned[oi].parentFolder = trash; } catch (eMove) {}
      }
      trash.remove();
    } finally { app.endUndoGroup(); }
    if (previous && previous.openInViewer) previous.openInViewer();
    app.endSuppressDialogs(false);
  }
})();
