(function () {
  var base = F2A_ROOT + '/', dir = base + 'artifacts/export-smoke/';
  var previous = app.project.activeItem, oldIds = {}, folder = null;
  var savedContainers = typeof _mkContainers === 'undefined' ? null : _mkContainers;
  for (var i = 1; i <= app.project.numItems; i++) oldIds[app.project.item(i).id] = true;
  function read(name) { var f = new File(dir + name); f.encoding = 'UTF-8'; f.open('r'); var s = f.read(); f.close(); return eval('(' + s + ')'); }
  function requireCheck(ok, message) { if (!ok) throw new Error(message); }
  function count(comp) {
    var result = {shapes: 0, texts: 0, images: 0, references: 0, masks: 0};
    for (var j = 1; j <= comp.numLayers; j++) {
      var layer = comp.layer(j);
      var masks = layer.property('ADBE Mask Parade');
      if (masks) result.masks += masks.numProperties;
      if (layer instanceof TextLayer) result.texts++;
      else if (layer instanceof ShapeLayer) result.shapes++;
      else if (layer.source instanceof CompItem) {
        var child = count(layer.source);
        result.shapes += child.shapes; result.texts += child.texts; result.images += child.images; result.masks += child.masks; result.references += child.references;
      } else if (layer.source instanceof FootageItem) { if (/_原图对照$/.test(layer.name)) result.references++; else result.images++; }
    }
    return result;
  }
  app.beginUndoGroup('F2A export smoke test');
  try {
    $.evalFile(base + 'host/figma/svgParser.js');
    $.evalFile(base + 'host/figma/aeShapeBuilder.jsx');
    $.evalFile(base + 'host/figma/figmaRunner.jsx');
    folder = app.project.items.addFolder('F2A temporary export test');
    var cases = read('cases.json'), results = [];
    for (var c = 0; c < cases.length; c++) {
      var test = cases[c], prefix = dir + test.name + '/';
      var comp = app.project.items.addComp('F2A ' + test.name, 100, 60, 1, 1, 30);
      comp.parentFolder = folder; comp.openInViewer();
      var status = runImport(prefix + 'source.svg', prefix + 'texts.json', '', prefix + 'effects.json', 0, 0, prefix + 'nodes.json', prefix + 'containers.json');
      requireCheck(!/error/i.test(status), status);
      var images = runImportImages(prefix + 'images.json', prefix);
      requireCheck(!/error/i.test(images), images);
      var organize = runOrganize(), counts = count(comp);
      requireCheck(counts.references === 1 && /_原图对照$/.test(comp.layer(1).name) && !comp.layer(1).enabled, 'Reference must stay at the top of the root comp, hidden');
      for (var key in test.expected) requireCheck(counts[key] === test.expected[key], test.name + ' ' + key + ': ' + counts[key]);
      results.push({name: test.name, counts: counts, status: status, images: images, organize: organize});
    }
    return JSON.stringify({passed: true, cases: results, scope: 'Actual exporter packets with mocked Figma PNG rendering, imported through native AE entry points'});
  } catch (e) { return JSON.stringify({passed: false, error: e.toString(), line: e.line}); }
  finally {
    for (var k = 1; k <= app.project.numItems; k++) {
      var item = app.project.item(k);
      if (!oldIds[item.id] && item !== folder && folder) item.parentFolder = folder;
    }
    if (folder) folder.remove();
    _mkContainers = savedContainers;
    app.endUndoGroup();
    try { if (previous && previous.openInViewer) previous.openInViewer(); } catch (restore) {}
  }
})();
