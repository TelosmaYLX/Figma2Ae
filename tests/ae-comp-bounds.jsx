(function () {
  var previous = app.project.activeItem, folder = null, imported = null, old = {}, results = [];
  for (var i = 1; i <= app.project.numItems; i++) old[app.project.item(i).id] = true;
  function read(path) {var f = new File(path); f.encoding = 'UTF-8'; f.open('r'); var data = eval('(' + f.read() + ')'); f.close(); return data;}
  function close(a, b, message) {if (Math.abs(a - b) > .0001) throw Error(message + ': ' + a + ' != ' + b);}
  function inspect(comp, model, kind) {
    var count = 0;
    function walk(parent, offset) {
      for (var n = 1; n <= parent.numLayers; n++) {
        var layer = parent.layer(n), position = layer.transform.position.value, anchor = layer.transform.anchorPoint.value;
        if (layer.source instanceof CompItem) {
          var definition = null;
          for (var c = 0; c < model.containers.length; c++) if (model.containers[c].name === layer.name) definition = model.containers[c];
          if (!definition) throw Error('Unexpected precomp ' + layer.name);
          var actual = {kind: kind, name: layer.name, width: layer.source.width, height: layer.source.height};
          results.push(actual);
          close(layer.source.width, Math.max(4, Math.ceil(definition.w)), layer.name + ' width');
          close(layer.source.height, Math.max(4, Math.ceil(definition.h)), layer.name + ' height');
          close(anchor[0], layer.source.width / 2, layer.name + ' anchor X');
          close(anchor[1], layer.source.height / 2, layer.name + ' anchor Y');
          var origin = {x: offset.x + position[0] - anchor[0], y: offset.y + position[1] - anchor[1]};
          close(origin.x, definition.x, layer.name + ' original X'); close(origin.y, definition.y, layer.name + ' original Y');
          if (layer.collapseTransformation) throw Error(layer.name + ' has collapse transformations enabled');
          walk(layer.source, origin); count++;
        } else if (layer instanceof ShapeLayer) {
          var rect = layer.sourceRectAtTime(0, false), definition = null;
          for (var s = 0; s < model.shapes.length; s++) if (model.shapes[s].name === layer.name) definition = model.shapes[s];
          if (!definition || !definition.prim) throw Error('Missing primitive ' + layer.name);
          close(offset.x + position[0] - anchor[0] + rect.left, definition.prim.cx - definition.prim.w / 2, layer.name + ' artwork X');
          close(offset.y + position[1] - anchor[1] + rect.top, definition.prim.cy - definition.prim.h / 2, layer.name + ' artwork Y');
        }
      }
    }
    walk(comp, {x: 0, y: 0});
    close(count, model.containers.length, kind + ' container count');
  }
  app.beginUndoGroup('F2A temporary composition bounds check');
  try {
    var fixture = read(F2A_ROOT + '/artifacts/comp-bounds-native.json'), model = fixture.model;
    $.evalFile(F2A_ROOT + '/host/figma/aeShapeBuilder.jsx');
    folder = app.project.items.addFolder('F2A temporary composition bounds');
    var nativeComp = app.project.items.addComp('F2A native bounds', model.width, model.height, 1, model.duration, model.frameRate);
    nativeComp.parentFolder = folder;
    AEShapeBuilder.build({shapes: model.shapes}, {comp: nativeComp});
    AEShapeBuilder.organize(nativeComp, model.containers);
    inspect(nativeComp, model, 'native');
    nativeComp.saveFrameToPng(0, new File(fixture.directory + '/native.png'));
    var baseline = app.project.items.addComp('F2A flat bounds reference', model.width, model.height, 1, model.duration, model.frameRate);
    baseline.parentFolder = folder;
    var flat = read(F2A_ROOT + '/artifacts/comp-bounds-native.json').model;
    // Without collapse, every precomp clips at its own edges. Intersect the rectangular
    // artwork with all ancestor boxes to build an independent flat reference.
    for (i = 0; i < flat.shapes.length; i++) {
      var shape = flat.shapes[i],p=shape.prim,left=p.cx-p.w/2,top=p.cy-p.h/2,right=left+p.w,bottom=top+p.h,path=shape.path||[];
      for(var a=0;a<path.length;a++)for(var c=0;c<flat.containers.length;c++)if(flat.containers[c].id===path[a]){
        var box=flat.containers[c];left=Math.max(left,box.x);top=Math.max(top,box.y);right=Math.min(right,box.x+box.w);bottom=Math.min(bottom,box.y+box.h);
      }
      shape.prim={k:'rect',cx:(left+right)/2,cy:(top+bottom)/2,w:right-left,h:bottom-top,r:0};
    }
    var faded = null, fadedShapes = [], flatShapes = [];
    for (i = 0; i < flat.containers.length; i++) if (flat.containers[i].name === 'Faded frame') faded = flat.containers[i];
    for (i = 0; i < flat.shapes.length; i++) {
      var belongs = false, path = flat.shapes[i].path || [];
      for (var p = 0; p < path.length; p++) if (path[p] === faded.id) belongs = true;
      (belongs ? fadedShapes : flatShapes).push(flat.shapes[i]);
    }
    AEShapeBuilder.build({shapes: flatShapes}, {comp: baseline}); AEShapeBuilder.restack(baseline);
    var fadeSource = app.project.items.addComp('F2A isolated opacity reference', model.width, model.height, 1, model.duration, model.frameRate);
    fadeSource.parentFolder = folder;
    AEShapeBuilder.build({shapes: fadedShapes}, {comp: fadeSource}); AEShapeBuilder.restack(fadeSource);
    var fadeLayer = baseline.layers.add(fadeSource); fadeLayer.transform.opacity.setValue(50);
    baseline.saveFrameToPng(0, new File(fixture.directory + '/reference.png'));
    imported = app.project.importFile(new ImportOptions(new File(fixture.project)));
    var aep = null;
    function locate(parent) {for (var n = 1; n <= parent.numItems; n++) {var item = parent.item(n); if (item instanceof FolderItem) locate(item); else if (item instanceof CompItem && item.name === model.name && item.parentFolder.name === model.name) aep = item;}}
    locate(imported); if (!aep) throw Error('Missing exported composition');
    inspect(aep, model, 'aep');
    aep.saveFrameToPng(0, new File(fixture.directory + '/aep.png'));
    if(F2A_CASE==='export'){aep.name='F2A AEP bounds';app.project.save(new File(fixture.directory+'/native.aep'));}
    return JSON.stringify({passed: true, compositions: results, directory: fixture.directory});
  } catch (error) {return JSON.stringify({passed: false, error: String(error), line: error.line, compositions: results});}
  finally {
    if (imported) imported.remove();
    if (folder) {
      var created = [];
      for (i = 1; i <= app.project.numItems; i++) {var item = app.project.item(i); if (!old[item.id] && item !== folder) created.push(item);}
      for (i = 0; i < created.length; i++) created[i].parentFolder = folder;
      folder.remove();
    }
    app.endUndoGroup(); try {if (previous && previous.openInViewer) previous.openInViewer();} catch (restore) {}
  }
})();
