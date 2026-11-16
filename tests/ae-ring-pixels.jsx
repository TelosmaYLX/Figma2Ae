// Render the real card through both importers and inspect every rasterization boundary.
(function(){
  var root=typeof F2A_ROOT==='string'?F2A_ROOT:new File($.fileName).parent.parent.fsName.replace(/\\/g,'/');
  var dir=root+'/artifacts/owcs-ring-pixels-20261116/';
  var report={cases:[],errors:[]},owned=[],previous=app.project.activeItem;
  function read(file){var f=new File(file);f.encoding='UTF-8';f.open('r');var v=JSON.parse(f.read());f.close();return v;}
  function write(){var f=new File(dir+'ae-report.json');f.encoding='UTF-8';f.open('w');f.write(JSON.stringify(report));f.close();}
  function render(comp,name){
    var disabled=[],queue=app.project.renderQueue;
    for(var i=1;i<=queue.numItems;i++)if(queue.item(i).status===RQItemStatus.QUEUED){disabled.push(queue.item(i));queue.item(i).render=false;}
    var rq=queue.items.add(comp);
    try{rq.applyTemplate('\u6700\u4f73\u8bbe\u7f6e');rq.timeSpanStart=0;rq.timeSpanDuration=1/comp.frameRate;
      var om=rq.outputModule(1);om.applyTemplate('_HIDDEN X-Factor 8');
      om.file=new File(dir+name+'_[#####].png');queue.render();}
    finally{rq.remove();for(var d=0;d<disabled.length;d++)disabled[d].render=true;}
  }
  function inspect(comp,offset,result,parents){
    for(var i=1;i<=comp.numLayers;i++){
      var l=comp.layer(i);if(l.guideLayer)continue;
      var p=l.transform.position.value,a=l.transform.anchorPoint.value,s=l.transform.scale.value;
      var local=[p[0]-a[0]*s[0]/100,p[1]-a[1]*s[1]/100],world=[offset[0]+local[0],offset[1]+local[1]];
      var row={comp:comp.name,name:l.name,enabled:l.enabled,position:p,anchor:a,scale:s,localOrigin:local,worldOrigin:world,parents:parents};
      if(l.source){row.sourceSize=[l.source.width,l.source.height];row.file=l.source.file?l.source.file.fsName:null;}
      try{row.collapse=l.collapseTransformation;row.masks=l.property('ADBE Mask Parade').numProperties;row.trackMatte=l.trackMatteLayer?l.trackMatteLayer.name:null;}catch(e){}
      result.layers.push(row);
      if(l.enabled&&l.source instanceof CompItem)inspect(l.source,world,result,parents.concat([{name:l.name,origin:local,collapse:l.collapseTransformation}]));
    }
  }
  try{
    app.beginSuppressDialogs();
    report.settings={bits:app.project.bitsPerChannel,space:app.project.workingSpace,linear:app.project.linearizeWorkingSpace};
    var cases=read(dir+'cases.json');
    for(var ci=0;ci<cases.length;ci++){
      var spec=cases[ci],folder=app.project.importFile(new ImportOptions(new File(spec.project)));owned.push(folder);
      var main=null;function find(f){for(var i=1;i<=f.numItems;i++){var item=f.item(i);if(item instanceof FolderItem)find(item);else if(item instanceof CompItem)for(var j=1;j<=item.numLayers;j++)if(item.layer(j).guideLayer)main=item;}}
      find(folder);if(!main)throw Error('Missing main comp '+spec.name);
      if(spec.hostRing){
        var model=read(spec.model),beforeHost={},p=app.project;
        for(var hi=1;hi<=p.numItems;hi++)beforeHost[p.item(hi).id]=true;
        function ring(item){var number=Number((item.sourceId||'').split(':')[1]);return number>=14701&&number<=14716;}
        var shapes=[],images=[],containers=[];
        for(hi=0;hi<model.shapes.length;hi++)if(ring(model.shapes[hi]))shapes.push(model.shapes[hi]);
        for(hi=0;hi<model.images.length;hi++)if(ring(model.images[hi])){var image=model.images[hi];image.file=('0000'+hi).slice(-4)+'.'+image.ext;images.push(image);}
        for(hi=0;hi<model.containers.length;hi++)if(model.containers[hi].root||ring(model.containers[hi]))containers.push(model.containers[hi]);
        var circle=p.items.addComp('F2A pixel grid host ring',model.width,model.height,1,model.duration,model.frameRate);
        $.evalFile(new File(root+'/host/figma/aeShapeBuilder.jsx'));
        AEShapeBuilder.build({shapes:shapes},{comp:circle,imageMasks:images,imageFolder:spec.assets});
        AEShapeBuilder.buildImages(circle,images,spec.assets);AEShapeBuilder.organize(circle,containers);AEShapeBuilder.restack(circle);
        var disabled=false;
        for(hi=1;hi<=p.numItems;hi++)if(!beforeHost[p.item(hi).id])p.item(hi).parentFolder=folder;
        for(hi=1;hi<=main.numLayers;hi++)if(main.layer(hi).source instanceof CompItem){
          var rootComp=main.layer(hi).source;
          for(var ri=1;ri<=rootComp.numLayers;ri++)if(rootComp.layer(ri).name==='\u5708bg:s:img'){rootComp.layer(ri).enabled=false;disabled=true;}
        }
        if(!disabled)throw Error('Original ring layer was not found');
        main.layers.add(circle);
      }
      var result={name:spec.name,layers:[]};inspect(main,[0,0],result,[]);render(main,spec.name);report.cases.push(result);write();
      folder.remove();owned.pop();
    }
    report.done=true;
  }catch(e){report.errors.push(String(e)+' line '+e.line);}
  finally{for(var i=owned.length-1;i>=0;i--)try{owned[i].remove();}catch(e){}try{if(previous)previous.openInViewer();}catch(e){}app.endSuppressDialogs(false);write();}
})();
