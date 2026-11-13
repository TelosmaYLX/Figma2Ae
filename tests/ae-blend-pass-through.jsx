(function () {
  if(app.project.file||app.project.numItems)throw Error('Run in an empty AE session');
  function read(path) {var f=new File(path);f.encoding='UTF-8';f.open('r');var value=eval('('+f.read()+')');f.close();return value;}
  var fixture=read(F2A_BLEND_FIXTURE),model=fixture.model,results=[];
  $.evalFile(F2A_ROOT+'/host/figma/aeShapeBuilder.jsx');
  var nativeComp=app.project.items.addComp('Blend native',model.width,model.height,1,10,30);
  AEShapeBuilder.build({shapes:model.shapes},{comp:nativeComp});
  AEShapeBuilder.organize(nativeComp,model.containers);
  var imported=app.project.importFile(new ImportOptions(new File(fixture.project))),aepComp=null;
  function locate(folder){for(var n=1;n<=folder.numItems;n++){var item=folder.item(n);if(item instanceof FolderItem)locate(item);else if(item instanceof CompItem&&item.name===model.name&&item.parentFolder.name===model.name)aepComp=item;}}
  locate(imported);if(!aepComp)throw Error('Missing AEP composition');
  function inspect(comp,kind){
    var count=0;
    function walk(parent){for(var n=1;n<=parent.numLayers;n++){var layer=parent.layer(n);if(!(layer.source instanceof CompItem))continue;
      var definition=null;for(var c=0;c<model.containers.length;c++)if(model.containers[c].name===layer.name)definition=model.containers[c];
      if(!definition)throw Error('Unexpected precomp '+layer.name);
      if(layer.collapseTransformation!==definition.collapseForBlends)throw Error(kind+' incorrect collapse: '+layer.name);
      results.push({kind:kind,name:layer.name,collapse:layer.collapseTransformation});count++;walk(layer.source);
    }}
    walk(comp);if(count!==model.containers.length)throw Error(kind+' incorrect container count');
  }
  inspect(nativeComp,'native');inspect(aepComp,'aep');
  app.project.save(new File(fixture.directory+'/native-and-aep.aep'));
  return {passed:true,layers:results};
})();
