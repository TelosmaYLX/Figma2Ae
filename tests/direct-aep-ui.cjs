const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {fixture} = require('./direct-aep.cjs');

function ui(packet, behavior='success') {
  const html=fs.readFileSync(require('node:path').join(__dirname,'../figma-plugin/ui.html'),'utf8'),elements={},posts=[],requests=[];
  for(const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g))elements[m[1]]={checked:/\bchecked\b/.test(m[0]),disabled:/\bdisabled\b/.test(m[0])};
  let finish;
  const done=new Promise(r=>{finish=r;});
  const window={};
  const context=vm.createContext({window,
    document:{getElementById:id=>elements[id],createElement(){throw new Error('Folder export must not start a browser download');}},
    setTimeout(){},
    WebSocket:function(){this.readyState=0;this.send=()=>{throw new Error('Direct export called the AE bridge');};},
    fetch:async(url,options)=>{
      requests.push({url,options});
      if(url.endsWith('/health')){if(behavior==='offline')throw new Error('Offline');return {json:async()=>({service:'f2a-aep',version:behavior==='old-service'?1:2})};}
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
        emit({type:'image-chunk',meta,index:i,total:packet.images.length,seq:0,parts:2,dataPart:data.slice(0,split)});
        emit({type:'image-chunk',index:i,total:packet.images.length,seq:1,parts:2,dataPart:data.slice(split)});
      }
      emit({type:'images-done'});emit({type:'export-state',busy:false});finish();
    }}
  });
  function emit(message){window.onmessage({data:{pluginMessage:message}});}
  vm.runInContext(html.match(/<script>([\s\S]*)<\/script>/)[1],context);
  emit({type:'selection',count:1});
  assert.equal(elements.ship.disabled,true,'AE is disconnected');assert.equal(elements['export-aep'].disabled,false);
  return {elements,posts,requests,context,done};
}
const flush=()=>new Promise(r=>setImmediate(r));
(async()=>{
  const packet=await fixture();
  for(const behavior of ['success','warnings','offline','old-service','cancel','picker-error','server-error','export-error','missing-image']){
    const h=ui(packet,behavior);h.elements['export-aep'].onclick();
    for(let i=0;i<10&&h.context.aepBusy;i++)await flush();
    assert.equal(h.context.aepBusy,false,behavior+' must release the export lock');
    assert.equal(h.elements['export-aep'].disabled,false);
    if(['success','warnings'].includes(behavior)){
      const request=JSON.parse(h.requests.find(r=>r.url.endsWith('/export')).options.body);
      assert.equal(request.destination,'selected-folder');
      const body=request.packet;
      assert.equal(body.images.length,packet.images.length);assert.equal(body.images[0].data,packet.images[0].data);
      assert.deepEqual(body.frame,packet.frame);assert.equal(body.texts.length,1);
      assert.match(h.elements.msg.textContent,/已导出到 D:\\导出 位置/);
      assert.equal(h.elements.msg.textContent.includes('report.json'),behavior==='warnings');
    }
    if(['cancel','picker-error','offline','old-service'].includes(behavior)){
      assert.equal(h.posts.filter(m=>m.type==='ship-selection').length,0);
      assert.equal(h.requests.some(r=>r.url.endsWith('/export')),false);
    }
    if(behavior==='cancel')assert.equal(h.elements.msg.textContent,'已取消导出。');
    if(behavior==='old-service')assert.match(h.elements.msg.textContent,/请重启/);
    if(behavior==='missing-image')assert.equal(h.requests.length,2,'Do not export an incomplete image batch');
  }
  console.log('PASS: offline-AE UI → native folder selection → complete packet; cancel, old service, warnings and errors, no download');
})().catch(e=>{console.error(e);process.exitCode=1;});
