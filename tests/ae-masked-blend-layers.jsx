// Import and render prepared AEP cases, then remove only the imported items.
(function(){
  var root=new File($.fileName).parent.parent.fsName.replace(/\\/g,'/');
  var dir=root+'/artifacts/owcs-card-color-v2-20261116/';
  var report={cases:[],errors:[]},folders=[],previous=app.project.activeItem;
  function write(){var f=new File(dir+'ae-report.json');f.encoding='UTF-8';f.open('w');f.write(JSON.stringify(report));f.close();}
  function read(file){var f=new File(file);f.encoding='UTF-8';f.open('r');var s=f.read();f.close();return JSON.parse(s);}
  try{
    app.beginSuppressDialogs();
    var cases=read(dir+'cases.json');
    for(var ci=0;ci<cases.length;ci++){
      var spec=cases[ci],folder=app.project.importFile(new ImportOptions(new File(spec.project)));folders.push(folder);
      var result={name:spec.name,layers:[],missing:[]},main=null;
      function walk(parent){for(var i=1;i<=parent.numItems;i++){
        var item=parent.item(i);
        if(item instanceof FolderItem)walk(item);
        else if(item instanceof FootageItem&&item.footageMissing)result.missing.push(item.name);
        else if(item instanceof CompItem)for(var j=1;j<=item.numLayers;j++){
          var l=item.layer(j);if(l.guideLayer)main=item;
          var r={comp:item.name,name:l.name,blend:String(l.blendingMode),opacity:l.transform.opacity.value,enabled:l.enabled};
          try{r.collapse=l.collapseTransformation;r.hasTrackMatte=l.hasTrackMatte;r.matte=l.trackMatteLayer?l.trackMatteLayer.name:null;}catch(e){}
          result.layers.push(r);
        }
      }}
      walk(folder);if(!main)throw Error('No main/reference composition: '+spec.name);
      var rq=app.project.renderQueue.items.add(main);rq.applyTemplate('最佳设置');rq.timeSpanStart=0;rq.timeSpanDuration=1/main.frameRate;
      var om=rq.outputModule(1);om.applyTemplate('PNG序列');om.file=new File(dir+spec.name+'_[#####].png');
      app.project.renderQueue.render();rq.remove();report.cases.push(result);write();
      folder.remove();folders.pop();
    }
    report.done=true;
  }catch(e){report.errors.push(String(e)+' line '+e.line);}
  finally{for(var k=folders.length-1;k>=0;k--)try{folders[k].remove();}catch(e){}try{if(previous)previous.openInViewer();}catch(e){}app.endSuppressDialogs(false);write();}
})();
