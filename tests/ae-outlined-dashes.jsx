(function(){
  var root='D:/Tools/F2A',folder=root+'/artifacts/outlined-dashes',owned=!app.project.file&&app.project.numItems===0,checks=0,report;
  function read(file){var f=new File(file);f.encoding='UTF-8';f.open('r');var value=eval('('+f.read()+')');f.close();return value;}
  function json(v){if(v===null)return 'null';if(typeof v==='string')return '"'+v.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\r/g,'\\r').replace(/\n/g,'\\n')+'"';if(typeof v!=='object')return String(v);var out=[],k;if(v instanceof Array){for(k=0;k<v.length;k++)out.push(json(v[k]));return '['+out.join(',')+']';}for(k in v)if(v.hasOwnProperty(k))out.push(json(k)+':'+json(v[k]));return '{'+out.join(',')+'}';}
  function near(a,b,label){if(Math.abs(a-b)>.001)throw new Error(label+': '+a+' != '+b);}
  function find(folder){var layers={};function walk(item){if(item instanceof FolderItem){for(var j=1;j<=item.numItems;j++)walk(item.item(j));}else if(item instanceof CompItem){for(var j=1;j<=item.numLayers;j++)layers[item.layer(j).name]=item.layer(j);}}walk(folder);return layers;}
  function paints(group){var counts={paths:0,strokes:0,fills:0,gradients:0};function walk(g){for(var j=1;j<=g.numProperties;j++){var p=g.property(j);if(p.matchName==='ADBE Vector Shape - Group')counts.paths++;if(p.matchName==='ADBE Vector Graphic - Stroke')counts.strokes++;if(p.matchName==='ADBE Vector Graphic - Fill')counts.fills++;if(p.matchName==='ADBE Vector Graphic - G-Fill')counts.gradients++;if(p.numProperties)walk(p);}}walk(group);return counts;}
  function check(layers,model,vector){
    for(var i=0;i<model.shapes.length;i++){
      var item=model.shapes[i];if(item.maskSource||item.name==='Solid style')continue;
      var layer=layers[item.name];if(!(layer instanceof ShapeLayer))throw new Error(item.name+' is not an editable shape');
      var rect=layer.sourceRectAtTime(0,false);if(rect.width>model.width||rect.height>model.height)throw new Error(item.name+' retained page-space contour coordinates');
      var count=paints(layer.property('ADBE Root Vectors Group'));if(count.strokes)throw new Error(item.name+' retained path stroke');
      if(count.paths<item.subpaths.length)throw new Error(item.name+' lost contour paths');
      near(layer.property('ADBE Transform Group').property('ADBE Opacity').value,item.opacity*100,item.name+' opacity');
      if(item.maskId&&!layer.hasTrackMatte)throw new Error(item.name+' lost track matte');checks++;
    }
    var filled=layers['Rectangle 7'].property('ADBE Root Vectors Group');
    var top=filled.property(1).property('ADBE Vectors Group');if(paints(top).paths!==10)throw new Error('Dash contours are not above original fill');
    near(top.property('ADBE Vector Graphic - Fill').property('ADBE Vector Fill Opacity').value,80,'dash paint alpha');
    if(paints(layers['Gradient dash'].property('ADBE Root Vectors Group')).gradients!==1)throw new Error('Outlined gradient missing');
    var gradient=layers['Gradient dash'].property('ADBE Root Vectors Group').property(1).property('ADBE Vectors Group').property('ADBE Vector Graphic - G-Fill');
    near(gradient.property('ADBE Vector Fill Rule').value,2,'outlined gradient winding rule');
    var thin=layers['Thin inside'].property('ADBE Root Vectors Group').property(1).property('ADBE Vectors Group'),paths=[];
    for(var j=1;j<=thin.numProperties;j++)if(thin.property(j).matchName==='ADBE Vector Shape - Group')paths.push(thin.property(j).property('ADBE Vector Shape').value.vertices);
    if(paths.length!==2)throw new Error('Thin border lost inner/outer paths');near(Math.abs(paths[0][0][0]-paths[1][0][0]),.6666666865348816,'subpixel contour width');
    if(!layers['Solid style'].property('ADBE Layer Styles').property('frameFX/enabled').enabled)throw new Error('Ordinary stroke lost Layer Style');
    if(vector){if(!(layers['Normal text'] instanceof ShapeLayer)||!(layers['Rich outline'] instanceof ShapeLayer))throw new Error('Text was not converted to glyph shapes');}
    else if(!(layers['Normal text'] instanceof TextLayer))throw new Error('Default editable text changed');
  }
  app.beginSuppressDialogs();
  try{
    if(!owned)throw new Error('Requires an isolated empty AE session');
    var input=read(folder+'/input.json'),model=input.model;
    $.evalFile(root+'/host/figma/aeShapeBuilder.jsx');
    var comp=app.project.items.addComp('F2A outlined direct',model.width,model.height,1,1,30);comp.openInViewer();
    AEShapeBuilder.build(model,{comp:comp,gradientPresets:input.presets});AEShapeBuilder.buildText(comp,model.texts);
    var direct={};for(var i=1;i<=comp.numLayers;i++)direct[comp.layer(i).name]=comp.layer(i);check(direct,model,false);
    var aep=app.project.importFile(new ImportOptions(new File(input.project)));check(find(aep),model,false);
    var vector=app.project.importFile(new ImportOptions(new File(input.vectorProject)));check(find(vector),input.vectorModel,true);
    for(var i=1;i<=app.project.numItems;i++){var item=app.project.item(i);if(item instanceof CompItem&&item.name.indexOf('细描边')!==-1)throw new Error('Unnecessary subpixel scaling precomp');}
    app.project.save(new File(folder+'/native.aep'));
    report={passed:true,checks:checks,nativeAE:app.version,direct:true,aep:true,vectorText:true,project:input.project,vectorProject:input.vectorProject};
  }catch(error){report={passed:false,error:String(error),line:error.line,checks:checks,diag:typeof AEShapeBuilder==='undefined'?[]:AEShapeBuilder.getDiag()};}
  var out=new File(folder+'/ae-report.json');out.encoding='UTF-8';out.open('w');out.write(json(report));out.close();
  app.endSuppressDialogs(false);
  if(owned){app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);app.quit();}
})();
