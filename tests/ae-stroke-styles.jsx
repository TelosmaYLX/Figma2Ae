(function(){
  var previous=app.project.activeItem,comp=null,imported=null,checks=[];
  var isolated=!app.project.file&&app.project.numItems===0;
  function read(path){var f=new File(path);f.encoding='UTF-8';f.open('r');var value=eval('('+f.read()+')');f.close();return value;}
  function json(value){
    if(value===null)return 'null';
    if(typeof value==='string')return '"'+value.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\r/g,'\\r').replace(/\n/g,'\\n')+'"';
    if(typeof value!=='object')return String(value);
    var out=[],key;if(value instanceof Array){for(key=0;key<value.length;key++)out.push(json(value[key]));return '['+out.join(',')+']';}
    for(key in value)if(value.hasOwnProperty(key))out.push(json(key)+':'+json(value[key]));return '{'+out.join(',')+'}';
  }
  function near(actual,expected,label){if(Math.abs(actual-expected)>.01)throw new Error(label+': '+actual+' != '+expected);}
  function noPathStroke(group){for(var i=1;i<=group.numProperties;i++){
    var p=group.property(i);
    if(p.matchName==='ADBE Vector Graphic - Stroke'||p.matchName==='ADBE Vector Filter - Offset')throw new Error('Unexpected path stroke/offset');
    if(p.numProperties)noPathStroke(p);
  }}
  function check(layer,stroke,fillOpacity){
    if(!layer)throw new Error('Missing styled layer');
    var styles=layer.property('ADBE Layer Styles'),s=styles.property('frameFX/enabled');
    checks.push({name:layer.name,align:stroke.align,position:s.property('frameFX/style').value});
    if(!s.enabled||!s.canSetEnabled)throw new Error(layer.name+' style is inert');
    near(s.property('frameFX/size').value,stroke.width,layer.name+' size');
    near(s.property('frameFX/opacity').value,(stroke.opacity==null?1:stroke.opacity)*100,layer.name+' opacity');
    var pos={INSIDE:2,OUTSIDE:1,CENTER:3}[stroke.align];
    near(s.property('frameFX/style').value,pos,layer.name+' position');
    near(s.property('frameFX/mode2').value,1,layer.name+' blend');
    var color=s.property('frameFX/color').value;for(var i=0;i<3;i++)near(color[i],stroke.color[i],layer.name+' color');
    for(var p=1;p<=3;p++){s.property('frameFX/style').setValue(p);near(s.property('frameFX/style').value,p,'editable position');}
    s.property('frameFX/style').setValue(pos);
    if(fillOpacity!=null)near(styles.property('ADBE Blend Options Group').property('ADBE Adv Blend Group').property('ADBE Layer Fill Opacity2').value,fillOpacity*100,layer.name+' fill');
    if(layer instanceof ShapeLayer)noPathStroke(layer.property('ADBE Root Vectors Group'));
    if(layer instanceof TextLayer&&layer.property('ADBE Text Properties').property('ADBE Text Document').value.applyStroke)throw new Error('TextDocument stroke remains enabled');
  }
  try{
    app.beginSuppressDialogs();
    var input=read(F2A_ROOT+'/artifacts/stroke-styles/input.json'),model=input.model,total=0;
    $.evalFile(F2A_ROOT+'/host/figma/aeShapeBuilder.jsx');
    comp=app.project.items.addComp('F2A stroke styles direct',440,430,1,1,30);comp.openInViewer();
    var built=AEShapeBuilder.build(model,{comp:comp,gradientPresets:input.presets});AEShapeBuilder.buildText(comp,model.texts);
    for(var i=0;i<model.shapes.length;i++)if(model.shapes[i].layerStroke){var item=model.shapes[i];check(comp.layer(item.name),item.layerStroke,item.layerFillOpacity);total++;}
    for(var i=0;i<model.texts.length;i++){var item=model.texts[i];check(comp.layer(item.name),item.stroke,item.fillOpacity==null?1:item.fillOpacity);total++;}
    comp.time=.1;comp.time=0;
    imported=app.project.importFile(new ImportOptions(new File(input.project)));
    var aep=null;function find(folder){for(var i=1;i<=folder.numItems;i++){var item=folder.item(i);if(item instanceof FolderItem)find(item);else if(item instanceof CompItem&&item.name===model.name)aep=item;}}
    find(imported);if(!aep)throw new Error('Missing AEP comp');
    for(var i=0;i<model.shapes.length;i++)if(model.shapes[i].layerStroke){var item=model.shapes[i];check(aep.layer(item.name),item.layerStroke,item.layerFillOpacity);total++;}
    for(var i=0;i<model.texts.length;i++){var item=model.texts[i];check(aep.layer(item.name),item.stroke,item.fillOpacity==null?1:item.fillOpacity);total++;}
    aep.time=.1;aep.time=0;
    var exported=null;
    if(F2A_CASE==='export'){
      if(!isolated)throw new Error('Export the render fixture only in a new empty AE session');
      exported=F2A_ROOT+'/artifacts/stroke-styles/native.aep';app.project.save(new File(exported));
    }
    return json({passed:true,checked:total,nativeAE:app.version,direct:true,aep:true,renderFixture:exported});
  }catch(error){var names=[];if(comp)for(var k=1;k<=comp.numLayers;k++)names.push(comp.layer(k).name);return json({passed:false,error:String(error),line:error.line,layers:names,checks:checks,diag:AEShapeBuilder.getDiag()});}
  finally{if(imported)imported.remove();if(comp)comp.remove();if(previous&&previous.openInViewer)previous.openInViewer();app.endSuppressDialogs(false);}
})();
