(function () {
  var c=null,copy=null,folder=null,prev=app.project.activeItem,oldIds={},dir=F2A_ROOT+'/artifacts/card-brightness/';
  for(var i=1;i<=app.project.numItems;i++){var it=app.project.item(i);oldIds[it.id]=true;if(it instanceof CompItem&&it.name==='pinball_game-card'&&it.numLayers===17)c=it;}
  function read(name){var f=new File(dir+name);f.encoding='UTF-8';f.open('r');var s=f.read();f.close();return eval('('+s+')');}
  app.beginUndoGroup('F2A temporary card brightness verification');
  try {
    if(app.project.bitsPerChannel!==8||app.project.workingSpace!=='None')throw new Error('The sample comparison requires 8 bpc with no working space');
    folder=app.project.items.addFolder('F2A temporary brightness verification');
    if(!c){
      app.project.importFile(new ImportOptions(new File('D:/Users/Desktop/F2A test.aep')));
      for(i=1;i<=app.project.numItems;i++){var candidate=app.project.item(i);if(!oldIds[candidate.id]&&candidate instanceof CompItem&&candidate.name==='pinball_game-card'&&candidate.numLayers===17)c=candidate;}
    }
    if(!c)throw new Error('The supplied AEP does not contain the expected comparison card');
    $.evalFile(F2A_ROOT+'/host/figma/aeShapeBuilder.jsx');
    copy=c.duplicate();copy.name='F2A temporary corrected card';
    var counter=copy.layer(5),reference=copy.layer(1);
    if(!(counter instanceof TextLayer))throw new Error('Expected editable counter');
    for(var j=2;j<=copy.numLayers;j++)copy.layer(j).enabled=(copy.layer(j)===counter);
    var images=read('import-images.json'),made=AEShapeBuilder.buildImages(copy,images,dir);
    if(made!==4)throw new Error('Expected one background and three circle PNGs, got '+made);
    var foundAdd=false;
    for(j=1;j<=made;j++){
      var l=copy.layer(j),p=l.property('ADBE Transform Group').property('ADBE Position'),v=p.value;
      p.setValue([v[0]+100,v[1]+100,v[2]]);
      if(l.name==='外发光'){if(l.blendingMode!==BlendingMode.ADD)throw new Error('Additive glow mapping was not applied');foundAdd=true;}
    }
    if(!foundAdd)throw new Error('Glow layer missing');
    counter.moveToBeginning();reference.moveToBeginning();
    copy.saveFrameToPng(0,new File(dir+'after.png'));
    return JSON.stringify({passed:true,images:made,editableTexts:1,backgroundExports:read('export-report.json').backgroundExports,
      glowMode:'ADD',projectWorkingSpace:app.project.workingSpace,bitsPerChannel:app.project.bitsPerChannel,
      source:'Existing real Figma PNGs, actual exporter packets and native AE image builder; not a fresh live Figma export',diag:AEShapeBuilder.getDiag()});
  }catch(e){return JSON.stringify({passed:false,error:e.toString(),line:e.line});}
  finally{
    if(folder){
      for(i=1;i<=app.project.numItems;i++){var item=app.project.item(i);if(!oldIds[item.id]&&item!==folder)item.parentFolder=folder;}
      folder.remove();
    }
    app.endUndoGroup();try{if(prev&&prev.openInViewer)prev.openInViewer();}catch(e){}
  }
})();
