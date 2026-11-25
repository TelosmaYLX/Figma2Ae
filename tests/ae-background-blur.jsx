(function () {
  if (typeof F2A_CASE !== 'string' || F2A_CASE !== 'background-blur') return 'background blur host check not requested';
  var root = typeof F2A_ROOT === 'string' ? F2A_ROOT :
    new File($.fileName).parent.parent.fsName.replace(/\\/g, '/');
  var dir = root + '/artifacts/background-blur-live';
  var report = {passed: false, cases: []}, before = {};
  var step = 'start';
  // ExtendScript throws a host error when an assertion message concatenates an AE value array.
  // Keep every message a plain string and compute the conditions first.
  function fail(what) { report.step = step; throw new Error(what); }
  function near(a, b, tolerance) { return Math.abs(a - b) <= (tolerance == null ? 0.01 : tolerance); }
  function effects(layer) {
    var out = [], parade = layer.property('ADBE Effect Parade');
    for (var i = 1; i <= parade.numProperties; i++) out.push(parade.property(i));
    return out;
  }
  function maskBounds(atom) {
    var shape = atom.property('ADBE Mask Shape').value, xs = [], ys = [];
    for (var i = 0; i < shape.vertices.length; i++) { xs.push(shape.vertices[i][0]); ys.push(shape.vertices[i][1]); }
    return {x: Math.min.apply(null, xs), y: Math.min.apply(null, ys),
      w: Math.max.apply(null, xs) - Math.min.apply(null, xs), h: Math.max.apply(null, ys) - Math.min.apply(null, ys)};
  }
  try {
    for (var i = 1; i <= app.project.numItems; i++) before[app.project.item(i).id] = true;
    $.evalFile(new File(root + '/host/figma/svgParser.js'));
    $.evalFile(new File(root + '/host/figma/aeShapeBuilder.jsx'));
    $.evalFile(new File(root + '/host/figma/figmaRunner.jsx'));
    step = 'fixture';
    var requests = _mkReadJson(dir + '/background-blurs.json');
    if (!requests || requests.length !== 1) fail('fixture background-blur request missing');
    var req = requests[0];
    step = 'import';
    var status = runImportBatch(dir + '/job.json');
    if (/error:/i.test(status)) fail('import failed');
    if (/BG blur/i.test(status)) fail('host reported a background blur failure');

    step = 'find-comp';
    var comp = null;
    for (var c = 1; c <= app.project.numItems; c++) {
      var item = app.project.item(c);
      if (!before[item.id] && item instanceof CompItem && item.name === 'F2A background blur live test') comp = item;
    }
    if (!comp) fail('main composition missing');

    // organize mode keeps the selected frame as a root precomp, so the card and the adjustment
    // layer live in a nested composition.
    step = 'find-layers';
    var all = [];
    (function collect(source, depth) {
      if (!source || depth > 6) return;
      all.push(source);
      for (var i = 1; i <= source.numLayers; i++) {
        try { if (source.layer(i).source instanceof CompItem) collect(source.layer(i).source, depth + 1); } catch (e) {}
      }
    })(comp, 0);
    var cardLayer = null, cardComp = null;
    for (var q = 0; q < all.length && !cardLayer; q++)
      for (var l = 1; l <= all[q].numLayers; l++)
        if (all[q].layer(l).name === '玻璃卡片' && all[q].layer(l).source instanceof CompItem) {
          cardLayer = all[q].layer(l); cardComp = all[q]; break;
        }
    if (!cardLayer) fail('card outer precomp missing');
    var adj = null;
    for (var m = 1; m <= cardComp.numLayers; m++) if (cardComp.layer(m).adjustmentLayer) adj = cardComp.layer(m);
    if (!adj) fail('no adjustment layer was created');
    if (adj.containingComp.id !== cardComp.id) fail('adjustment layer is in a different composition');

    step = 'link';
    if (adj.name !== req.name) fail('adjustment layer name mismatch');
    if (!adj.parent || adj.parent.index !== cardLayer.index) fail('adjustment layer is not parented to the source');
    if (adj.index !== cardLayer.index + 1) fail('adjustment layer must sit directly below the source');
    if (!near(adj.width, Math.round(req.size[0]), 0.5)) fail('adjustment layer width mismatch');
    if (!near(adj.height, Math.round(req.size[1]), 0.5)) fail('adjustment layer height mismatch');

    step = 'transform';
    var tg = adj.property('ADBE Transform Group');
    var anchor = tg.property('ADBE Anchor Point').value;
    var position = tg.property('ADBE Position').value;
    var scale = tg.property('ADBE Scale').value;
    if (!(near(anchor[0], req.size[0] / 2) && near(anchor[1], req.size[1] / 2))) fail('anchor mismatch');
    // `parent` keeps the composition appearance by rewriting the child's local Position, so the
    // expected local value is the parent's anchor plus the requested centre offset.
    var cardTg = cardLayer.property('ADBE Transform Group');
    var cardPosition = cardTg.property('ADBE Position').value;
    var cardAnchor = cardTg.property('ADBE Anchor Point').value;
    var expectedX = cardAnchor[0] + (req.position[0] - cardPosition[0]);
    var expectedY = cardAnchor[1] + (req.position[1] - cardPosition[1]);
    if (!(near(position[0], expectedX) && near(position[1], expectedY))) fail('local position mismatch');
    // The composition-space centre must still be exactly the Figma node centre.
    var centreX = cardPosition[0] - cardAnchor[0] + position[0];
    var centreY = cardPosition[1] - cardAnchor[1] + position[1];
    if (!(near(centreX, req.position[0]) && near(centreY, req.position[1]))) fail('composition-space centre mismatch');
    if (!near(tg.property('ADBE Rotate Z').value, req.rotation)) fail('rotation mismatch');
    if (!(near(scale[0], req.scale[0]) && near(scale[1], req.scale[1]))) fail('scale mismatch');

    step = 'mask';
    var masks = adj.property('ADBE Mask Parade');
    if (masks.numProperties !== 1) fail('mask count mismatch');
    var atom = masks.property(1);
    if (atom.maskMode !== MaskMode.ADD) fail('mask mode is not ADD');
    var bounds = maskBounds(atom);
    if (!(near(bounds.x, 0) && near(bounds.y, 0) &&
          near(bounds.w, req.size[0]) && near(bounds.h, req.size[1]))) fail('mask bounds mismatch');

    step = 'effect';
    var fx = null, parade = effects(adj);
    for (var e = 0; e < parade.length; e++)
      if (parade[e].matchName === 'F2A Figma Background Blur') fx = parade[e];
    if (!fx) fail('F2A Figma Background Blur effect missing');
    var expected = [req.mode === 'progressive' ? 2 : 1, req.radius, req.startRadius, req.endRadius,
      req.startOffset[0] * 100, req.startOffset[1] * 100, req.endOffset[0] * 100, req.endOffset[1] * 100, 0];
    var values = [];
    for (var p = 1; p <= expected.length; p++) values.push(fx.property(p).value);
    for (var g = 0; g < expected.length; g++)
      if (!near(values[g], expected[g])) fail('effect parameter ' + (g + 1) + ' mismatch');

    // The blur region follows the source: moving the parent later must not break the link or
    // rewrite the child's local transform.
    step = 'follow';
    var parentPos = cardLayer.property('Transform').property('Position').value;
    var localX = position[0], localY = position[1];
    cardLayer.property('Transform').property('Position').setValue([parentPos[0] + 10, parentPos[1] + 5, parentPos[2] || 0]);
    if (!adj.parent || adj.parent.index !== cardLayer.index) fail('parent link lost after moving the source');
    var localAfter = adj.property('Transform').property('Position').value;
    if (!(near(localAfter[0], localX) && near(localAfter[1], localY))) fail('child local position changed');
    cardLayer.property('Transform').property('Position').setValue(parentPos);

    step = 'render';
    // The frosted card must show the blurred colour boundary: save a frame for the visual check.
    cardComp.saveFrameToPng(0, new File(dir + '/render.png'));
    report.passed = true;
    report.status = status;
    report.effect = values;
    report.mask = bounds;
    report.png = dir + '/render.png';
  } catch (error) {
    report.step = step;
    report.error = String(error);
    report.line = error.line;
  } finally {
    for (var k = app.project.numItems; k >= 1; k--) {
      var owned = app.project.item(k);
      if (before[owned.id]) continue;
      try { owned.remove(); } catch (e) {}
    }
  }
  return JSON.stringify(report);
})()
