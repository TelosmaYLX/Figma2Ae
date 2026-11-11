// Import generated projects for verification; leave the user's project and items intact.
(function () {
  var root = new File($.fileName).parent.parent.fsName.replace(/\\/g, '/');
  var dir = root + '/artifacts/direct-aep/', imported = [], previous = app.project.activeItem;
  var report = {passed: true, cases: []};
  function read(file) { var f = new File(file); f.encoding = 'UTF-8'; f.open('r'); var text = f.read(); f.close(); return eval('(' + text + ')'); }
  function json(value) {
    if (value === null) return 'null';
    if (typeof value === 'string') return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"';
    if (typeof value !== 'object') return String(value);
    var out = [], key;
    if (value instanceof Array) { for (key = 0; key < value.length; key++) out.push(json(value[key])); return '[' + out.join(',') + ']'; }
    for (key in value) if (value.hasOwnProperty(key)) out.push(json(key) + ':' + json(value[key]));
    return '{' + out.join(',') + '}';
  }
  function gradients(group) {
    var count = 0;
    for (var p = 1; p <= group.numProperties; p++) {
      var child = group.property(p);
      if (child.matchName === 'ADBE Vector Graphic - G-Fill' || child.matchName === 'ADBE Vector Graphic - G-Stroke') count++;
      if (child.propertyType !== PropertyType.PROPERTY) count += gradients(child);
    }
    return count;
  }
  try {
    var cases = read(dir + 'ae-cases.json');
    for (var c = 0; c < cases.length; c++) {
      var test = cases[c], started = new Date().getTime(), folder = app.project.importFile(new ImportOptions(new File(test.project)));
      imported.push(folder);
      var result = {name: test.name, comps: 0, shapes: 0, texts: 0, images: 0, mattes: 0, gradients: 0,
                    missing: [], assetPaths: [], errors: [], shapeGeometry: []}, main = null;
      function walk(parent) {
        for (var i = 1; i <= parent.numItems; i++) {
          var item = parent.item(i);
          if (item instanceof FolderItem) walk(item);
          else if (item instanceof FootageItem && item.mainSource instanceof FileSource) {
            if (item.footageMissing) result.missing.push(item.name);
            result.assetPaths.push(item.file.fsName.replace(/\\/g, '/'));
          } else if (item instanceof CompItem) {
            result.comps++;
            if (item.name === test.main) main = item;
            for (var l = 1; l <= item.numLayers; l++) {
              var layer = item.layer(l);
              if (layer instanceof ShapeLayer) {
                result.shapes++; result.gradients += gradients(layer.property('ADBE Root Vectors Group'));
                if (test.name === 'portable') {
                  var vg = layer.property('ADBE Root Vectors Group').property(1).property('ADBE Vectors Group');
                  var rc = vg.property('ADBE Vector Shape - Rect');
                  var bounds = layer.sourceRectAtTime(0, false);
                  var gradient = vg.property('ADBE Vector Graphic - G-Fill');
                  result.shapeGeometry.push({name:layer.name,position:layer.transform.position.value,rectPosition:rc ? rc.property('ADBE Vector Rect Position').value : null,
                    gradStart:gradient ? gradient.property('ADBE Vector Grad Start Pt').value : null, gradEnd:gradient ? gradient.property('ADBE Vector Grad End Pt').value : null,
                    rectSize:rc ? rc.property('ADBE Vector Rect Size').value : null,bounds:{x:bounds.left,y:bounds.top,w:bounds.width,h:bounds.height}});
                  var position = layer.transform.position.value;
                  if (layer.name === 'Editable rectangle' && (Math.abs(position[0]-90)>0.01 || Math.abs(position[1]-110)>0.01)) result.errors.push('Rectangle position differs');
                  if (layer.name === 'Nested rectangle' && (Math.abs(position[0]-30)>0.01 || Math.abs(position[1]-20)>0.01)) result.errors.push('Nested origin differs');
                  if (gradient) {
                    var start = gradient.property('ADBE Vector Grad Start Pt').value;
                    var end = gradient.property('ADBE Vector Grad End Pt').value;
                    if (Math.abs(start[0]+50)>0.01 || Math.abs(start[1])>0.01 || Math.abs(end[0]-50)>0.01 || Math.abs(end[1])>0.01) result.errors.push('Gradient axis differs');
                  }
                }
              }
              if (layer instanceof TextLayer) { result.texts++; if (!layer.property('ADBE Text Properties').property('ADBE Text Document').value.text.length) result.errors.push('Empty text'); }
              if (layer instanceof AVLayer && layer.source instanceof FootageItem && layer.source.mainSource instanceof FileSource) result.images++;
              if (layer instanceof AVLayer && layer.hasTrackMatte) result.mattes++;
            }
          }
        }
      }
      walk(folder);
      if (!main) throw new Error('Missing main comp: ' + test.main);
      result.width = main.width; result.height = main.height;
      if (main.width !== test.width || main.height !== test.height) result.errors.push('Dimensions differ');
      if (result.texts !== test.texts || result.images !== test.images) result.errors.push('Layer counts differ');
      if (test.portable) for (var a = 0; a < result.assetPaths.length; a++)
        if (result.assetPaths[a].indexOf(test.portable) !== 0) result.errors.push('Asset did not relocate: ' + result.assetPaths[a]);
      result.importMs = new Date().getTime() - started;
      main.saveFrameToPng(0, new File(dir + test.name + '.png'));
      result.renderMs = new Date().getTime() - started - result.importMs;
      result.passed = !result.missing.length && !result.errors.length;
      if (!result.passed) report.passed = false;
      report.cases.push(result);
      folder.remove(); imported.pop();
    }
  } catch (error) { report.passed = false; report.error = String(error); report.line = error.line; }
  finally {
    for (var j = imported.length - 1; j >= 0; j--) try { imported[j].remove(); } catch (cleanup) {}
    if (previous && previous instanceof CompItem) try { previous.openInViewer(); } catch (restore) {}
  }
  var file = new File(dir + 'ae-report.json'); file.encoding = 'UTF-8'; file.open('w'); file.write(json(report)); file.close();
})();
