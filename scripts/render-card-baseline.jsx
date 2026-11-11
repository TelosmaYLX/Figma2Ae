(function () {
  var comp = null;
  for (var i = 1; i <= app.project.numItems; i++) if (app.project.item(i).id === 44) comp = app.project.item(i);
  if (!comp || comp.name !== 'pinball_game-card') return JSON.stringify({error: 'Expected card comp not found'});
  var modes = {}, names = ['NORMAL', 'SCREEN', 'COLOR_DODGE', 'LINEAR_DODGE', 'ADD', 'OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT', 'LIGHTEN', 'MULTIPLY'];
  for (var n = 0; n < names.length; n++) try { modes[names[n]] = Number(BlendingMode[names[n]]); } catch (e) {}
  var items = [];
  for (var j = 1; j <= comp.numLayers; j++) {
    var l = comp.layer(j);
    try { if (l.source && l.source.mainSource) items.push({name: l.name, file: l.source.file.fsName, alphaMode: String(l.source.mainSource.alphaMode), premulColor: l.source.mainSource.premulColor, invertAlpha: l.source.mainSource.invertAlpha, colorProfile: l.source.mainSource.colorProfile}); } catch (e) {}
  }
  comp.saveFrameToPng(0, new File(F2A_ROOT + '/artifacts/card-brightness/before.png'));
  return JSON.stringify({modes: modes, footage: items});
})();
