(function(){
  var root=new File($.fileName).parent.parent.fsName.replace(/\\/g,'/');
  var previous=app.project.activeItem,temporary=null,imported=null,report={passed:false};
  function read(file){var f=new File(file);f.encoding='UTF-8';f.open('r');var value=eval('('+f.read()+')');f.close();return value;}
  function json(value){
    if(value===null)return 'null';
    if(typeof value==='string')return '"'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\r/g,'\\r').replace(/\n/g,'\\n')+'"';
    if(typeof value!=='object')return String(value);
    var result=[],key;if(value instanceof Array){for(key=0;key<value.length;key++)result.push(json(value[key]));return '['+result.join(',')+']';}
    for(key in value)if(value.hasOwnProperty(key))result.push(json(key)+':'+json(value[key]));return '{'+result.join(',')+'}';
  }
  function close(actual,wanted,label){if(Math.abs(actual-wanted)>.001)throw new Error(label+': '+actual+' != '+wanted);}
  function inspect(layer,item){
    close(layer.property('ADBE Transform Group').property('ADBE Opacity').value,item.grad?100:item.opacity*100,item.name+' layer opacity');
    var segments=item.segs||[{characters:item.characters,opacity:item.fillOpacity}],expected=[],offset=0;
    for(var i=0;i<segments.length;i++){
      var segment=segments[i],end=offset+segment.characters.replace(/[\r\n\u0003\u2028\u2029\u000b\u000c\u0085]/g,'').length;
      if(segment.opacity!=null&&segment.opacity<1)expected.push([segment.opacity*100,offset,end]);offset=end;
    }
    var animators=layer.property('ADBE Text Properties').property('ADBE Text Animators');
    if(animators.numProperties!==expected.length)throw new Error(item.name+' opacity animator count: '+animators.numProperties);
    for(i=0;i<expected.length;i++){
      var animator=animators.property(i+1),selector=animator.property('ADBE Text Selectors').property(1);
      close(animator.property('ADBE Text Animator Properties').property('ADBE Text Fill Opacity').value,expected[i][0],item.name+' fill opacity');
      close(selector.property('ADBE Text Index Start').value,expected[i][1],item.name+' start');
      close(selector.property('ADBE Text Index End').value,expected[i][2],item.name+' end');
      close(selector.property('ADBE Text Range Advanced').property('ADBE Text Range Units').value,2,item.name+' units');
    }
  }
  try{
    var data=read(root+'/artifacts/text-opacity-native.json');
    $.evalFile(root+'/host/figma/aeShapeBuilder.jsx');
    temporary=app.project.items.addFolder('F2A temporary text opacity');
    var comp=app.project.items.addComp('F2A native text opacity',640,360,1,1,30);comp.parentFolder=temporary;
    var nativeCases=[];for(var i=0;i<data.texts.length;i++)if(!data.texts[i].grad)nativeCases.push(data.texts[i]);
    AEShapeBuilder.buildText(comp,nativeCases);
    for(i=0;i<nativeCases.length;i++){var nativeLayer=comp.layer(nativeCases[i].name);if(!nativeLayer)throw new Error('Missing native text: '+nativeCases[i].name);inspect(nativeLayer,nativeCases[i]);}
    imported=app.project.importFile(new ImportOptions(new File(data.project)));
    var layers={};
    function walk(folder){for(var n=1;n<=folder.numItems;n++){var item=folder.item(n);if(item instanceof FolderItem)walk(item);else if(item instanceof CompItem)for(var l=1;l<=item.numLayers;l++)layers[item.layer(l).name]=item.layer(l);}}
    walk(imported);
    for(i=0;i<data.texts.length;i++)inspect(layers[data.texts[i].name],data.texts[i]);
    for(i=0;i<data.containers.length;i++)close(layers[data.containers[i].name].property('ADBE Transform Group').property('ADBE Opacity').value,data.containers[i].opacity*100,data.containers[i].name+' precomp opacity');
    report={passed:true,nativeTexts:nativeCases.length,aepTexts:data.texts.length};
  }catch(error){report={passed:false,error:String(error),line:error.line};}
  finally{
    if(imported)imported.remove();if(temporary)temporary.remove();
    if(previous&&previous.openInViewer)previous.openInViewer();
    var output=new File(root+'/artifacts/text-opacity-ae-report.json');output.encoding='UTF-8';output.open('w');output.write(json(report));output.close();
  }
})();
