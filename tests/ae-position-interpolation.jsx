(function(){
  var imported=null,previous=app.project.activeItem,results=[],stage=null;
  function read(path){var f=new File(path);f.encoding='UTF-8';f.open('r');var value=eval('('+f.read()+')');f.close();return value;}
  function close(actual,expected,label){if(Math.abs(actual-expected)>.02)throw Error(label+': '+actual+' != '+expected);}
  function check(prop,delta,label){
    var start=prop.value.slice(),end=start.slice(),zeros=[];
    for(var d=0;d<start.length;d++){end[d]+=delta[d]||0;zeros.push(0);}
    prop.setValueAtTime(0,start);prop.setValueAtTime(1,end);
    for(var k=1;k<=2;k++){
      prop.setInterpolationTypeAtKey(k,KeyframeInterpolationType.LINEAR,KeyframeInterpolationType.LINEAR);
      prop.setSpatialAutoBezierAtKey(k,false);prop.setSpatialContinuousAtKey(k,false);
      prop.setSpatialTangentsAtKey(k,zeros,zeros);
    }
    var maxError=0,middle=prop.valueAtTime(29/30,false);
    function sample(){for(var f=0;f<=30;f++){
      var value=prop.valueAtTime(f/30,false);
      for(var d=0;d<start.length;d++){
        var expected=start[d]+(end[d]-start[d])*f/30;
        maxError=Math.max(maxError,Math.abs(value[d]-expected));
        close(value[d],expected,label+' frame '+f+' dimension '+d);
      }
    }}
    try{
      sample();
      // Inserting a key at AE's evaluated value must preserve the linear motion.
      prop.setValueAtTime(29/30,middle);sample();
      for(var d=0;d<start.length;d++)close(prop.keyValue(2)[d],start[d]+(end[d]-start[d])*29/30,label+' inserted key');
      results.push({property:label,delta:delta,maxError:maxError,middle:middle});
    }finally{while(prop.numKeys)prop.removeKey(prop.numKeys);prop.setValue(start);}
  }
  function walk(folder){for(var i=1;i<=folder.numItems;i++){
    var item=folder.item(i);
    if(item instanceof FolderItem)walk(item);
    else if(item instanceof CompItem)for(var l=1;l<=item.numLayers;l++){
      var layer=item.layer(l),transform=layer.property('ADBE Transform Group');
      for(var p=0;p<2;p++){
        var name=p?'ADBE Anchor Point':'ADBE Position',prop=transform.property(name);
        var motions=[[0,-66,0],[66,0,0],[-40,66,0]];
        for(var m=0;m<motions.length;m++){
          stage=item.name+'/'+layer.name+'/'+name+'/'+m;
          check(prop,motions[m],stage);
        }
      }
    }
  }}
  try{
    var fixture=read(F2A_ROOT+'/artifacts/aep-layout-native.json');
    imported=app.project.importFile(new ImportOptions(new File(fixture.project)));
    walk(imported);
    return JSON.stringify({passed:true,checks:results.length,results:results});
  }catch(e){return JSON.stringify({passed:false,error:String(e),line:e.line,stage:stage,checks:results.length});}
  finally{if(imported)imported.remove();if(previous&&previous.openInViewer)previous.openInViewer();}
})();
