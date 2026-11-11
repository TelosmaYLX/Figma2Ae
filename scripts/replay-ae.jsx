(function () {
  var base = F2A_ROOT + '/', dir = base + 'artifacts/fidelity/';
  function json(name) { var f=new File(dir+name);f.encoding='UTF-8';f.open('r');var s=f.read();f.close();return eval('('+s+')'); }
  var previous = app.project.activeItem, oldIds = {}, folder = null;
  for (var i=1;i<=app.project.numItems;i++) oldIds[app.project.item(i).id]=true;
  app.beginUndoGroup('F2A fidelity '+F2A_CASE);
  try {
    $.evalFile(base+'host/figma/svgParser.js');
    $.evalFile(base+'host/figma/aeShapeBuilder.jsx');
    folder=app.project.items.addFolder('F2A fidelity '+F2A_CASE);
    var comp=app.project.items.addComp('pinball '+F2A_CASE,832,1068,1,1,30);
    comp.parentFolder=folder;
    comp.openInViewer();
    var model=SVGParser.fromNodes(json('nodes.json'),832,1068,{x:0,y:0});
    var effects=json('effects.json'), eff=[];
    for(var e=0;e<effects.length;e++)if(!effects[e].leaf)eff.push(effects[e]);
    var shapes=AEShapeBuilder.build(model,{comp:comp,gradientPresets:json('gradients.json'),effects:eff});
    var textCount=AEShapeBuilder.buildText(comp,json('texts.json'));
    var imageCount=AEShapeBuilder.buildImages(comp,json('images.json'),dir+'assets');
    var groups=AEShapeBuilder.organize(comp,json('containers.json'));
    comp.saveFrameToPng(0,new File(dir+F2A_CASE+'.png'));
    for(var j=1;j<=app.project.numItems;j++){var item=app.project.item(j);if(!oldIds[item.id]&&item!==folder)item.parentFolder=folder;}
    return JSON.stringify({compId:comp.id,folderId:folder.id,shapes:shapes.length,texts:textCount,images:imageCount,groups:groups,diag:AEShapeBuilder.getDiag(),render:dir+F2A_CASE+'.png'});
  } catch(e) { return JSON.stringify({error:e.toString(),line:e.line,folderId:folder ? folder.id:null}); }
  finally { app.endUndoGroup();try{if(previous&&previous.openInViewer)previous.openInViewer();}catch(restore){} }
})();
