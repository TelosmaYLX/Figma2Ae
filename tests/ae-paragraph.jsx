(function () {
  var previous = app.project.activeItem, comp = null;
  app.beginUndoGroup('F2A paragraph check');
  function check(value, expected, name) { if (Math.abs(value - expected) > 0.01) throw new Error(name + ': ' + value); }
  try {
    $.evalFile(F2A_ROOT + '/host/figma/aeShapeBuilder.jsx');
    comp = app.project.items.addComp('F2A temporary paragraph test', 400, 300, 1, 1, 30); comp.openInViewer();
    var style = {name: 'Paragraph', characters: 'First line\nSecond line', family: 'Arial', style: 'Regular', fontSize: 20,
      color: [1, 1, 1], x: 20, y: 20, w: 300, h: 100, align: 'LEFT', leading: 32, paragraphSpacing: 8, paragraphIndent: 6};
    AEShapeBuilder.buildText(comp, [style]);
    var doc = comp.layer(1).property('ADBE Text Properties').property('ADBE Text Document').value;
    if (doc.autoLeading) throw new Error('Explicit leading stayed automatic');
    check(doc.leading, 32, 'plain leading'); check(doc.spaceAfter, 8, 'plain paragraph spacing'); check(doc.firstLineIndent, 6, 'plain indent');
    var rich = {runs: true, name: 'Rich paragraph', x: 20, y: 140, w: 300, h: 100, align: 'LEFT', paragraphSpacing: 10, paragraphIndent: 4,
      segs: [{characters: 'First line\n', family: 'Arial', style: 'Regular', fontSize: 20, color: [1, 1, 1], leading: 30},
             {characters: 'Second line', family: 'Arial', style: 'Regular', fontSize: 24, color: [1, 1, 1], leading: 36}]};
    AEShapeBuilder.buildText(comp, [rich]);
    var rd = comp.layer(1).property('ADBE Text Properties').property('ADBE Text Document').value;
    check(rd.characterRange(0, 1).leading, 30, 'first run leading'); check(rd.characterRange(11, 12).leading, 36, 'second run leading');
    check(rd.spaceAfter, 10, 'rich paragraph spacing'); check(rd.firstLineIndent, 4, 'rich indent');
    return JSON.stringify({passed: true,plainLeading: doc.leading,richLeading: [rd.characterRange(0, 1).leading, rd.characterRange(11, 12).leading],paragraphSpacing: rd.spaceAfter,paragraphIndent: rd.firstLineIndent});
  } catch (e) { return JSON.stringify({passed: false,error: e.toString(),line: e.line}); }
  finally { if (comp) comp.remove(); if (previous && previous.openInViewer) previous.openInViewer(); app.endUndoGroup(); }
})();
