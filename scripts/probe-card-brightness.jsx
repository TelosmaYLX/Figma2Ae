(function () {
  var p = app.project;
  if (!p) return JSON.stringify({error: 'No open project'});
  var report = {file: p.file ? p.file.fsName : null, activeId: p.activeItem ? p.activeItem.id : null, settings: {}, comps: []};
  var keys = ['bitsPerChannel', 'workingSpace', 'linearizeWorkingSpace', 'linearBlending', 'compensateForSceneReferredProfiles', 'gpuAccelType'];
  for (var k = 0; k < keys.length; k++) { try { report.settings[keys[k]] = p[keys[k]]; } catch (e) {} }
  function prop(l, name) { try { return l.property('ADBE Transform Group').property(name).value; } catch (e) { return null; } }
  for (var i = 1; i <= p.numItems; i++) {
    var c = p.item(i);
    if (!(c instanceof CompItem)) continue;
    var out = {id: c.id, name: c.name, width: c.width, height: c.height, layers: []};
    for (var j = 1; j <= c.numLayers; j++) {
      var l = c.layer(j), src = null;
      try { if (l.source) src = {id: l.source.id, name: l.source.name, comp: l.source instanceof CompItem, file: l.source.file ? l.source.file.fsName : null, width: l.source.width, height: l.source.height}; } catch (e) {}
      var row = {id: l.id, index: j, name: l.name, enabled: l.enabled, blend: String(l.blendingMode), opacity: prop(l, 'ADBE Opacity'), position: prop(l, 'ADBE Position'), anchor: prop(l, 'ADBE Anchor Point'), scale: prop(l, 'ADBE Scale'), source: src};
      try { row.collapse = l.collapseTransformation; row.mattes = String(l.trackMatteType); row.effects = l.property('ADBE Effect Parade').numProperties; row.masks = l.property('ADBE Mask Parade').numProperties; } catch (e) {}
      out.layers.push(row);
    }
    report.comps.push(out);
  }
  return JSON.stringify(report);
})();
