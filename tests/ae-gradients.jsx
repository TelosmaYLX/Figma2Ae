(function () {
  var base=F2A_ROOT+'/', folder=null, previous=app.project.activeItem;
  var oldIds={};
  for(var oi=1;oi<=app.project.numItems;oi++)oldIds[app.project.item(oi).id]=true;
  function assert(ok,message){if(!ok)throw new Error(message);}
  function countProps(group,match){
    var total=0;
    for(var i=1;i<=group.numProperties;i++){
      var p=group.property(i);
      if(p.matchName===match)total++;
      if(p.numProperties)total+=countProps(p,match);
    }
    return total;
  }
  function inspect(comp,seen,result){
    if(seen[comp.id])return;seen[comp.id]=true;
    for(var i=1;i<=comp.numLayers;i++){
      var l=comp.layer(i),vectors=l.property('ADBE Root Vectors Group');
      if(vectors){result.fills+=countProps(vectors,'ADBE Vector Graphic - G-Fill');result.strokes+=countProps(vectors,'ADBE Vector Graphic - G-Stroke');result.solids+=countProps(vectors,'ADBE Vector Graphic - Fill');}
      if(l instanceof TextLayer){result.texts++;assert(l.property('ADBE Text Properties').property('ADBE Text Document').value.text.length>0,'Empty editable text');}
      if(/ gradient$/.test(l.name)){
        var matte=l.trackMatteLayer;
        assert(matte && matte instanceof TextLayer,'Gradient lost its editable text matte: '+l.name);
        assert(matte.containingComp.id===comp.id,'Text and gradient are in different precomps');
        result.mattes++;
      }
      if(l.source && l.source instanceof CompItem)inspect(l.source,seen,result);
    }
  }
  app.beginUndoGroup('F2A gradient regression');
  try{
    $.evalFile(base+'host/figma/svgParser.js');$.evalFile(base+'host/figma/aeShapeBuilder.jsx');
    var file=new File(base+'artifacts/gradient-test/fixture.json');file.encoding='UTF-8';file.open('r');var fixture=eval('('+file.read()+')');file.close();
    folder=app.project.items.addFolder('F2A gradient regression');
    var comp=app.project.items.addComp('F2A regression',832,1068,1,1,30);comp.parentFolder=folder;comp.openInViewer();
    var model=SVGParser.fromNodes(fixture.nodes,832,1068,{x:0,y:0});
    var layers=AEShapeBuilder.build(model,{comp:comp,gradientPresets:fixture.presets});
    assert(layers.length===7,'Expected all 7 gradient shapes, got '+layers.length);
    assert(AEShapeBuilder.buildText(comp,fixture.texts)===3,'Expected 3 editable texts');
    assert(!/TOP:|failed|TXTGRAD:/.test(AEShapeBuilder.getDiag()),AEShapeBuilder.getDiag());
    AEShapeBuilder.organize(comp,fixture.containers);
    var result={fills:0,strokes:0,solids:0,texts:0,mattes:0};inspect(comp,{},result);
    assert(result.fills===9 && result.strokes===1,'Missing native gradients: '+JSON.stringify(result));
    assert(result.solids===5,'Missing solid underpaints: '+result.solids);
    assert(result.texts===3 && result.mattes===3,'Text gradients failed after nested precompose');

    // A failed shape is removed before tracking, leaving a deleted preset target behind.
    var recovery=app.project.items.addComp('F2A recovery',832,1068,1,1,30);recovery.parentFolder=folder;recovery.openInViewer();
    var recoveryModel=SVGParser.fromNodes(fixture.nodes,832,1068,{x:0,y:0});
    recoveryModel.shapes[0].extraPaints=[null];
    var recovered=AEShapeBuilder.build(recoveryModel,{comp:recovery,gradientPresets:fixture.presets});
    assert(recovered.length===6,'One failed shape blocked later gradients: '+AEShapeBuilder.getDiag());
    AEShapeBuilder.buildText(recovery,[fixture.texts[0]]);
    assert(!/TXTGRAD:/.test(AEShapeBuilder.getDiag()),'Deleted preset target blocked later text: '+AEShapeBuilder.getDiag());
    result.recoveredFailedShape=true;
    return JSON.stringify({passed:true,checks:result});
  }catch(e){return JSON.stringify({passed:false,error:e.toString(),line:e.line});}
  finally{
    if(folder){
      for(var i=1;i<=app.project.numItems;i++){var item=app.project.item(i);if(!oldIds[item.id] && item!==folder && item.parentFolder!==folder)item.parentFolder=folder;}
      folder.remove();
    }
    try{if(previous&&previous.openInViewer)previous.openInViewer();}catch(restore){}
    app.endUndoGroup();
  }
})();
