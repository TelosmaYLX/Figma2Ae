// Render fresh exports and verify that the hollow border never absorbs its blend decorations.
(function(){
  var root=typeof F2A_ROOT==='string'?F2A_ROOT:new File($.fileName).parent.parent.fsName.replace(/\\/g,'/');
  var dir=root+'/artifacts/hollow-blend-20261116/',report={cases:[],errors:[]},folder=null,previous=app.project.activeItem;
  function read(file){var f=new File(file);f.encoding='UTF-8';f.open('r');var v=JSON.parse(f.read());f.close();return v;}
  function write(){var f=new File(dir+'native.json');f.encoding='UTF-8';f.open('w');f.write(JSON.stringify(report));f.close();}
  function render(c,name){var queue=app.project.renderQueue,disabled=[],rq=null;
    try{for(var i=1;i<=queue.numItems;i++)if(queue.item(i).status===RQItemStatus.QUEUED){disabled.push(queue.item(i));queue.item(i).render=false;}
      rq=queue.items.add(c);rq.applyTemplate('\u6700\u4f73\u8bbe\u7f6e');rq.timeSpanStart=0;rq.timeSpanDuration=1/c.frameRate;
      var om=rq.outputModule(1);om.applyTemplate('_HIDDEN X-Factor 8');om.file=new File(dir+name+'_[#####].png');queue.render();
    }finally{if(rq)rq.remove();for(var d=0;d<disabled.length;d++)disabled[d].render=true;}
  }
  function isolateTexture(c){var found=false;for(var i=1;i<=c.numLayers;i++){
    var l=c.layer(i),keep=false;
    if(l.source instanceof CompItem)keep=l.source.name==='\u7eb9\u7406'||isolateTexture(l.source);
    l.enabled=keep;found=found||keep;
  }return found;}
  try{app.beginSuppressDialogs();var cases=read(dir+'cases.json');
    for(var ci=0;ci<cases.length;ci++){
      var spec=cases[ci],main=null,row={name:spec.name,decorations:[],images:[],missing:[]};
      folder=app.project.importFile(new ImportOptions(new File(spec.project)));
      function walk(f){for(var i=1;i<=f.numItems;i++){var c=f.item(i);
        if(c instanceof FolderItem)walk(c);
        else if(c instanceof FootageItem&&c.footageMissing)row.missing.push(c.name);
        else if(c instanceof CompItem)for(var j=1;j<=c.numLayers;j++){
          var l=c.layer(j);if(l.guideLayer)main=c;
          if(c.name==='bg:s:img'&&(/Rectangle 116[2345]/.test(l.name)||l.name==='Subtract')){
            row.decorations.push({name:l.name,shape:l instanceof ShapeLayer,softLight:l.blendingMode===BlendingMode.SOFT_LIGHT,opacity:l.transform.opacity.value,scale:l.transform.scale.value});
          }
          if(l.name==='image_630'||l.name==='image_633')row.images.push({name:l.name,scale:l.transform.scale.value,position:l.transform.position.value,anchor:l.transform.anchorPoint.value});
        }
      }}walk(folder);if(!main)throw Error('Main comp missing');if(row.missing.length)throw Error('Missing footage');
      if(spec.verify){if(row.decorations.length!==5)throw Error('Expected five independent decoration layers');
        for(var n=0;n<row.decorations.length;n++){var d=row.decorations[n];if(!d.shape)throw Error('Decoration is no longer editable');if(d.name!=='Subtract'&&!d.softLight)throw Error('Soft Light was lost');
          var expectedOpacity=/Rectangle 116[45]/.test(d.name)?50:100;if(Math.abs(d.opacity-expectedOpacity)>.001)throw Error('Decoration opacity changed');}}
      render(main,spec.name);
      if(spec.texture){if(!isolateTexture(main))throw Error('Texture group missing');render(main,'texture-aep');}
      report.cases.push(row);folder.remove();folder=null;write();
    }report.done=true;
  }catch(e){report.errors.push(String(e)+' line '+e.line);}
  finally{if(folder)folder.remove();try{if(previous)previous.openInViewer();}catch(e){}app.endSuppressDialogs(false);write();}
})();
