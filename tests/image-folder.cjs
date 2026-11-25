const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {once}=require('node:events');
const {harness}=require('./client-import-queue.cjs');
const {start}=require('../client/mkBridgeServer.js');
const root=path.resolve(__dirname,'..');
async function check(){
  const directory=fs.mkdtempSync(path.join(root,'artifacts/图片 位置-'));
  let selection=directory;
  const backend=harness({nativeFolder:()=>({err:0,data:selection?[selection]:[]})});
  const old=backend.window.MKFigma.getImageFolder();
  let picked=null;
  backend.window.MKFigma.selectImageFolder((error,folder)=>{picked={error,folder};});
  assert.equal(backend.folderCalls.length,1);assert.equal(backend.folderCalls[0][0],false);assert.equal(backend.folderCalls[0][1],true);
  assert.equal(backend.folderCalls[0][3],old,'Changing the folder starts in the remembered location');
  const chosen=directory.replaceAll('\\','/');
  assert.equal(backend.storage.get('f2a.imageFolder'),chosen);assert.equal(picked.folder,chosen);assert.equal(picked.error,null);
  selection=null;backend.window.MKFigma.selectImageFolder(()=>{});
  assert.equal(backend.window.MKFigma.getImageFolder(),chosen,'Cancel keeps the selected directory');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7d0AAAAASUVORK5CYII=','base64');
  backend.start('saved folder',1);backend.callbacks.onImages([{name:'小图 test',ext:'png',data:png.toString('base64')}]);
  assert.equal(backend.native.length,1);assert.equal(backend.native[0].job.imageFolder,chosen);
  const metadata=JSON.parse(fs.readFileSync(backend.native[0].job.imagesPath,'utf8'))[0];
  assert.deepEqual(fs.readFileSync(path.join(directory,metadata.file)),png);backend.finish();
  const canceled=harness({rememberFolder:false,nativeFolder:()=>({err:0,data:[]})});
  canceled.start('canceled folder',1);canceled.images('image');assert.equal(canceled.native.length,0);
  const broken=harness({rememberFolder:false,nativeFolder:()=>({err:1,data:[]})});
  broken.start('failed picker',1);broken.images('image');assert.equal(broken.native.length,0);assert.match(broken.messages.at(-1),/目录窗口打开失败/);
  fs.unlinkSync(path.join(directory,metadata.file));fs.rmdirSync(directory);assert.equal(backend.window.MKFigma.getImageFolder(),'');
  assert.equal(backend.storage.has('f2a.imageFolder'),false);

  // The AE panel no longer renders the folder row, the feedback link or their styles; the
  // setting keeps working through the Figma plugin and the HTTP routes only.
  const panelHtml=fs.readFileSync(path.join(root,'client/index.html'),'utf8');
  const panelCss=fs.readFileSync(path.join(root,'client/style.css'),'utf8');
  assert.ok(!/mk-image-folder|mk-feedback|发送反馈/.test(panelHtml),'panel markup drops the folder row and feedback link');
  assert.ok(!/\.mk-image-folder|\.mk-foot|\.mk-fb-|\.mk-lic-/.test(panelCss),'panel styles drop the removed widgets');
  const minSize=fs.readFileSync(path.join(root,'CSXS/manifest.xml'),'utf8').match(/<MinSize><Height>(\d+)<\/Height><Width>(\d+)<\/Width><\/MinSize>/);
  // The panel now stacks the export settings and the collapsible motion library, so the
  // minimum is taller than the status-only panel used to be; it still has to stay compact.
  assert.ok(minSize && Number(minSize[1])<=360 && Number(minSize[2])<=420,'the stacked panel stays compact');

  // Actual HTTP routes invoke the same host-side setting and native picker used by the panel.
  const endpoint=harness({rememberFolder:false});
  const server=start({port:0,onGetImageFolder:endpoint.callbacks.onGetImageFolder,onChooseImageFolder:endpoint.callbacks.onChooseImageFolder});
  await once(server,'listening');const port=server.address().port,base='http://127.0.0.1:'+port;
  try{
    const initial=await(await fetch(base+'/image-folder')).json();
    assert.equal(initial.directory,null);assert.equal(initial.singleLayerLabel,true);
    const selected=fetch(base+'/image-folder',{method:'POST'});
    while(!endpoint.pickers.length)await new Promise(setImmediate);
    endpoint.pickers.shift()(endpoint.assets);
    assert.equal((await(await selected).json()).directory,endpoint.assets.replaceAll('\\','/'));
    assert.equal((await(await fetch(base+'/image-folder')).json()).directory,endpoint.assets.replaceAll('\\','/'));
    const cancel=fetch(base+'/image-folder',{method:'POST'});
    while(!endpoint.pickers.length)await new Promise(setImmediate);
    endpoint.pickers.shift()('');assert.equal((await(await cancel).json()).directory,null);
    assert.equal((await(await fetch(base+'/image-folder')).json()).directory,endpoint.assets.replaceAll('\\','/'));
    const failed=fetch(base+'/image-folder',{method:'POST'});
    while(!endpoint.pickers.length)await new Promise(setImmediate);
    endpoint.pickers.shift()('ERROR: 无法打开目录窗口');
    const rejected=await failed;assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/无法打开目录窗口/);
    endpoint.start('active import',0);
    const busy=await fetch(base+'/image-folder',{method:'POST'});assert.equal(busy.status,400);assert.match((await busy.json()).error,/正在导入/);endpoint.finish();
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

  const html=fs.readFileSync(path.join(root,'figma-plugin/ui.html'),'utf8');
  function plugin({directory=null,cancel=false,error=false,singleLayerLabel=true}={}){
    const elements={},requests=[],posts=[];let socket;
    for(const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g))elements[m[1]]={disabled:/\bdisabled\b/.test(m[0]),checked:/\bchecked\b/.test(m[0])};
  elements['raster-scale'].value='1';elements['native-image-masks'].value='separate';
    const window={},context=vm.createContext({window,document:{getElementById:id=>elements[id]},setTimeout(){},
      WebSocket:function(url){if(url.endsWith('/plugin'))return;socket=this;this.readyState=1;this.send=()=>{};},
      fetch:async(url,options)=>{
        requests.push(options.method);assert.equal(url,'http://127.0.0.1:7365/image-folder');
        if(error)return{ok:false,json:async()=>({error:'目录窗口打开失败'})};
        if(options.method==='POST')directory=cancel?null:'D:/素材 文件夹';
        return{ok:true,json:async()=>({directory,singleLayerLabel})};
      },parent:{postMessage(m){posts.push(m.pluginMessage);}}});
    vm.runInContext(html.match(/<script>([\s\S]*)<\/script>/)[1],context);
    assert.deepEqual(posts.map(m=>m.type),['load-settings']);posts.length=0;
    window.onmessage({data:{pluginMessage:{type:'selection',count:1}}});socket.onopen();
    return{elements,requests,posts,context};
  }
  const flush=()=>new Promise(setImmediate);
  const p=plugin();await flush();assert.equal(p.elements['image-folder-path'].textContent,'未选择');
  p.elements['ship'].onclick();assert.equal(p.elements.ship.disabled,true);await flush();
  assert.deepEqual(p.requests,['GET','GET','POST']);assert.equal(p.posts[0].type,'ship-selection');
  assert.equal(p.elements['image-folder-path'].textContent,'D:/素材 文件夹');
  const remembered=plugin({directory:'D:/已选位置'});await flush();remembered.elements.ship.onclick();await flush();
  assert.deepEqual(remembered.requests,['GET','GET']);assert.equal(remembered.posts[0].type,'ship-selection');
  const changed=plugin({directory:'D:/旧位置'});await flush();changed.elements['image-folder-choose'].onclick();await flush();
  assert.equal(changed.elements['image-folder-path'].textContent,'D:/素材 文件夹');assert.equal(changed.posts.length,0);
  const abort=plugin({cancel:true});await flush();abort.elements.ship.onclick();await flush();
  assert.equal(abort.posts.length,0);assert.match(abort.elements.msg.textContent,/已取消/);assert.equal(abort.elements.ship.disabled,false);
  const failed=plugin({error:true});await flush();failed.elements.ship.onclick();await flush();
  assert.equal(failed.posts.length,0);assert.match(failed.elements.msg.textContent,/目录窗口打开失败/);assert.equal(failed.elements.ship.disabled,false);
  const stalePanel=plugin({directory:'D:/已选位置',singleLayerLabel:false});await flush();stalePanel.elements.ship.onclick();await flush();
  assert.equal(stalePanel.posts.length,0);assert.match(stalePanel.elements.msg.textContent,/单图层嵌套预合成标黄需要更新/);assert.equal(stalePanel.elements.ship.disabled,false);
  stalePanel.elements['precomp-layers'].checked=false;stalePanel.elements.ship.onclick();await flush();
  assert.equal(stalePanel.posts[0].type,'ship-selection');
  console.log('PASS: native folder picker with no panel widget, remembered/missing directories, real image writes, HTTP routes, Figma import preflight and the trimmed panel');
}
check().catch(error=>{console.error(error);process.exitCode=1;});
