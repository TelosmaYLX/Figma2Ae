// Inspect and render the real homepage exports without changing the user's project.
(function(){
  var root=typeof F2A_ROOT==='string'?F2A_ROOT:new File($.fileName).parent.parent.fsName.replace(/\\/g,'/');
  var dir=root+'/artifacts/home-backdrop-20261116/',report={cases:[],errors:[]},folder=null,previous=app.project.activeItem;
  function read(file){var f=new File(file);f.encoding='UTF-8';f.open('r');var v=JSON.parse(f.read());f.close();return v;}
  function write(){var f=new File(dir+'native.json');f.encoding='UTF-8';f.open('w');f.write(JSON.stringify(report));f.close();}
  function render(c,name){var queue=app.project.renderQueue,disabled=[],rq=null;
    try{for(var i=1;i<=queue.numItems;i++)if(queue.item(i).status===RQItemStatus.QUEUED){disabled.push(queue.item(i));queue.item(i).render=false;}
      rq=queue.items.add(c);rq.applyTemplate('\u6700\u4f73\u8bbe\u7f6e');rq.timeSpanStart=0;rq.timeSpanDuration=1/c.frameRate;
      var om=rq.outputModule(1);om.applyTemplate('_HIDDEN X-Factor 8');om.file=new File(dir+name+'_[#####].png');queue.render();
    }finally{if(rq)rq.remove();for(var d=0;d<disabled.length;d++)disabled[d].render=true;}
  }
  try{app.beginSuppressDialogs();var cases=read(dir+'cases.json');
    for(var ci=0;ci<cases.length;ci++){
      var spec=cases[ci],main=null,button=null,row={name:spec.name,missing:[],title:null,background:null};
      folder=app.project.importFile(new ImportOptions(new File(spec.project)));
      function walk(f){for(var i=1;i<=f.numItems;i++){var c=f.item(i);
        if(c instanceof FolderItem)walk(c);
        else if(c instanceof FootageItem&&c.footageMissing)row.missing.push(c.name);
        else if(c instanceof CompItem)for(var j=1;j<=c.numLayers;j++){
          var l=c.layer(j);if(l.guideLayer)main=c;
          if(l.name==='\u6302\u724c\u987b\u77e5'&&l instanceof ShapeLayer){
            for(var k=1;k<=c.numLayers;k++){var bg=c.layer(k);if(bg.name==='\u5e95\u6846'&&bg.source instanceof FootageItem){
              button=c;row.title={shape:true,position:l.transform.position.value,scale:l.transform.scale.value};
              row.background={width:bg.source.width,height:bg.source.height,scale:bg.transform.scale.value,index:bg.index,titleIndex:l.index};}}
          }
        }
      }}walk(folder);
      if(!main||!button||!row.background)throw Error('Homepage button layers missing');
      if(row.missing.length)throw Error('Missing footage');
      if(row.background.index<=row.background.titleIndex)throw Error('The title must remain above the separate background');
      render(button,spec.name+'-button');render(main,spec.name);
      report.cases.push(row);folder.remove();folder=null;write();
    }report.done=true;
  }catch(e){report.errors.push(String(e)+' line '+e.line);}
  finally{if(folder)folder.remove();try{if(previous)previous.openInViewer();}catch(e){}app.endSuppressDialogs(false);write();}
})();
