const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {node,group,harness}=require('./export-options.cjs');
const blur={type:'BACKGROUND_BLUR',visible:true,radius:8};
const geometry=[{data:'M0 0H100V60H0Z',windingRule:'NONZERO'}];
const rect=(name,extra={})=>node('RECTANGLE',name,{fillGeometry:geometry,fills:[{type:'SOLID',color:{r:1,g:1,b:1}}],...extra});
function panel(main){
  const html=fs.readFileSync(path.join(__dirname,'../figma-plugin/ui.html'),'utf8'),elements={},posts=[],pending=[];
  for(const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g))elements[m[1]]={hidden:/\bhidden\b/.test(m[0]),checked:/\bchecked\b/.test(m[0]),disabled:/\bdisabled\b/.test(m[0])};
  elements['raster-scale'].value='1';
  let socket;
  const window={},context=vm.createContext({window,document:{getElementById:id=>elements[id]},setTimeout(){},
    WebSocket:function(url){if(url.endsWith('/plugin'))return;socket=this;this.readyState=1;this.send=message=>posts.push(JSON.parse(message));},
    fetch:async()=>({ok:true,json:async()=>({ok:true,directory:null})}),
    parent:{postMessage({pluginMessage}){posts.push(pluginMessage);pending.push(main.figma.ui.onmessage(pluginMessage));}}});
  const emit=message=>window.onmessage({data:{pluginMessage:message}});
  vm.runInContext(html.match(/<script>([\s\S]*)<\/script>/)[1],context);
  main.figma.ui.postMessage=emit;
  return{elements,posts,pending,context,emit,get socket(){return socket;}};
}
async function failure(main,rasterGroups=true){
  await main.context.exportSelectionSVG(true,true,true,false,rasterGroups,false,{});
  const error=main.messages.find(m=>m.type==='error');assert.ok(error);return error;
}
async function check(){
  const first=rect('底框'),bad=rect('底框',{effects:[blur]});
  const root=node('FRAME','页面',{children:[group('卡片A',[first]),group('卡片B',[bad])]});
  const h=harness(root),page=h.figma.currentPage;page.id='page-1';page.type='PAGE';root.parent=page;
  const error=await failure(h,false);assert.match(error.message,/底框.*背景模糊.*开启“模糊、阴影和特殊效果”/);assert.equal(error.nodeId,bad.id);
  assert.notEqual(error.nodeId,first.id);assert.equal(h.context._exporting,false);assert.equal(h.figma.currentPage.selection[0],root);
  assert.equal(Object.keys(h.context._exportSourceIds).length,0,'Copy mappings are released after cleanup');
  const targets=new Map([[first.id,first],[bad.id,bad]]),zoom=[],changes=[];
  h.figma.getNodeByIdAsync=async id=>targets.get(id)||null;
  h.figma.viewport={scrollAndZoomIntoView(nodes){zoom.push(nodes[0]);}};
  h.figma.setCurrentPageAsync=async target=>{changes.push(target);h.figma.currentPage=target;};
  const ui=panel(h);assert.equal(ui.elements['locate-layer'].hidden,true);
  ui.emit(error);assert.equal(ui.elements['locate-layer'].hidden,false);assert.equal(ui.elements['locate-layer'].disabled,false);
  ui.elements['locate-layer'].onclick();assert.equal(ui.elements['locate-layer'].disabled,true);await ui.pending.at(-1);
  assert.equal(ui.posts.at(-1).nodeId,bad.id);assert.equal(page.selection[0],bad);assert.equal(zoom.at(-1),bad);
  assert.equal(ui.elements.msg.textContent,error.message,'Selection keeps the original error readable');assert.equal(ui.elements['locate-layer'].disabled,false);
  h.figma.currentPage={id:'page-2',type:'PAGE',selection:[]};
  ui.elements['locate-layer'].onclick();await ui.pending.at(-1);assert.equal(changes.at(-1),page);assert.equal(h.figma.currentPage,page);
  ui.socket.onopen();ui.context.bridgePending=true;ui.emit(error);
  ui.socket.onmessage({data:JSON.stringify({ok:false,error:error.message})});
  ui.socket.onmessage({data:JSON.stringify({ok:true,buffered:1})});
  assert.equal(ui.elements['locate-layer'].hidden,false);assert.equal(ui.elements.msg.textContent,error.message,'Abort acknowledgement must not erase the locate target');
  targets.delete(bad.id);ui.elements['locate-layer'].onclick();await ui.pending.at(-1);
  assert.match(ui.elements.msg.textContent,/图层已删除或不存在/);assert.equal(ui.elements['locate-layer'].hidden,true);
  ui.emit({type:'error',message:'连接失败'});assert.equal(ui.elements['locate-layer'].hidden,true);
  ui.emit(error);ui.context.say('正在导出…');assert.equal(ui.elements['locate-layer'].hidden,true,'A new operation clears the stale target');

  const duplicate=rect('底框',{effects:[blur]}),left=group('同名分组',[rect('底框')]),right=group('同名分组',[duplicate]);
  const multi=harness(node('FRAME','multi',{children:[left,right]}));multi.figma.currentPage.selection=[left,right];
  assert.equal((await failure(multi,false)).nodeId,duplicate.id,'Multi-selection maps to the correct original subtree');
  const missing=node('TEXT','文字',{hasMissingFont:true}),fonts=harness(group('fonts',[missing]));
  assert.equal((await failure(fonts)).nodeId,missing.id);
  const raster=group('*底框',[rect('art')]),png=harness(group('PNG scene',[raster]));
  raster.exportAsync=async()=>{throw new Error('PNG failed');};
  assert.equal((await failure(png)).nodeId,raster.id,'PNG failures retain the original id after temporary nodes are removed');
  const photo=rect('照片',{fills:[{type:'IMAGE',imageHash:'hash',scaleMode:'FIT'}]}),images=harness(group('images',[photo]));
  images.figma.getImageByHash=()=>({getBytesAsync:async()=>{throw new Error('Image bytes failed');}});
  assert.equal((await failure(images)).nodeId,photo.id);
  assert.equal(h.calls.undo,0,'Locating a layer must not add document changes');
  console.log('PASS: original node IDs after copy cleanup, duplicate names, multi-selection, font/PNG/image errors, selection and zoom, cross-page navigation, deleted layers and UI error preservation');
}
check().catch(error=>{console.error(error);process.exitCode=1;});
