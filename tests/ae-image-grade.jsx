(function () {
  if (typeof F2A_CASE !== 'string' || F2A_CASE !== 'image-grade') return 'Figma 调色 host check not requested';
  var root = typeof F2A_ROOT === 'string' ? F2A_ROOT :
    new File($.fileName).parent.parent.fsName.replace(/\\/g, '/');
  var dir = root + '/artifacts/image-grade-live';
  var report = {passed: false, cases: []}, before = {};
  function assert(value, message) { if (!value) throw new Error(message); }
  function effects(layer) {
    var out = [], parade = layer.property('ADBE Effect Parade');
    for (var i = 1; i <= parade.numProperties; i++) out.push(parade.property(i));
    return out;
  }
  try {
    for (var i = 1; i <= app.project.numItems; i++) before[app.project.item(i).id] = true;
    $.evalFile(new File(root + '/host/figma/svgParser.js'));
    $.evalFile(new File(root + '/host/figma/aeShapeBuilder.jsx'));
    $.evalFile(new File(root + '/host/figma/figmaRunner.jsx'));
    var status = runImportBatch(dir + '/job.json');
    assert(!/error:|IMG grade|IMG:/i.test(status), status);

    var comp = null;
    for (var c = 1; c <= app.project.numItems; c++) {
      var item = app.project.item(c);
      if (item instanceof CompItem && item.name === 'F2A grade effect live test') comp = item;
    }
    assert(comp, 'main composition missing');
    var wrapper = null;
    for (var l = 1; l <= comp.numLayers; l++) if (comp.layer(l).name === '图片') wrapper = comp.layer(l);
    assert(wrapper && wrapper.source instanceof CompItem, 'picture has no outer precomp layer');

    var fx = effects(wrapper);
    assert(fx.length === 1 && fx[0].matchName === 'F2A Figma Image Grade',
      'outer precomp effect: ' + fx.map(function (e) { return e.matchName; }).join(','));
    var values = [];
    for (var p = 1; p <= 7; p++) values.push(fx[0].property(p).value);
    assert(values.join(',') === '-17,5,18,-26,21,-21,13', 'restored values: ' + values.join(','));
    var stray = [];
    for (var n = 1; n <= wrapper.source.numLayers; n++)
      if (effects(wrapper.source.layer(n)).length) stray.push(wrapper.source.layer(n).name);
    assert(!stray.length, 'grade duplicated inside the precomp: ' + stray.join(','));
    report.passed = true; report.status = status; report.values = values;
  } catch (error) {
    report.error = String(error); report.line = error.line;
  } finally {
    // Remove every item this test created; keep whatever the user's project already had.
    for (var k = app.project.numItems; k >= 1; k--) {
      var owned = app.project.item(k);
      if (before[owned.id]) continue;
      try { owned.remove(); } catch (e) {}
    }
  }
  return JSON.stringify(report);
})()
