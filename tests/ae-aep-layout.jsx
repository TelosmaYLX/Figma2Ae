(function(){
  var root=F2A_ROOT,previous=app.project.activeItem,imported=null;
  function read(file){var f=new File(file);f.encoding='UTF-8';f.open('r');var result=eval('('+f.read()+')');f.close();return result;}
  function json(value){
    if(value===null)return 'null';
    if(typeof value==='string')return '"'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\r/g,'\\r').replace(/\n/g,'\\n')+'"';
    if(typeof value!=='object')return String(value);
    var out=[],key;if(value instanceof Array){for(key=0;key<value.length;key++)out.push(json(value[key]));return '['+out.join(',')+']';}
    for(key in value)if(value.hasOwnProperty(key))out.push(json(key)+':'+json(value[key]));return '{'+out.join(',')+'}';
  }
  function close(a,b,label){if(Math.abs(a-b)>.05)throw new Error(label+': '+a+' != '+b);}
  try{
    var data=read(root+'/artifacts/aep-layout-native.json'),model=read(data.expected),layers={},contexts={},main=null,count=0,checked=[];
    for(var c=0;c<model.containers.length;c++){var container=model.containers[c];contexts[container.id]=container.clip?container:(container.cb||container);}
    function origin(item){var path=item.path||[];for(var p=path.length-1;p>=0;p--)if(contexts[path[p]])return contexts[path[p]];return {x:0,y:0};}
    imported=app.project.importFile(new ImportOptions(new File(data.project)));
    function walk(folder){for(var i=1;i<=folder.numItems;i++){
      var item=folder.item(i);
      if(item instanceof FolderItem)walk(item);
      else if(item instanceof CompItem){
        if(item.name===model.name&&item.parentFolder.name===model.name)main=item;
        for(var n=1;n<=item.numLayers;n++){
          var layer=item.layer(n);checked.push(layer);layers[layer.name]=layer;count++;
        }
      }
    }}
    walk(imported);
    if(!main)throw new Error('Missing main composition');
    main.saveFrameToPng(0,new File(root+'/artifacts/aep-layout-ae.png'));
    for(var n=0;n<checked.length;n++){
      var layer=checked[n],rect=layer.sourceRectAtTime(0,false),anchor=layer.transform.anchorPoint.value;
      if(layer instanceof TextLayer&&!layer.collapseTransformation)throw new Error(layer.name+' is missing continuous rasterization');
      close(anchor[0],rect.left+rect.width/2,layer.name+' anchor X');
      close(anchor[1],rect.top+rect.height/2,layer.name+' anchor Y');
    }
    for(i=0;i<model.texts.length;i++)close(layers[model.texts[i].name].transform.rotation.value,model.texts[i].rotation||0,model.texts[i].name+' rotation');
    for(i=0;i<model.images.length;i++){
      var image=model.images[i],layer=layers[image.name],scale=layer.transform.scale.value;
      var sx=image.cw/layer.source.width,sy=image.ch/layer.source.height;
      var expected=image.rasterScale?100/image.rasterScale:100*(image.scaleMode==='FIT'?Math.min(sx,sy):Math.max(sx,sy));
      close(scale[0],expected,image.name+' scale X');close(scale[1],expected,image.name+' scale Y');
      var offset=image.reference?{x:0,y:0}:origin(image),position=layer.transform.position.value;
      close(position[0],image.cx-offset.x,image.name+' position X');close(position[1],image.cy-offset.y,image.name+' position Y');
    }
    return json({passed:true,layers:count,images:model.images.length,preview:root+'/artifacts/aep-layout-ae.png'});
  }catch(error){return json({passed:false,error:String(error),line:error.line,lastLayer:layer?layer.name:null,rect:rect?{x:rect.left,y:rect.top,w:rect.width,h:rect.height}:null,isText:layer instanceof TextLayer});}
  finally{if(imported)imported.remove();if(previous&&previous.openInViewer)previous.openInViewer();}
})();
