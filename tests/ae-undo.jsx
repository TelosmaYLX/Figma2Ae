(function () {
  var base = F2A_ROOT + '/', dir = base + 'artifacts/fidelity/';
  var previous = app.project.activeItem, oldIds = {}, folder = null, comp = null;
  var leaveForBoundary = false, ownedIds = null;
  var errors = [], savedOnError = app.onError;
  for (var i = 1; i <= app.project.numItems; i++) oldIds[app.project.item(i).id] = true;
  function snapshot() {
    var out = {projectItems: app.project.numItems,rootLayers: comp.numLayers, shapes: 0, texts: 0, images: 0, precomps: 0, gradients: 0, mattes: 0};
    function properties(group) {
      if (!group) return;
      for (var n = 1; n <= group.numProperties; n++) {
        var p = group.property(n);
        if (p.matchName === 'ADBE Vector Graphic - G-Fill' || p.matchName === 'ADBE Vector Graphic - G-Stroke') out.gradients++;
        if (p.propertyType !== PropertyType.PROPERTY) properties(p);
      }
    }
    function walk(c) {
      for (var n = 1; n <= c.numLayers; n++) {
        var l = c.layer(n);
        if (l.name === 'F2A undo sentinel') continue;
        if (l instanceof TextLayer) out.texts++;
        else if (l instanceof ShapeLayer) { out.shapes++; properties(l.property('ADBE Root Vectors Group')); }
        else if (l.source instanceof CompItem) { out.precomps++; walk(l.source); }
        else if (l.source instanceof FootageItem) out.images++;
        if (l.hasTrackMatte) out.mattes++;
      }
    }
    walk(comp); return out;
  }
  $.global.__f2aUndoNativeError = function (message, severity) { errors.push({message: String(message), severity: String(severity)}); };
  app.onError = '__f2aUndoNativeError';
  app.beginSuppressDialogs();
  try {
    var boundary = $.global.__f2aUndoBoundary;
    if (F2A_CASE === 'boundary-check') {
      if (!boundary) throw new Error('Missing boundary test import');
      comp = boundary.comp; folder = boundary.folder; previous = boundary.previous; ownedIds = boundary.ownedIds;
      var beforeRedoIds = {};
      for (var bi = 1; bi <= app.project.numItems; bi++) beforeRedoIds[app.project.item(bi).id] = true;
      app.executeCommand(16); var afterUndo = snapshot();
      app.executeCommand(2035); var afterRedo = snapshot();
      for (bi = 1; bi <= app.project.numItems; bi++) {
        var redoItem = app.project.item(bi);
        if (!beforeRedoIds[redoItem.id]) ownedIds[redoItem.id] = true;
      }
      var undoOK = JSON.stringify(boundary.before) === JSON.stringify(afterUndo);
      var redoOK = JSON.stringify(boundary.imported) === JSON.stringify(afterRedo);
      return JSON.stringify({passed: undoOK && redoOK && !errors.length,mode: 'separate evalScript callbacks',before: boundary.before,imported: boundary.imported,undone: afterUndo,redone: afterRedo,oneUndoRestored: undoOK,redoRestored: redoOK,errors: errors});
    }
    $.evalFile(base + 'host/figma/svgParser.js');
    $.evalFile(base + 'host/figma/aeShapeBuilder.jsx');
    $.evalFile(base + 'host/figma/figmaRunner.jsx');
    // Native command IDs avoid localized/dynamically suffixed Edit-menu labels.
    var undo = 16, redo = 2035;
    app.beginUndoGroup('F2A undo test setup');
    try {
      folder = app.project.items.addFolder('F2A temporary undo test');
      comp = app.project.items.addComp('F2A undo test', 832, 1068, 1, 1, 30); comp.parentFolder = folder; comp.openInViewer();
      var sentinel = comp.layers.addText('F2A undo sentinel'); sentinel.name = 'F2A undo sentinel';
    } finally { app.endUndoGroup(); }
    var before = snapshot(), result;
    if (F2A_CASE === 'legacy') {
      result = runImport(dir + 'unused.svg', dir + 'texts.json', dir + 'gradients.json', dir + 'effects.json', 0, 0, dir + 'nodes.json', dir + 'containers.json');
      result += ' | ' + runImportImages(dir + 'images.json', dir + 'assets');
      result += ' | ' + runOrganize();
    } else {
      result = runImportBatch(dir + 'undo-job.json');
    }
    if (/^(ERROR|node error|batch error)/i.test(result)) throw new Error(result);
    var imported = snapshot();
    if (imported.texts < 40 || imported.images < 50 || imported.gradients < 5) throw new Error('Import incomplete: ' + JSON.stringify(imported));
    if (F2A_CASE === 'batch-boundary') {
      ownedIds = {};
      for (var oi = 1; oi <= app.project.numItems; oi++) {
        var owned = app.project.item(oi); if (!oldIds[owned.id]) ownedIds[owned.id] = true;
      }
      $.global.__f2aUndoBoundary = {comp: comp,folder: folder,previous: previous,ownedIds: ownedIds,before: before,imported: imported};
      leaveForBoundary = true;
      return JSON.stringify({ready: true,imported: imported,errors: errors});
    }
    app.executeCommand(undo);
    var undone = snapshot();
    app.executeCommand(redo);
    var redone = snapshot();
    var restored = JSON.stringify(before) === JSON.stringify(undone);
    var redoRestored = JSON.stringify(imported) === JSON.stringify(redone);
    return JSON.stringify({passed: restored && redoRestored && !errors.length,mode: F2A_CASE,before: before,imported: imported,undone: undone,redone: redone,oneUndoRestored: restored,redoRestored: redoRestored,errors: errors});
  } catch (e) { return JSON.stringify({passed: false,error: String(e),line: e.line,errors: errors}); }
  finally {
    app.onError = savedOnError == null ? null : savedOnError;
    delete $.global.__f2aUndoNativeError;
    if (!leaveForBoundary) {
      app.beginUndoGroup('F2A undo test cleanup');
      try {
        for (var j = 1; j <= app.project.numItems; j++) {
          var item = app.project.item(j);
          if ((ownedIds ? ownedIds[item.id] : !oldIds[item.id]) && item !== folder && folder) item.parentFolder = folder;
        }
        if (folder) folder.remove();
      } finally { app.endUndoGroup(); }
      delete $.global.__f2aUndoBoundary;
      if (previous && previous.openInViewer) previous.openInViewer();
    }
    app.endSuppressDialogs(false);
  }
})();
