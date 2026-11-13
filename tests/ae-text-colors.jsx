(function(){
 var owned=!app.project.file&&app.project.numItems===0,checks=0,report;
 function read(path){var f=new File(path);f.encoding='UTF-8';f.open('r');var d=eval('('+f.read()+')');f.close();return d;}
 function json(v){if(v===null)return 'null';if(typeof v==='string')return '"'+v.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\r/g,'\\r').replace(/\n/g,'\\n')+'"';if(typeof v!=='object')return String(v);var a=[],k;if(v instanceof Array){for(k=0;k<v.length;k++)a.push(json(v[k]));return '['+a.join(',')+']';}for(k in v)if(v.hasOwnProperty(k))a.push(json(k)+':'+json(v[k]));return '{'+a.join(',')+'}';}
 app.beginSuppressDialogs();
 try{
  if(!owned)throw new Error('Requires isolated empty session');
  var data=read('D:/Tools/F2A/artifacts/text-colors/input.json'),imported=app.project.importFile(new ImportOptions(new File(data.project))),layers={};
  function find(folder){for(var i=1;i<=folder.numItems;i++){var it=folder.item(i);if(it instanceof FolderItem)find(it);else if(it instanceof CompItem)for(var j=1;j<=it.numLayers;j++)layers[it.layer(j).name]=it.layer(j);}}
  find(imported);
  var actual=[];
  for(var i=0;i<data.texts.length;i++){
   var item=data.texts[i],layer=layers[item.name];
   while(!(layer instanceof TextLayer)&&layer.source instanceof CompItem)layer=layer.source.layer(1);
   var doc=layer.property('ADBE Text Properties').property('ADBE Text Document').value;
   var segs=item.segs||[{characters:item.characters,color:item.color}],offset=0;
   for(var j=0;j<segs.length;j++){
    var sg=segs[j],value=doc.characterRange(offset,offset+sg.characters.length).fillColor;
    actual.push({name:item.name,range:offset,color:value});
    for(var c=0;c<3;c++)if(!isFinite(value[c])||Math.abs(value[c]-sg.color[c])>0.000001)throw new Error(item.name+' channel '+c+': '+value[c]+' != '+sg.color[c]);
    checks++;offset+=sg.characters.length;
   }
  }
  report={passed:true,project:data.project,checks:checks,actual:actual};
 }catch(e){report={passed:false,error:String(e),line:e.line,checks:checks};}
 var out=new File('D:/Tools/F2A/artifacts/text-colors/ae-report.json');out.open('w');out.write(json(report));out.close();
 app.endSuppressDialogs(false);
 if(owned){app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);app.quit();}
})();
