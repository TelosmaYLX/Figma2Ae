const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {fixture} = require('./direct-aep.cjs');

function ui(packet, behavior='success') {
  const html=fs.readFileSync(require('node:path').join(__dirname,'../figma-plugin/ui.html'),'utf8'),elements={},posts=[],requests=[];
  for(const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g))elements[m[1]]={checked:/\bchecked\b/.test(m[0]),disabled:/\bdisabled\b/.test(m[0])};
  let finish, clock=0, healthCalls=0;
  const done=new Promise(r=>{finish=r;});
  const launches=[];
  const window={};
  const context=vm.createContext({window,
    document:{getElementById:id=>elements[id],createElement(){throw new Error('Folder export must not start a browser download');}},
    Date:{now:()=>clock},
    setTimeout(callback,delay){if(delay===500)setImmediate(()=>{clock+=delay;callback();});},
    WebSocket:function(){this.readyState=0;this.send=()=>{throw new Error('Direct export called the AE bridge');};},
    fetch:async(url,options)=>{
      requests.push({url,options});
      if(url.endsWith('/health')){
        healthCalls++;
        if(['offline','launch-error','bridge-offline','bridge-old','missing-component'].includes(behavior)||(behavior==='cold-start'&&healthCalls<4))throw new Error('Offline');
        return {ok:true,json:async()=>({service:'f2a-aep',version:behavior==='old-service'?1:2})};
      }
      if(url.endsWith('/aep/start')){
        assert.equal(url,'http://127.0.0.1:7867/aep/start');assert.equal(options.method,'POST');
        assert.equal(posts.filter(m=>m.type==='ship-selection').length,0);
        launches.push(url);
        if(behavior==='bridge-offline')throw new TypeError('Failed to fetch');
        if(behavior==='bridge-old')return{ok:true,json:async()=>({ok:false,error:'no svg in message'})};
        if(behavior==='launch-error')return{ok:false,json:async()=>({ok:false,error:'AEP 组件启动失败：系统拒绝启动'})};
        if(behavior==='missing-component')return{ok:false,json:async()=>({ok:false,error:'未找到 AEP 导出组件，请先安装 Windows x64 组件。'})};
        return{ok:true,json:async()=>({ok:true})};
      }
      if(url.endsWith('/select-directory')){
        assert.equal(posts.filter(m=>m.type==='ship-selection').length,0,'Choose a location before collecting Figma content');
        assert.equal(elements['export-aep'].disabled,true);
        if(behavior==='picker-error')return {ok:false,json:async()=>({error:'Picker failure'})};
        return {ok:true,json:async()=>({destination:behavior==='cancel'?null:'selected-folder'})};
      }
      assert.equal(url,'http://127.0.0.1:7868/export');
      assert.equal(elements['export-aep'].disabled,true,'Button stays locked while the server writes');
      if(behavior==='server-error')return {ok:false,json:async()=>({error:'Test failure'})};
      return {ok:true,json:async()=>({directory:'D:\\导出 位置\\Direct AEP smoke',warnings:behavior==='warnings'?[{},{}]:[]})};
    },
    parent:{postMessage({pluginMessage:message}){
      posts.push(message);
      if(message.type!=='ship-selection')return;
      assert.equal(message.useNodes,true);
      emit({...packet,type:'ship',imageCount:packet.images.length});
      if(behavior==='export-error'){emit({type:'error',message:'Figma error'});finish();return;}
      for(let i=0;i<packet.images.length;i++){
        if(behavior==='missing-image'&&i===0)continue;
        const {data,...meta}=packet.images[i],split=Math.ceil(data.length/2);
        if(i===0&&behavior.startsWith('shadow'))meta.shadowBase={data:'clean PNG',dx:0,dy:0,w:64,h:64};
        emit({type:'image-chunk',meta,index:i,total:packet.images.length,seq:0,parts:2,dataPart:data.slice(0,split)});
        emit({type:'image-chunk',index:i,total:packet.images.length,seq:1,parts:2,dataPart:data.slice(split)});
      }
      emit({type:'images-done'});emit({type:'export-state',busy:false});finish();
    }}
  });
  function emit(message){window.onmessage({data:{pluginMessage:message}});}
  vm.runInContext(html.match(/<script>([\s\S]*)<\/script>/)[1],context);
  if(behavior.startsWith('shadow'))context.renderAepShadow=async()=>{
    assert.equal(requests.some(r=>r.url.endsWith('/export')),false,'Extract shadows before writing the project');
    if(behavior==='shadow-error')throw new Error('PNG decode failed');
    return 'extracted shadow PNG';
  };
  emit({type:'selection',count:1});
  assert.equal(elements.ship.disabled,true,'AE is disconnected');assert.equal(elements['export-aep'].disabled,false);
  return {elements,posts,requests,context,done,launches};
}
const flush=()=>new Promise(r=>setImmediate(r));
(async()=>{
  const packet=await fixture();
  for(const behavior of ['success','cold-start','shadow','shadow-error','warnings','offline','launch-error','bridge-offline','bridge-old','missing-component','old-service','cancel','picker-error','server-error','export-error','missing-image']){
    const h=ui(packet,behavior);h.elements['export-aep'].onclick();
    for(let i=0;i<200&&h.context.aepBusy;i++)await flush();
    assert.equal(h.context.aepBusy,false,behavior+' must release the export lock');
    assert.equal(h.elements['export-aep'].disabled,false);
    if(['success','cold-start','shadow','warnings'].includes(behavior)){
      const request=JSON.parse(h.requests.find(r=>r.url.endsWith('/export')).options.body);
      assert.equal(request.destination,'selected-folder');
      const body=request.packet;
      assert.equal(body.images.length,packet.images.length);
      assert.equal(body.images[0].data,behavior==='shadow'?'extracted shadow PNG':packet.images[0].data);
      if(behavior==='shadow')assert.equal(body.images[0].shadowBase,null);
      assert.deepEqual(body.frame,packet.frame);assert.equal(body.texts.length,1);
      if(behavior==='warnings')assert.match(h.elements.msg.textContent,/AEP 导出失败.*未导出的属性/);
      else assert.match(h.elements.msg.textContent,/已导出到 D:\\导出 位置/);
      assert.equal(h.elements.msg.textContent.includes('report.json'),false);
    }
    if(['cancel','picker-error','offline','launch-error','bridge-offline','bridge-old','missing-component','old-service'].includes(behavior)){
      assert.equal(h.posts.filter(m=>m.type==='ship-selection').length,0);
      assert.equal(h.requests.some(r=>r.url.endsWith('/export')),false);
    }
    if(behavior==='cancel')assert.equal(h.elements.msg.textContent,'已取消导出。');
    if(behavior==='old-service')assert.match(h.elements.msg.textContent,/请重启/);
    if(['cold-start','offline','launch-error','bridge-offline','bridge-old','missing-component'].includes(behavior))assert.deepEqual(h.launches,['http://127.0.0.1:7867/aep/start']);
    else assert.equal(h.launches.length,0,'A running service never needs to launch again');
    if(behavior==='offline')assert.match(h.elements.msg.textContent,/服务启动超时/);
    if(behavior==='launch-error'){
      assert.match(h.elements.msg.textContent,/AEP 组件启动失败.*系统拒绝启动/);
      assert.equal(h.elements.msg.textContent.includes('重新安装'),false);
    }
    if(behavior==='bridge-offline')assert.match(h.elements.msg.textContent,/请先打开 AE 的 F2A 面板/);
    if(behavior==='bridge-old')assert.match(h.elements.msg.textContent,/请更新并重新打开 AE/);
    if(behavior==='missing-component')assert.match(h.elements.msg.textContent,/未找到 AEP 导出组件/);
    if(behavior==='missing-image')assert.equal(h.requests.length,2,'Do not export an incomplete image batch');
    if(behavior==='shadow-error'){
      assert.equal(h.requests.some(r=>r.url.endsWith('/export')),false);assert.match(h.elements.msg.textContent,/投影.*PNG decode failed/);
    }
  }
  const h=ui(packet);
  function composite(fg,bg){const a=fg[3]/255,b=bg[3]/255,alpha=a+b*(1-a);return [0,1,2].map(i=>alpha?Math.round((fg[i]*a+bg[i]*b*(1-a))/alpha):0).concat(Math.round(alpha*255));}
  for(const clean of [[0,0,0,0],[90,180,225,128],[255,255,255,255]])for(const shadow of [[0,0,0,128],[30,70,120,80]]){
    const full=composite(clean,shadow),recovered=Array.from(h.context.extractAepShadow(full,clean));
    assert.ok(composite(clean,recovered).every((v,i)=>Math.abs(v-full[i])<=1));
  }
  console.log('PASS: click → one HTTP launch through AE → wait until ready → folder export; reuse, offline/old panel, missing component, startup errors and timeout');
})().catch(e=>{console.error(e);process.exitCode=1;});
