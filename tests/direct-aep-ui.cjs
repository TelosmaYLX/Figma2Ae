const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {fixture} = require('./direct-aep.cjs');
const rasterControls = {effects:'raster-effects',paints:'raster-paints',imageCrops:'raster-image-crops',masks:'raster-masks',booleans:'raster-booleans'};

function ui(packet, behavior='success') {
  const html=fs.readFileSync(require('node:path').join(__dirname,'../figma-plugin/ui.html'),'utf8'),elements={},posts=[],requests=[];
  for(const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g))elements[m[1]]={checked:/\bchecked\b/.test(m[0]),disabled:/\bdisabled\b/.test(m[0]),hidden:/\bhidden\b/.test(m[0])};
  assert.match(html,/<option value="1" selected>1×<\/option>/);
  assert.match(html,/<option value="separate" selected>原图 \+ 独立蒙版<\/option>/);
  elements['raster-scale'].value='1';
  elements['native-image-masks'].value='separate';
  elements['text-mode'].value=html.match(/<select id="text-mode"[^>]*>[\s\S]*?<option value="([^"]+)" selected/)[1];
  elements['aep-version'].value=html.match(/<select id="aep-version"[^>]*>[\s\S]*?<option value="([^"]+)" selected/)[1];
  elements['aep-duration'].value=html.match(/<select id="aep-duration"[^>]*>[\s\S]*?<option value="([^"]+)" selected/)[1];
  elements['aep-fps'].value=html.match(/<select id="aep-fps"[^>]*>[\s\S]*?<option value="([^"]+)" selected/)[1];
  assert.equal(elements['aep-version'].value,'26.0');
  assert.equal(elements['aep-duration'].value,'10');
  assert.equal(elements['aep-fps'].value,'30');
  // The composition panel sits directly under the send button and holds the export action: the
  // three labelled selectors first, then the 导出为 AEP 工程 button at the bottom. No visible panel
  // heading or hint line remains.
  const compGroup = html.match(/<div class="settings comp-settings"[\s\S]*?<div id="msg"/);
  assert.ok(compGroup, 'AEP composition settings and the export action share one panel');
  assert.match(html, /<button id="ship"[^>]*>发送到 After Effects<\/button>/, 'the import action is labelled 发送到 After Effects');
  assert.match(compGroup[0], /id="aep-duration"[\s\S]*id="aep-fps"[\s\S]*id="aep-version"[\s\S]*id="export-aep"/, 'selectors read left to right above the export button');
  for (const [id, caption] of [['aep-duration','合成时长'],['aep-fps','帧率'],['aep-version','AEP 版本']]) {
    assert.match(compGroup[0], new RegExp('<label for="' + id + '">' + caption + '</label>'), id + ' has a small caption above it');
  }
  assert.match(compGroup[0], /<option value="4">4 秒<\/option>/, 'a 4-second composition can be exported');
  assert.equal(/\.aep-export\s*\{[^}]*background/.test(html), false, 'the export action inherits the send action accent fill');
  assert.match(compGroup[0], /<button id="export-aep"[^>]*>导出为 AEP 工程<\/button>/, 'the export action is labelled 导出为 AEP 工程');
  assert.equal(/<legend>合成<\/legend>/.test(html), false, 'the composition panel has no visible heading');
  assert.equal(html.includes('用于导出 AEP，或未打开合成时新建合成。'), false, 'the panel has no hint line');
  const importAt = html.indexOf('id="ship"'), groupAt = html.indexOf('class="settings comp-settings"'), toolsAt = html.indexOf('id="layer-tools"');
  assert.ok(importAt >= 0 && importAt < groupAt && groupAt < toolsAt, 'composition panel sits between the import button and the layer tools');
  assert.equal((html.match(/id="aep-version"/g) || []).length, 1, 'the AEP version selector appears exactly once');
  assert.equal(/class="aep-actions"|class="aep-version"/.test(html), false, 'the version selector no longer shares the export action row');
  // The send block is a panel too: the image folder row and the send action share one panel
  // directly above the composition panel.
  const sendPanel = html.match(/<div class="settings send-settings"[^>]*>[\s\S]*?id="ship"[^>]*>发送到 After Effects<\/button>\s*<\/div>/);
  assert.ok(sendPanel, 'the folder row and the send action share one panel');
  assert.match(sendPanel[0], /id="image-folder-path"/, 'the send panel holds the image folder path');
  assert.match(sendPanel[0], /id="image-folder-choose"/, 'the send panel holds the folder picker');
  assert.ok(html.indexOf('class="settings send-settings"') < html.indexOf('class="settings comp-settings"'), 'the send panel sits directly above the composition panel');
  assert.match(html, /\.image-folder-path \{[^}]*background:var\(--bg\)/, 'the path field uses the native field fill on the panel');
  assert.match(html, /\.image-folder-choose \{[^}]*background:var\(--surface\)/, 'the folder picker uses a raised fill on the panel');
  assert.match(html, /\.image-folder-choose \{[^}]*display:flex; align-items:center; justify-content:center/, 'the folder picker centres its icon');
  const layerGroup = html.match(/<fieldset class="settings">\s*<legend>图层<\/legend>[\s\S]*?<\/fieldset>/);
  assert.ok(layerGroup, 'layer settings have their own group');
  assert.match(layerGroup[0], /id="precomp-layers"[^>]*> 单图层嵌套预合成/, 'single-layer precomp option sits in the layer settings group');
  assert.equal(layerGroup[0].includes('preserve-background-blur'), false, 'background blur moved out of the layer settings group');
  const imageGroup = html.match(/<fieldset class="settings">\s*<legend>图片<\/legend>[\s\S]*?<\/fieldset>/);
  assert.ok(imageGroup, 'image settings have their own group');
  assert.equal(imageGroup[0].includes('preserve-image-filters'), false, 'colour preservation moved out of the image settings group');
  // Colour preservation and background blur are effects: they share one collapsible 效果 group
  // between the image settings and the advanced options, and start open.
  assert.ok(html.indexOf('<legend>图片</legend>') < html.indexOf('id="effect-options"') && html.indexOf('id="effect-options"') < html.indexOf('id="advanced-options"'), 'the effects group sits between image settings and advanced options');
  const effectGroup = html.match(/<details id="effect-options"[^>]*>[\s\S]*?<\/details>/);
  assert.ok(effectGroup, 'effects have their own collapsible group');
  assert.match(effectGroup[0], /<details id="effect-options"[^>]*\bopen\b[^>]*>/, 'the effects group starts open and can be folded');
  assert.match(effectGroup[0], /<summary>效果<\/summary>/, 'the effects group heading reads 效果');
  assert.match(effectGroup[0], /<label class="option"><input[^>]*id="preserve-image-filters"[^>]*> 保留图片调色属性<\/label>/, 'colour preservation sits in the effects group without a caption');
  assert.match(effectGroup[0], /<label class="option" title="[^"]*"><input[^>]*id="preserve-background-blur"[^>]*> 保留背景模糊<\/label>/, 'background blur sits in the effects group');
  assert.equal(html.includes('优先用 Figma 调色插件还原，缺失时退回 LUT 调色。'), false, 'the panel no longer explains the LUT fallback');
  assert.equal(html.includes('option-hint'), false, 'the removed caption leaves no dead style');
  assert.match(html, /select:focus,select:focus-visible \{ outline:none; \}/, 'dropdowns no longer draw the accent focus ring');
  assert.equal(html.includes('在 AE 图片图层的「效果控件」中调色或打关键帧。'), false, 'the old advanced caption is gone');
  assert.equal(html.includes('图片填充'), false, 'the empty advanced image group is gone');
  assert.ok(html.indexOf('id="preserve-image-filters"') < html.indexOf('id="advanced-options"'), 'the image option no longer lives under advanced options');
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
        return {ok:true,json:async()=>({service:'f2a-aep',version:behavior==='old-service'?2:3,
          aeVersions:behavior==='old-version-service'?undefined:['24.0','25.0','26.0'],
          preserveImageFilters:behavior!=='old-grade-service',
          preserveBackgroundBlur:behavior!=='old-blur-service',
          singleLayerLabel:behavior!=='old-label-service'})};
      }
      if(url.endsWith('/aep/start')){
        assert.equal(url,'http://127.0.0.1:7365/aep/start');assert.equal(options.method,'POST');
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
      assert.equal(url,'http://127.0.0.1:7366/export');
      assert.equal(elements['export-aep'].disabled,true,'Button stays locked while the server writes');
      assert.equal(elements['raster-scale'].disabled,true,'Keep the selected scale fixed until export completes');
      assert.equal(elements['native-image-masks'].disabled,true);
      for(const id of ['aep-version','aep-duration','aep-fps','organize','precomp-layers','enableclip','ignorehidden','text-mode',...Object.values(rasterControls),'mergeblends','rasterallgroups','rasterinstances'])assert.equal(elements[id].disabled,true,id+' stays locked during export');
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
      assert.equal(message.rasterGroups,undefined,'No broad hidden rasterization switch');
      for(const [key,id] of Object.entries(rasterControls))assert.equal(message.rasterize[key],elements[id].checked,key+' is independently transmitted');
      assert.equal(message.preserveImageFilters,elements['preserve-image-filters'].checked);
      assert.equal(message.preserveBackgroundBlur,elements['preserve-background-blur'].checked);
      assert.equal(message.precompLayers,elements['precomp-layers'].checked);
      emit({...packet,type:'ship',preserveImageFilters:message.preserveImageFilters,
        preserveBackgroundBlur:message.preserveBackgroundBlur,imageCount:packet.images.length});
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
  assert.equal(elements['bicubic-export'],undefined,'The panel no longer offers the bicubic experiment');
  assert.equal(elements['native-image-masks'].value,'separate','Preserve original images and masks by default');
  assert.equal(elements.nodemode,undefined);assert.equal(elements.convertmask,undefined);
  assert.equal(elements.rastergroups,undefined);
  assert.equal(elements['preserve-image-filters'].checked,false);
  assert.equal(elements['preserve-background-blur'].checked,false);
  assert.equal(elements['precomp-layers'].checked,true);
  if(['image-grade','old-grade-service'].includes(behavior))elements['preserve-image-filters'].checked=true;
  if(['background-blur','old-blur-service'].includes(behavior))elements['preserve-background-blur'].checked=true;
  assert.equal(elements.rastertexts,undefined,'Text modes are mutually exclusive');
  for(const id of Object.values(rasterControls))assert.equal(elements[id].checked,true,id+' preserves automatic handling by default');
  if(behavior==='merged-masks')elements['native-image-masks'].value='merge';
  if(behavior==='editable-text')elements['text-mode'].value='editable';
  if(behavior==='png-text')elements['text-mode'].value='png';
  if(behavior==='ae24')elements['aep-version'].value='24.0';
  if(behavior==='ae25')elements['aep-version'].value='25.0';
  if(behavior==='custom-comp'){elements['aep-duration'].value='5';elements['aep-fps'].value='60';}
  if(behavior==='flat'){
    elements.organize.checked=false;elements.mergeblends.checked=false;
    for(const [index,id] of Object.values(rasterControls).entries())elements[id].checked=index%2===0;
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
  const workspace=ui(packet);
  workspace.emit({type:'selection',count:1,workspacePlugin:true});
  workspace.elements['export-aep'].onclick();
  for(let i=0;i<200&&workspace.context.aepBusy;i++)await flush();
  assert.ok(workspace.requests.some(r=>r.url==='http://127.0.0.1:17366/health'));
  assert.ok(workspace.requests.some(r=>r.url==='http://127.0.0.1:17366/export'));
  for(const mode of ['image-grade','old-grade-service']){
    const h=ui(packet,mode);h.elements['export-aep'].onclick();
    for(let i=0;i<200&&h.context.aepBusy;i++)await flush();
    const upload=h.requests.find(r=>r.url.endsWith('/export'));
    if(mode==='image-grade')assert.equal(JSON.parse(upload.options.body).packet.preserveImageFilters,true);
    else {assert.equal(upload,undefined);assert.match(h.elements.msg.textContent,/保留图片调色需要更新/);}
  }
  for(const mode of ['background-blur','old-blur-service']){
    const h=ui(packet,mode);h.elements['export-aep'].onclick();
    for(let i=0;i<200&&h.context.aepBusy;i++)await flush();
    const upload=h.requests.find(r=>r.url.endsWith('/export'));
    if(mode==='background-blur')assert.equal(JSON.parse(upload.options.body).packet.preserveBackgroundBlur,true);
    else {assert.equal(upload,undefined);assert.match(h.elements.msg.textContent,/保留背景模糊需要更新/);}
  }
  {
    const stale=ui(packet,'old-label-service');stale.elements['export-aep'].onclick();
    for(let i=0;i<200&&stale.context.aepBusy;i++)await flush();
    assert.equal(stale.requests.some(r=>r.url.endsWith('/export')),false);
    assert.equal(stale.posts.filter(m=>m.type==='ship-selection').length,0);
    assert.match(stale.elements.msg.textContent,/单图层嵌套预合成标黄需要更新/);
    assert.equal(stale.elements.msg.textContent.includes('--workspace'),false);
    stale.emit({type:'selection',count:1,workspacePlugin:true});
    stale.elements['export-aep'].onclick();
    for(let i=0;i<200&&stale.context.aepBusy;i++)await flush();
    assert.equal(stale.requests.some(r=>r.url.endsWith('/export')),false);
    assert.match(stale.elements.msg.textContent,/node scripts\/aep-server\.cjs --workspace/);
    stale.elements['precomp-layers'].checked=false;
    stale.emit({type:'selection',count:1,workspacePlugin:false});
    stale.elements['export-aep'].onclick();
    for(let i=0;i<200&&stale.context.aepBusy;i++)await flush();
    assert.equal(stale.requests.some(r=>r.url.endsWith('/export')),true,'Old AEP service still works when single-layer precomp is turned off');
  }
  for(const behavior of ['success','ae24','ae25','custom-comp','native-masks','merged-masks','editable-text','png-text','flat','cold-start','shadow','shadow-error','warnings','offline','launch-error','bridge-offline','bridge-old','missing-component','old-service','old-version-service','cancel','picker-error','server-error','layer-error','export-error','missing-image','open-error']){
    const h=ui(packet,behavior);h.elements['export-aep'].onclick();
    for(let i=0;i<200&&h.context.aepBusy;i++)await flush();
    assert.equal(h.context.aepBusy,false,behavior+' must release the export lock');
    assert.equal(h.elements['export-aep'].disabled,false);
    assert.equal(h.elements['raster-scale'].disabled,false);
    assert.equal(h.elements['native-image-masks'].disabled,false);
    assert.equal(h.requests.some(r=>r.url.endsWith('/select-directory')),false,'The UI must not choose a folder ahead of validation');
    const selection=h.posts.find(m=>m.type==='ship-selection');
    if(selection){assert.equal(selection.outlineTexts,!['editable-text','png-text'].includes(behavior));assert.equal(selection.rasterTexts,behavior==='png-text');}
    if(['success','ae24','ae25','custom-comp','native-masks','merged-masks','editable-text','png-text','flat','cold-start','shadow','warnings','open-error'].includes(behavior)){
      const request=JSON.parse(h.requests.find(r=>r.url.endsWith('/export')).options.body);
      assert.deepEqual(Object.keys(request),['packet']);
      const body=request.packet;
      assert.equal(body.aeVersion,behavior==='ae24'?'24.0':behavior==='ae25'?'25.0':'26.0');
      assert.equal(body.duration,behavior==='custom-comp'?5:10);
      assert.equal(body.frameRate,behavior==='custom-comp'?60:30);
      assert.equal(body.images.length,packet.images.length);
      assert.equal(body.images[0].data,behavior==='shadow'?'extracted shadow PNG':packet.images[0].data);

      if(behavior==='shadow')assert.equal(body.images[0].shadowBase,null);
      assert.deepEqual(body.frame,packet.frame);assert.equal(body.texts.length,1);
      if(behavior==='warnings')assert.match(h.elements.msg.textContent,/AEP 导出失败.*未导出的属性/);
      else assert.match(h.elements.msg.textContent,/已导出到 D:\\导出 位置/);
      assert.equal(h.elements.msg.textContent.includes('report.json'),false);
    }
    if(['offline','launch-error','bridge-offline','bridge-old','missing-component','old-service','old-version-service'].includes(behavior)){
      assert.equal(h.posts.filter(m=>m.type==='ship-selection').length,0);
      assert.equal(h.requests.some(r=>r.url.endsWith('/export')),false);
    }
    if(behavior==='cancel')assert.equal(h.elements.msg.textContent,'已取消导出。');
    if(behavior==='old-service')assert.match(h.elements.msg.textContent,/请重启/);
    if(behavior==='old-version-service')assert.match(h.elements.msg.textContent,/请更新 AEP 导出组件/);
    if(['cold-start','offline','launch-error','bridge-offline','bridge-old','missing-component'].includes(behavior))assert.deepEqual(h.launches,['http://127.0.0.1:7365/aep/start']);
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
    if(['success','ae24','ae25','custom-comp','native-masks','merged-masks','editable-text','png-text','flat','cold-start','shadow','open-error'].includes(behavior)){
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
    }else assert.equal(h.elements['open-aep-folder'].hidden,true,'Cancelled and failed exports expose no folder action');
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

  // Persistence round-trip across actual code.js clientStorage + ui.html
  const clientStore = new Map();
  function openWithStorage() {
    const html = fs.readFileSync(require('node:path').join(__dirname, '../figma-plugin/ui.html'), 'utf8');
    const code = fs.readFileSync(require('node:path').join(__dirname, '../figma-plugin/code.js'), 'utf8');
    const elements = {};
    for (const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
      elements[m[1]] = { checked: /\bchecked\b/.test(m[0]), disabled: /\bdisabled\b/.test(m[0]), hidden: /\bhidden\b/.test(m[0]) };
    }
    elements['aep-version'].value = '26.0';
    elements['aep-duration'].value = '10';
    elements['aep-fps'].value = '30';
    elements['text-mode'].value = 'vector';
    elements['native-image-masks'].value = 'separate';
    elements['raster-scale'].value = '1';
    elements['aep-duration'].options = ['1','2','3','4','5','10','15','20','30','60'].map(v => ({value: v}));
    elements['aep-fps'].options = ['15','24','25','30','50','60','120'].map(v => ({value: v}));
    const uiWindow = { onmessage() {} };
    const figma = {
      mixed: Symbol('mixed'), showUI() {}, on() {}, notify() {}, commitUndo() {},
      currentPage: { id: '0:1', name: 'Page 1', selection: [] }, root: { name: 'Doc' },
      clientStorage: {
        async getAsync(k) { return clientStore.has(k) ? JSON.parse(JSON.stringify(clientStore.get(k))) : undefined; },
        async setAsync(k, v) { clientStore.set(k, JSON.parse(JSON.stringify(v))); }
      },
      ui: { postMessage(m) { uiWindow.onmessage({ data: { pluginMessage: m } }); } }
    };
    const mainCtx = vm.createContext({ figma, __html__: '', console, setTimeout, clearTimeout });
    vm.runInContext(code, mainCtx);
    vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], {
      window: uiWindow,
      document: { getElementById: id => elements[id] },
      Date, setTimeout() {}, clearTimeout() {},
      WebSocket: function() { this.readyState = 0; this.send = () => {}; },
      fetch: async () => ({ ok: true, json: async () => ({ directory: '' }) }),
      parent: { postMessage(m) { figma.ui.onmessage(m.pluginMessage); } }
    });
    return { elements, uiWindow };
  }
  const firstOpen = openWithStorage();
  await flush();
  firstOpen.elements['aep-version'].value = '24.0'; firstOpen.elements['aep-version'].onchange();
  firstOpen.elements['aep-duration'].value = '15'; firstOpen.elements['aep-duration'].onchange();
  firstOpen.elements['aep-fps'].value = '60'; firstOpen.elements['aep-fps'].onchange();
  firstOpen.elements['text-mode'].value = 'editable'; firstOpen.elements['text-mode'].onchange();
  firstOpen.elements['native-image-masks'].value = 'merge'; firstOpen.elements['native-image-masks'].onchange();
  firstOpen.elements['raster-scale'].value = '3'; firstOpen.elements['raster-scale'].onchange();
  for (const id of ['organize','precomp-layers','enableclip','ignorehidden','raster-effects','raster-paints','raster-image-crops','raster-masks','raster-booleans','mergeblends']) {
    firstOpen.elements[id].checked = false; firstOpen.elements[id].onchange();
  }
  for (const id of ['rasterallgroups','rasterinstances']) {
    firstOpen.elements[id].checked = true; firstOpen.elements[id].onchange();
  }
  await flush();
  const secondOpen = openWithStorage();
  await flush();
  assert.equal(secondOpen.elements['aep-version'].value, '24.0');
  assert.equal(secondOpen.elements['aep-duration'].value, '15');
  assert.equal(secondOpen.elements['aep-fps'].value, '60');
  assert.equal(secondOpen.elements['text-mode'].value, 'editable');
  assert.match(secondOpen.elements['text-mode-hint'].textContent, /细描边文字自动转为矢量/);
  assert.equal(secondOpen.elements['native-image-masks'].value, 'merge');
  assert.equal(secondOpen.elements['raster-scale'].value, '3');
  for (const id of ['organize','precomp-layers','enableclip','ignorehidden','raster-effects','raster-paints','raster-image-crops','raster-masks','raster-booleans','mergeblends']) {
    assert.equal(secondOpen.elements[id].checked, false, id + ' must restore false');
  }
  for (const id of ['rasterallgroups','rasterinstances']) {
    assert.equal(secondOpen.elements[id].checked, true, id + ' must restore true');
  }
  // Invalid saved options or pre-load user edits must not corrupt controls
  secondOpen.elements['aep-fps'].value = '24'; secondOpen.elements['aep-fps'].onchange();
  secondOpen.uiWindow.onmessage({ data: { pluginMessage: { type: 'settings-loaded', settings: { 'aep-fps': '999', 'aep-duration': 'invalid' } } } });
  assert.equal(secondOpen.elements['aep-fps'].value, '24');
  assert.equal(secondOpen.elements['aep-duration'].value, '15');

  console.log('PASS: launch → Figma checks/images → checked export; open-folder success/error, click lock, cancel/failure, hidden stale results, cold start, offline errors, duration/fps and full settings persistence');
})().catch(e=>{console.error(e);process.exitCode=1;});
