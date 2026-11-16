// Run in a separate AE instance: verify file-open state without openInViewer().
var F2AMainCompOpenTest=(function(){
  var root=typeof F2A_ROOT==='string'?F2A_ROOT:new File($.fileName).parent.parent.fsName.replace(/\\/g,'/');
  var output=root+'/artifacts/aep-main-viewer/native.json',cases=[],index=0;
  var report={appVersion:app.version,cases:[],errors:[]};
  function read(path){var f=new File(path);f.encoding='UTF-8';f.open('r');var value=JSON.parse(f.read());f.close();return value;}
  function write(){var f=new File(output);f.encoding='UTF-8';f.open('w');f.write(JSON.stringify(report));f.close();}
  // -r must never replace or close the user's existing project if routed there.
  if($.getenv('F2A_MAIN_VIEWER_TEST')!=='isolated'||app.project.file||app.project.numItems){
    report.errors.push('This test requires a dedicated empty AE instance.');write();return {};
  }
  function finish(error){
    if(error)report.errors.push(String(error)+' line '+error.line);
    report.done=!report.errors.length;write();
    if(app.project)app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
    app.endSuppressDialogs(false);app.quit();
  }
  function next(){
    try{
      if(index===cases.length){finish();return;}
      report.opening=cases[index].name;write();
      app.open(new File(cases[index].project));
      app.scheduleTask('F2AMainCompOpenTest.check()',500,false);
    }catch(error){finish(error);}
  }
  function check(){
    try{
      var spec=cases[index],comp=app.project.activeItem,viewer=app.activeViewer,hasReference=false;
      if(!(comp instanceof CompItem))throw Error('Opening the file did not activate a composition: '+spec.name);
      for(var i=1;i<=comp.numLayers;i++)if(comp.layer(i).guideLayer)hasReference=true;
      if(!hasReference)throw Error('A nested precomp opened instead of the main composition: '+spec.name);
      if(!viewer||viewer.type!==ViewerType.VIEWER_COMPOSITION)throw Error('Composition panel did not open: '+spec.name);
      report.cases.push({name:spec.name,aeVersion:spec.aeVersion,activeItem:comp.name,id:comp.id,viewer:true,zoom:viewer.views[0].options.zoom});write();
      app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);index++;
      app.scheduleTask('F2AMainCompOpenTest.next()',100,false);
    }catch(error){finish(error);}
  }
  try{app.beginSuppressDialogs();cases=read(root+'/artifacts/aep-versions/cases.json');write();
    app.scheduleTask('F2AMainCompOpenTest.next()',500,false);
  }catch(error){finish(error);}
  return {next:next,check:check};
})();
