(function(){
  if(typeof F2A_CASE!=='string'||F2A_CASE!=='native-image-masks')return 'Native mask check not requested';
  var root=typeof F2A_ROOT==='string'?F2A_ROOT:new File($.fileName).parent.parent.fsName.replace(/\\/g,'/');
  var dir=root+'/artifacts/native-image-masks',previous=app.project.activeItem,before={},imported=null;
  var report={passed:false,cases:[]};
  function progress(stage){var file=new File(dir+'/native-progress.json');file.open('w');file.write(JSON.stringify({stage:stage,time:new Date().getTime()}));file.close();}
  function read(name){var f=new File(dir+'/'+name);f.encoding='UTF-8';f.open('r');var data=JSON.parse(f.read());f.close();return data;}
  function assert(value,message){if(!value)throw new Error(message);}
  function inspect(comps,kind){
    var layers=[],found=[];
    for(var c=0;c<comps.length;c++)for(var n=1;n<=comps[c].numLayers;n++)layers.push(comps[c].layer(n));
    var names=['Vector_photo','Bitmap mask 内容','Luma_photo','Cropped_photo','Grouped content'];
    for(var i=0;i<names.length;i++){
      var target=null,name=names[i];
      for(var n=0;n<layers.length;n++){
        var layer=layers[n],matte=layer.trackMatteLayer;
        if(layer.name===name&&matte&&(/Figma/.test(matte.name)||/_mask$/.test(matte.name)))target=layer;
      }
      assert(target,kind+' missing independent matte: '+name);
      assert(target.trackMatteType===(name==='Luma_photo'?TrackMatteType.LUMA:TrackMatteType.ALPHA),kind+' wrong matte type: '+name);
      assert(!target.trackMatteLayer.enabled,kind+' matte is visible as artwork: '+name);
      found.push({name:name,matte:target.trackMatteLayer.name,type:name==='Luma_photo'?'LUMA':'ALPHA'});
    }
    var originals=0,crop=null;
    for(var n=0;n<layers.length;n++)if(layers[n] instanceof AVLayer&&layers[n].source instanceof FootageItem&&/^(Vector|Bitmap|Luma|Cropped|Grouped)_photo$/.test(layers[n].name)){
      assert(layers[n].source.width===160&&layers[n].source.height===80,kind+' original image dimensions changed: '+layers[n].name+' '+layers[n].source.width+'x'+layers[n].source.height+' '+layers[n].source.file.fsName);originals++;
      if(layers[n].name==='Cropped_photo')crop=layers[n];
    }
    assert(originals===5,kind+' expected five original image layers, got '+originals);
    assert(crop&&crop.trackMatteLayer,kind+' crop mask missing');
    assert(Math.abs(crop.transform.scale.value[0]-100)<.01&&Math.abs(crop.transform.scale.value[1]-100)<.01,kind+' crop scale changed');
    report.cases.push({kind:kind,originals:originals,mattes:found,cropPosition:crop.transform.position.value});
  }
  try{
    for(var i=1;i<=app.project.numItems;i++)before[app.project.item(i).id]=true;
    $.evalFile(new File(root+'/host/figma/svgParser.js'));
    $.evalFile(new File(root+'/host/figma/aeShapeBuilder.jsx'));
    $.evalFile(new File(root+'/host/figma/figmaRunner.jsx'));
    var comp=app.project.items.addComp('F2A independent-mask test',480,420,1,10,30);comp.openInViewer();
    var status=runImportBatch(dir+'/job.json');
    progress('host imported');
    assert(!/error:|mask missing|IMG missing|IMG crop precomp:/i.test(status),status);
    var hostComps=[],hostIds={};
    for(var i=1;i<=app.project.numItems;i++){
      var item=app.project.item(i);hostIds[item.id]=true;
      if(!before[item.id]&&item instanceof CompItem)hostComps.push(item);
    }
    inspect(hostComps,'host');
    progress('host checked');
    var exported=read('result.json');imported=app.project.importFile(new ImportOptions(new File(exported.project)));
    progress('aep imported');
    var aepComps=[];
    for(var i=1;i<=app.project.numItems;i++)if(!hostIds[app.project.item(i).id]&&app.project.item(i) instanceof CompItem)aepComps.push(app.project.item(i));
    inspect(aepComps,'aep');
    report.passed=true;report.status=status;
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
  var output=new File(dir+'/native-report.json');output.encoding='UTF-8';output.open('w');output.write(JSON.stringify(report));output.close();
  return JSON.stringify(report);
})();
