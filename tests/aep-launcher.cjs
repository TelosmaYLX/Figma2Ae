const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {once}=require('node:events');
const {start}=require('../client/mkBridgeServer.js');
const source=fs.readFileSync(path.join(__dirname,'../client/aepLauncher.js'),'utf8');
function launcher({platform='win32',failure,stderr=''}={}){
  const module={exports:{}},calls=[];
  vm.runInNewContext(source,{module,process:{platform,env:{SystemRoot:'C:/Windows'}},require(name){
    if(name==='child_process')return{execFile(file,args,options,callback){calls.push({file,args,options});callback(failure,'',stderr);}};
    return require(name);
  }});
  return{calls,start:module.exports.start};
}
async function check(){
  const success=launcher();let result;
  success.start(error=>result=error);assert.equal(result,null);assert.equal(success.calls.length,1);
  const command=success.calls[0];assert.equal(command.options.windowsHide,true);assert.equal(command.options.timeout,10000);
  assert.match(command.file,/WindowsPowerShell/);assert.match(command.args.at(-1),/Start-Process -FilePath 'f2a-aep:\/\/start' -WindowStyle Hidden/);
  assert.match(command.args.at(-1),/HKEY_CURRENT_USER/);
  const missing=launcher({failure:new Error('exit 2'),stderr:'F2A_COMPONENT_MISSING'});
  missing.start(error=>result=error);assert.match(result.message,/未找到 AEP/);
  const rejected=launcher({failure:new Error('exit 1'),stderr:'Access denied\r\nPS stack'});
  rejected.start(error=>result=error);assert.equal(result.message,'AEP 组件启动失败：Access denied');
  const other=launcher({platform:'darwin'});other.start(error=>result=error);assert.match(result.message,/Windows x64/);assert.equal(other.calls.length,0);
  // Use the actual CEP client callback, HTTP server and launcher source together.
  const {harness}=require('./client-import-queue.cjs'),panel=harness();
  const server=start({port:0,onStartAep:panel.callbacks.onStartAep});await once(server,'listening');
  try{
    // GET never starts a component; the only accepted action is a fixed POST endpoint.
    await fetch('http://127.0.0.1:'+server.address().port+'/aep/start');assert.equal(panel.launchCalls.length,0);
    const preflight=await fetch('http://127.0.0.1:'+server.address().port+'/aep/start',{method:'OPTIONS'});
    assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-private-network'),'true');assert.equal(panel.launchCalls.length,0);
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/aep/start',{method:'POST',body:JSON.stringify({uri:'https://not-used.example'})});
    assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).ok,true);
    assert.equal(panel.launchCalls.length,1);assert.match(panel.launchCalls[0].args.at(-1),/f2a-aep:\/\/start/);
    panel.launchError=new Error('Component denied');
    const failed=await fetch('http://127.0.0.1:'+server.address().port+'/aep/start',{method:'POST'});
    assert.equal(failed.status,400);assert.match((await failed.json()).error,/Component denied/);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  const bundle=fs.mkdtempSync(path.join(__dirname,'../artifacts/aep-panel-package-'));
  await require('../scripts/package-aep-service.cjs').copyCepExtension(bundle);
  assert.equal(fs.readFileSync(path.join(bundle,'cep-extension/client/aepLauncher.js'),'utf8'),source);
  for(const file of ['client/index.html','client/mkBridgeServer.js','host/figma/figmaRunner.jsx','CSXS/manifest.xml','.debug'])assert.ok(fs.existsSync(path.join(bundle,'cep-extension',file)),file+' must be distributed with the launcher');
  console.log('PASS: native fixed URI launch, hidden process, per-user registry, missing component, host errors and real AE bridge HTTP route');
}
check().catch(error=>{console.error(error);process.exitCode=1;});
