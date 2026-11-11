const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {fixture} = require('./direct-aep.cjs');

function ui(packet, behavior='success') {
  const html=fs.readFileSync(require('node:path').join(__dirname,'../figma-plugin/ui.html'),'utf8'),elements={},posts=[],requests=[],downloads=[];
  for(const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g))elements[m[1]]={checked:/\bchecked\b/.test(m[0]),disabled:/\bdisabled\b/.test(m[0])};
  let finish;
  const done=new Promise(r=>{finish=r;});
  const window={};
  const context=vm.createContext({window,
    document:{getElementById:id=>elements[id],body:{appendChild(){}},createElement(){return {click(){downloads.push(this.download);},remove(){}};}},
    URL:{createObjectURL(){return 'blob:test';},revokeObjectURL(){}},setTimeout(){},
    WebSocket:function(){this.readyState=0;this.send=()=>{throw new Error('Direct export called the AE bridge');};},
    fetch:async(url,options)=>{
      requests.push({url,options});
      if(url.endsWith('/health')){if(behavior==='offline')throw new Error('Offline');return {json:async()=>({service:'f2a-aep'})};}
      assert.equal(url,'http://127.0.0.1:7868/export');
      assert.equal(elements['export-aep'].disabled,true,'Button stays locked while the server writes');
      if(behavior==='server-error')return {ok:false,json:async()=>({error:'Test failure'})};
      return {ok:true,headers:{get:()=>behavior==='warnings'?'2':'0'},blob:async()=>({})};
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
  return {elements,posts,requests,downloads,context,done};
}
const flush=()=>new Promise(r=>setImmediate(r));
(async()=>{
  const packet=await fixture();
  for(const behavior of ['success','warnings','offline','server-error','export-error','missing-image']){
    const h=ui(packet,behavior);h.elements['export-aep'].onclick();
    for(let i=0;i<10&&h.context.aepBusy;i++)await flush();
    assert.equal(h.context.aepBusy,false,behavior+' must release the export lock');
    assert.equal(h.elements['export-aep'].disabled,false);
    if(['success','warnings'].includes(behavior)){
      assert.equal(h.downloads.length,1);assert.ok(h.downloads[0].endsWith('.zip'));
      const body=JSON.parse(h.requests.find(r=>r.url.endsWith('/export')).options.body);
      assert.equal(body.images.length,packet.images.length);assert.equal(body.images[0].data,packet.images[0].data);
      assert.deepEqual(body.frame,packet.frame);assert.equal(body.texts.length,1);
    }else assert.equal(h.downloads.length,0);
    if(behavior==='missing-image')assert.equal(h.requests.length,1,'Do not export an incomplete image batch');
  }
  console.log('PASS: direct-export UI works without AE; chunks, ZIP download, warnings, offline, exporter and server errors');
})().catch(e=>{console.error(e);process.exitCode=1;});
