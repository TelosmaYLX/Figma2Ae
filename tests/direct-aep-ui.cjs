const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {fixture} = require('./direct-aep.cjs');

function ui(packet, behavior='success') {
  const html=fs.readFileSync(require('node:path').join(__dirname,'../figma-plugin/ui.html'),'utf8'),elements={},posts=[],requests=[];
  for(const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g))elements[m[1]]={checked:/\bchecked\b/.test(m[0]),disabled:/\bdisabled\b/.test(m[0]),hidden:/\bhidden\b/.test(m[0])};
  assert.match(html,/<option value="1" selected>1×<\/option>/);
  assert.match(html,/<option value="separate" selected>原图 \+ 独立蒙版<\/option>/);
  elements['raster-scale'].value='1';
  elements['native-image-masks'].value='separate';
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
        return {ok:true,json:async()=>({service:'f2a-aep',version:behavior==='old-service'?2:3})};
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
      if(url.endsWith('/open-directory')){
        assert.deepEqual(JSON.parse(options.body),{exportId:'completed-export'});
        await new Promise(resolve=>setImmediate(resolve));
        return behavior==='open-error'?{ok:false,json:async()=>({error:'Explorer failure'})}:{ok:true,json:async()=>({ok:true})};
      }
      assert.equal(url,'http://127.0.0.1:7868/export');
      assert.equal(elements['export-aep'].disabled,true,'Button stays locked while the server writes');
      assert.equal(elements['raster-scale'].disabled,true,'Keep the selected scale fixed until export completes');
      assert.equal(elements['native-image-masks'].disabled,true);
      for(const id of ['organize','enableclip','ignorehidden','rastergroups','mergeblends','rastertexts','rasterallgroups','rasterinstances'])assert.equal(elements[id].disabled,true,id+' stays locked during export');
      assert.equal(posts.filter(m=>m.type==='ship-selection').length,1,'Collect and check Figma content before the server can choose a folder');
      assert.equal(elements['open-aep-folder'].hidden,true);
      if(behavior==='layer-error')return {ok:false,json:async()=>({error:'图层「shadow」无法导出：暂不支持该模糊或图层效果，请标记该层栅格化',nodeId:'original-shadow-id'})};
      if(['server-error','picker-error'].includes(behavior))return {ok:false,json:async()=>({error:behavior==='picker-error'?'Picker failure':'Test failure'})};
      if(behavior==='cancel')return {ok:true,json:async()=>({cancelled:true})};
      return {ok:true,json:async()=>({directory:'D:\\导出 位置\\Direct AEP smoke',exportId:'completed-export',warnings:behavior==='warnings'?[{},{}]:[]})};
    },
    parent:{postMessage({pluginMessage:message}){
      posts.push(message);
      if(message.type!=='ship-selection')return;
      assert.equal(message.useNodes,true);
      assert.equal(message.target,'aep');
      assert.equal(message.rasterScale,Number(elements['raster-scale'].value));
      assert.equal(message.nativeImageMasks,elements['native-image-masks'].value==='separate');
      assert.equal(message.convertMasks,true);
      emit({...packet,type:'ship',imageCount:packet.images.length});
      if(behavior==='export-error'){emit({type:'error',message:'Figma error'});finish();return;}
      for(let i=0;i<packet.images.length;i++){
        if(behavior==='missing-image'&&i===0)continue;
        const {data,...meta}=packet.images[i],split=Math.ceil(data.length/2);
        if(i===0&&behavior.startsWith('shadow'))meta.shadowBase={data:'clean PNG',dx:0,dy:0,w:64,h:64};
        if(behavior==='bicubic')meta.bicubic={width:32,height:32};
        emit({type:'image-chunk',meta,index:i,total:packet.images.length,seq:0,parts:2,dataPart:data.slice(0,split)});
        emit({type:'image-chunk',index:i,total:packet.images.length,seq:1,parts:2,dataPart:data.slice(split)});
      }
      emit({type:'images-done'});emit({type:'export-state',busy:false});finish();
    }}
  });
  function emit(message){window.onmessage({data:{pluginMessage:message}});}
  vm.runInContext(html.match(/<script>([\s\S]*)<\/script>/)[1],context);
  assert.equal(elements['bicubic-export'].checked,false,'Bicubic export is opt-in');
  assert.equal(elements['native-image-masks'].value,'separate','Preserve original images and masks by default');
  assert.equal(elements.nodemode,undefined);assert.equal(elements.convertmask,undefined);
  if(behavior==='merged-masks')elements['native-image-masks'].value='merge';
  if(behavior==='flat'){
    elements.organize.checked=false;elements.rastergroups.checked=false;elements.mergeblends.checked=false;
  }
  if(behavior==='bicubic'){
    elements['bicubic-export'].checked=true;
    context.renderBicubic=async image=>{
      assert.equal(requests.some(r=>r.url.endsWith('/export')),false);
      image.data='bicubic PNG';image.ext='png';image.natW=image.bicubic.width;image.natH=image.bicubic.height;image.bicubic=null;
    };
  }
  if(behavior.startsWith('shadow'))context.renderAepShadow=async()=>{
    assert.equal(requests.some(r=>r.url.endsWith('/export')),false,'Extract shadows before writing the project');
    if(behavior==='shadow-error')throw new Error('PNG decode failed');
    return 'extracted shadow PNG';
  };
  emit({type:'selection',count:1});
  assert.equal(elements.ship.disabled,true,'AE is disconnected');assert.equal(elements['export-aep'].disabled,false);
  return {elements,posts,requests,context,done,launches,emit};
}
const flush=()=>new Promise(r=>setImmediate(r));
(async()=>{
  const packet=await fixture();
  for(const behavior of ['success','native-masks','merged-masks','flat','bicubic','cold-start','shadow','shadow-error','warnings','offline','launch-error','bridge-offline','bridge-old','missing-component','old-service','cancel','picker-error','server-error','layer-error','export-error','missing-image','open-error']){
    const h=ui(packet,behavior);h.elements['export-aep'].onclick();
    for(let i=0;i<200&&h.context.aepBusy;i++)await flush();
    assert.equal(h.context.aepBusy,false,behavior+' must release the export lock');
    assert.equal(h.elements['export-aep'].disabled,false);
    assert.equal(h.elements['raster-scale'].disabled,false);
    assert.equal(h.elements['native-image-masks'].disabled,false);
    assert.equal(h.requests.some(r=>r.url.endsWith('/select-directory')),false,'The UI must not choose a folder ahead of validation');
    if(['success','native-masks','merged-masks','flat','bicubic','cold-start','shadow','warnings','open-error'].includes(behavior)){
      const request=JSON.parse(h.requests.find(r=>r.url.endsWith('/export')).options.body);
      assert.deepEqual(Object.keys(request),['packet']);
      const body=request.packet;
      assert.equal(body.images.length,packet.images.length);
      assert.equal(body.images[0].data,behavior==='bicubic'?'bicubic PNG':behavior==='shadow'?'extracted shadow PNG':packet.images[0].data);
      if(behavior==='bicubic'){
        assert.equal(h.posts.find(m=>m.type==='ship-selection').bicubicExport,true);
        assert.ok(body.images.every(i=>i.bicubic===null&&i.natW===32&&i.natH===32));
      }
      if(behavior==='shadow')assert.equal(body.images[0].shadowBase,null);
      assert.deepEqual(body.frame,packet.frame);assert.equal(body.texts.length,1);
      if(behavior==='warnings')assert.match(h.elements.msg.textContent,/AEP 导出失败.*未导出的属性/);
      else assert.match(h.elements.msg.textContent,/已导出到 D:\\导出 位置/);
      assert.equal(h.elements.msg.textContent.includes('report.json'),false);
    }
    if(['offline','launch-error','bridge-offline','bridge-old','missing-component','old-service'].includes(behavior)){
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
    if(behavior==='missing-image')assert.equal(h.requests.length,1,'Do not export an incomplete image batch');
    if(behavior==='shadow-error'){
      assert.equal(h.requests.some(r=>r.url.endsWith('/export')),false);assert.match(h.elements.msg.textContent,/投影.*PNG decode failed/);
    }
    if(behavior==='layer-error'){
      assert.match(h.elements.msg.textContent,/AEP 导出失败.*shadow/);
      assert.equal(h.elements['locate-layer'].hidden,false);assert.equal(h.elements['locate-layer'].disabled,false);
      const message=h.elements.msg.textContent;
      h.elements['locate-layer'].onclick();assert.equal(h.posts.at(-1).type,'locate-layer');assert.equal(h.posts.at(-1).nodeId,'original-shadow-id');
      h.emit({type:'locate-result',ok:true});assert.equal(h.elements.msg.textContent,message);
      assert.equal(h.elements['locate-layer'].disabled,false);
    }
    if(behavior==='server-error')assert.equal(h.elements['locate-layer'].hidden,true,'Errors without an original layer ID have no locate action');
    if(['success','native-masks','merged-masks','flat','cold-start','shadow','open-error'].includes(behavior)){
      assert.equal(h.elements['open-aep-folder'].hidden,false);
      h.elements['open-aep-folder'].onclick();h.elements['open-aep-folder'].onclick();
      assert.equal(h.requests.filter(r=>r.url.endsWith('/open-directory')).length,1,'Opening has its own click lock');
      assert.equal(h.elements['open-aep-folder'].disabled,true);
      for(let i=0;i<20&&h.context.openingFolder;i++)await flush();
      assert.equal(h.elements['open-aep-folder'].disabled,false);
      if(behavior==='open-error')assert.match(h.elements.msg.textContent,/无法打开文件夹.*Explorer failure/);
      h.requests.length=0;h.posts.length=0;
      h.elements['export-aep'].onclick();
      assert.equal(h.elements['open-aep-folder'].hidden,true,'A new export clears the previous result');
      for(let i=0;i<200&&h.context.aepBusy;i++)await flush();
    }else if(behavior!=='bicubic')assert.equal(h.elements['open-aep-folder'].hidden,true,'Cancelled and failed exports expose no folder action');
  }
  const h=ui(packet);
  h.elements['raster-scale'].value='4';h.elements['export-aep'].onclick();
  for(let i=0;i<200&&h.context.aepBusy;i++)await flush();
  assert.equal(h.posts.find(message=>message.type==='ship-selection').rasterScale,4);
  function composite(fg,bg){const a=fg[3]/255,b=bg[3]/255,alpha=a+b*(1-a);return [0,1,2].map(i=>alpha?Math.round((fg[i]*a+bg[i]*b*(1-a))/alpha):0).concat(Math.round(alpha*255));}
  for(const clean of [[0,0,0,0],[90,180,225,128],[255,255,255,255]])for(const shadow of [[0,0,0,128],[30,70,120,80]]){
    const full=composite(clean,shadow),recovered=Array.from(h.context.extractAepShadow(full,clean));
    assert.ok(composite(clean,recovered).every((v,i)=>Math.abs(v-full[i])<=1));
  }
  console.log('PASS: launch → Figma checks/images → checked export; open-folder success/error, click lock, cancel/failure, hidden stale results, cold start and offline errors');
})().catch(e=>{console.error(e);process.exitCode=1;});
