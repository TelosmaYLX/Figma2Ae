(function(){
  if(typeof F2A_CASE!=='string'||F2A_CASE!=='nested-image-masks')return 'Nested mask check not requested';
  var root=F2A_ROOT,dir=root+'/artifacts/nested-image-masks',previous=app.project.activeItem,before={},comp=null,imported=null;
  var report={passed:false,cases:[]};
  function read(name){var f=new File(dir+'/'+name);f.encoding='UTF-8';f.open('r');var data=JSON.parse(f.read());f.close();return data;}
  function write(name,data){var f=new File(dir+'/'+name);f.encoding='UTF-8';f.open('w');f.write(JSON.stringify(data));f.close();}
  function progress(stage){write('native-progress.json',{stage:stage,time:new Date().getTime()});}
  function assert(value,message){if(!value)throw new Error(message);}
  function layer(comp,name){for(var i=1;i<=comp.numLayers;i++)if(comp.layer(i).name===name)return comp.layer(i);return null;}
  function inspect(comps,kind){
    var kv=null;
    for(var i=0;i<comps.length;i++)if(comps[i].name==='KV')kv=comps[i];
    assert(kv,kind+' missing KV comp');
    var outer=layer(kv,'image 381 内容');
    assert(outer&&outer.source instanceof CompItem,kind+' missing outer content precomp');
    assert(outer.trackMatteLayer&&outer.trackMatteType===TrackMatteType.ALPHA,kind+' outer matte missing');
    assert(!outer.trackMatteLayer.enabled,kind+' outer matte visible as artwork');
    assert(!outer.collapseTransformation,kind+' outer content is not composited before masking');
    assert(layer(kv,'unmasked background')&&layer(kv,'next_photo'),kind+' lost adjacent unmasked/next-mask artwork');
    var inner=[];
    for(var i=0;i<4;i++){
      report.stage=kind+' point '+i;
      var point=layer(outer.source,'point '+i);
      assert(point&&point.source instanceof CompItem,kind+' missing point '+i);
      assert(!point.trackMatteLayer,kind+' outer matte duplicated on point '+i);
      var photo=layer(point.source,'image_379_'+i);
      assert(photo&&photo.source instanceof FootageItem,kind+' image merged in point '+i);
      assert(photo.source.width===160&&photo.source.height===80,kind+' original image dimensions changed');
      assert(photo.trackMatteLayer&&photo.trackMatteType===(i===3?TrackMatteType.LUMA:TrackMatteType.ALPHA),kind+' local matte missing '+i);
      assert(!photo.trackMatteLayer.enabled,kind+' inner matte visible as artwork '+i);
      var pos=photo.transform.position.value;
      report.position=pos;
      assert(pos[0]>39.999&&pos[0]<40.001&&pos[1]>23.999&&pos[1]<24.001,kind+' local position drift');
      inner.push({group:point.name,image:photo.name,matte:photo.trackMatteLayer.name,type:i===3?'LUMA':'ALPHA',position:pos});
    }
    assert(layer(outer.source,'image_383_angle')&&!layer(outer.source,'image_383_angle').trackMatteLayer,kind+' angle image must use shared outer matte');
    report.cases.push({kind:kind,outer:outer.name,matte:outer.trackMatteLayer.name,inner:inner});
  }
  try{
    progress('starting');
    for(var i=1;i<=app.project.numItems;i++)before[app.project.item(i).id]=true;
    $.evalFile(new File(root+'/host/figma/svgParser.js'));
    $.evalFile(new File(root+'/host/figma/aeShapeBuilder.jsx'));
    $.evalFile(new File(root+'/host/figma/figmaRunner.jsx'));
    comp=app.project.items.addComp('F2A nested-mask test',480,360,1,10,30);comp.openInViewer();
    var status=runImportBatch(dir+'/job.json');progress('host imported');
    assert(!/error:|mask missing|IMG missing/i.test(status),status);
    var hostComps=[],hostIds={};
    for(var i=1;i<=app.project.numItems;i++){
      var item=app.project.item(i);hostIds[item.id]=true;
      if(!before[item.id]&&item instanceof CompItem)hostComps.push(item);
    }
    inspect(hostComps,'host');progress('host checked');
    assert(!/lost\)/i.test(status),status);
    imported=app.project.importFile(new ImportOptions(new File(read('result.json').project)));progress('aep imported');
    var aepComps=[];
    for(var i=1;i<=app.project.numItems;i++)if(!hostIds[app.project.item(i).id]&&app.project.item(i) instanceof CompItem)aepComps.push(app.project.item(i));
    inspect(aepComps,'aep');
    report.passed=true;report.status=status;delete report.stage;delete report.position;
  }catch(error){report.error=String(error);report.line=error.line;}
  finally{
    function removeOwned(item){
      if(!item||before[item.id])return;
      if(item instanceof CompItem){
        var sources=[];for(var n=1;n<=item.numLayers;n++)if(item.layer(n) instanceof AVLayer&&item.layer(n).source)sources.push(item.layer(n).source);
        for(var n=0;n<sources.length;n++)try{removeOwned(sources[n]);}catch(cleanup){}
      }
      try{item.remove();}catch(cleanup){}
    }
    removeOwned(imported);removeOwned(comp);
    if(previous&&previous.openInViewer)previous.openInViewer();
  }
  write('native-report.json',report);
  return JSON.stringify(report);
})();
