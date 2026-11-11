(function(){
  var dir=F2A_ROOT+'/artifacts/blend-merge/',old={},prev=app.project.activeItem,folder=null,initial=app.project.numItems;
  for(var i=1;i<=initial;i++)old[app.project.item(i).id]=true;
  function read(name){var f=new File(dir+name);f.encoding='UTF-8';f.open('r');var value=eval('('+f.read()+')');f.close();return value;}
  app.beginUndoGroup('F2A temporary blend comparison');
  try{
    if(app.project.bitsPerChannel!==8||app.project.workingSpace!=='None'||app.project.linearizeWorkingSpace)throw Error('This sample requires 8 bpc, no working space and no linearization');
    $.evalFile(F2A_ROOT+'/host/figma/aeShapeBuilder.jsx');
    $.evalFile(F2A_ROOT+'/host/figma/svgParser.js');
    var input=read('native-input.json'),report={passed:true,scope:input.scope,bits:8,space:app.project.workingSpace,blendStats:input.blendStats,cases:[]};
    folder=app.project.items.addFolder('F2A temporary blend test');
    for(var ci=0;ci<2;ci++){
      var key=ci===0?'before':'after',comp=app.project.items.addComp('F2A blend '+key,88,136,1,1,30);
      AEShapeBuilder.build({shapes:[]},{comp:comp});
      var list=input[key].concat([input.reference]),made=AEShapeBuilder.buildImages(comp,list,dir);
      if(made!==list.length)throw Error('Some test images failed to import');
      if(ci===0)for(var j=1;j<=comp.numLayers;j++)for(var k=0;k<input.before.length;k++)if(comp.layer(j).name===input.before[k].name)comp.layer(j).blendingMode=input.before[k].nativeBlend;
      if(AEShapeBuilder.buildText(comp,[input.text])!==1)throw Error('Editable counter failed to import');
      var text=comp.layer(1);
      AEShapeBuilder.restack(comp);
      if(comp.layer(1).name!=='原图对照'||comp.layer(1).enabled)throw Error('Reference must remain hidden at the top');
      if(!(text instanceof TextLayer))throw Error('Counter is no longer editable');
      comp.saveFrameToPng(0,new File(dir+key+'.png'));
      report.cases.push({name:key,images:made,editableTexts:1,referenceHidden:true,diagnostics:AEShapeBuilder.getDiag()});
    }
    report.grouped=[];
    var groups=read('grouped-input.json');
    function find(c,name){for(var j=1;j<=c.numLayers;j++)if(c.layer(j).name===name)return c.layer(j);throw Error('Missing layer '+name);}
    for(var gi=0;gi<groups.length;gi++){
      var g=groups[gi],parentComp=app.project.items.addComp('F2A grouped '+g.kind,100,60,1,1,30);
      AEShapeBuilder.build(SVGParser.fromNodes(g.nodes,100,60,{x:0,y:0}),{comp:parentComp});
      AEShapeBuilder.buildImages(parentComp,g.images,dir);AEShapeBuilder.buildText(parentComp,g.texts);
      AEShapeBuilder.organize(parentComp,g.containers);AEShapeBuilder.restack(parentComp);
      var rootLayer=find(parentComp,'root'),inside=rootLayer.source;
      if(g.kind==='local'){
        var local=find(inside,'local').source;
        if(find(local,'editable front').index>=find(local,'root_叠加合并').index)throw Error('Local foreground hidden by merge');
      }else if(g.kind==='cross'){
        if(find(inside,'ending').index>=find(inside,'root_叠加合并').index)throw Error('Cross-group foreground hidden by merge');
      }else if(find(inside,'outside glow').index>=find(inside,'root_叠加合并').index)throw Error('Preserved text hidden by merge');
      report.grouped.push({name:g.kind,passed:true});
    }
    return JSON.stringify(report);
  }catch(e){return JSON.stringify({passed:false,error:String(e),line:e.line});}
  finally{
    if(folder){var created=[];for(i=1;i<=app.project.numItems;i++){var item=app.project.item(i);if(!old[item.id]&&item!==folder)created.push(item);}for(i=0;i<created.length;i++)created[i].parentFolder=folder;folder.remove();}
    app.endUndoGroup();try{if(prev&&prev.openInViewer)prev.openInViewer();}catch(e){}
  }
})();
