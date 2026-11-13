const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {group, node, harness} = require('./export-options.cjs');
const root = path.join(__dirname, '..');

function bridgeHarness() {
  let request, nextTimer = 0;
  const batches = [], imports = [], aborts = [], timers = new Map();
  const context = vm.createContext({
    module: {exports: {}}, Buffer,
    require(name) {
      if (name !== 'http') return require(name);
      return {createServer(handler) { request = handler; return {on() {}, listen() {}}; }};
    },
    setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'client/mkBridgeServer.js'), 'utf8'), context);
  context.module.exports.start({onSvg(svg, meta) { imports.push({svg, meta}); }, onImages(images) { batches.push(images); },onAbort(message){aborts.push(message);}});
  function send(message) {
    const req = new EventEmitter(); req.method = 'POST';
    let response;
    request(req, {writeHead() {}, end(body) { response = JSON.parse(body); }});
    req.emit('data', JSON.stringify(message)); req.emit('end');
    assert.ok(response.ok || message.type==='export-abort',response.error);
    return response;
  }
  return {send, batches, imports, timers, aborts};
}
function uiHarness(bridge, main) {
  const html = fs.readFileSync(path.join(root, 'figma-plugin/ui.html'), 'utf8'), elements = {};
  for (const m of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) elements[m[1]] = {checked: /\bchecked\b/.test(m[0]), disabled: /\bdisabled\b/.test(m[0])};
  elements['raster-scale'].value='1';
  elements['native-image-masks'].value='separate';
  let socket;
  function WebSocket() { socket = this; this.readyState = 1; this.send = text => bridge.send(JSON.parse(text)); }
  const window = {};
  vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], {
    window, WebSocket, document: {getElementById: id => elements[id]},
    fetch:async()=>({ok:true,json:async()=>({directory:'D:/Figma Assets'})}),
    parent: {postMessage(m) { main.figma.ui.onmessage(m.pluginMessage); }}, setTimeout() {}
  });
  main.figma.ui.postMessage = m => window.onmessage({data: {pluginMessage: m}});
  socket.onopen();
  main.context.reportSelection();
  return {elements};
}
(async () => {
  const bridge = bridgeHarness();
  const svg = '<svg width="100" height="60"></svg>';
  bridge.send({svg, imageCount: 3, imageBatch: true, nodes: []});
  bridge.send({type: 'image', total: 3, image: {name: 'first'}});
  assert.equal(bridge.batches.length, 0); assert.equal(bridge.timers.size, 0, 'A slow PNG must not cause a timeout flush');
  bridge.send({type: 'image', total: 3, image: {name: 'third'}}); // one PNG failed in Figma
  bridge.send({type: 'images-complete'});
  assert.equal(bridge.batches.length, 0);assert.equal(bridge.aborts.length,1,'Do not import partial image batches');
  bridge.send({type: 'images-complete'});
  assert.equal(bridge.batches.length, 0, 'Do not organize failed batches');
  bridge.send({svg, imageCount: 1, imageBatch: true}); bridge.send({type: 'images-complete'});
  assert.equal(bridge.batches.length, 0);assert.equal(bridge.aborts.length,2);
  bridge.send({svg, imageCount: 1}); bridge.send({type: 'image', total: 1, image: {name: 'old plugin'}});
  assert.equal(bridge.batches.length, 1, 'Older plugins still finish by image count');
  bridge.send({svg,imageCount:2,imageBatch:true});bridge.send({type:'image',total:2,image:{name:'partial'}});
  bridge.send({type:'export-abort',message:'图片「broken」导出失败'});
  bridge.send({type:'images-complete'});assert.equal(bridge.batches.length,1);assert.equal(bridge.aborts.length,3);

  // Exercise both actual scripts and the bridge together, including the two UI buttons.
  const connected = bridgeHarness(), scene = group('画框', [group('卡片', [node('TEXT', '卡片标题')])]), main = harness(scene);
  const ui = uiHarness(connected, main);
  ui.elements['mark-raster'].onclick();
  assert.equal(scene.name, '*画框');
  ui.elements['unmark-raster'].onclick(); assert.equal(scene.name, '画框');
  scene.children[0].name = '*卡片';
  await main.context.exportSelectionSVG(true, true, true, false, false);
  assert.equal(connected.imports.length, 1); assert.equal(connected.imports[0].meta.imageCount, 2);
  assert.equal(connected.imports[0].meta.nodes.length, 0);
  assert.equal(connected.batches.length, 1); assert.equal(connected.batches[0].length, 2);
  assert.equal(connected.batches[0].filter(im=>im.reference&&im.hidden).length,1);
  assert.equal(ui.elements.ship.disabled, false); assert.equal(ui.elements['mark-raster'].disabled, false);
  const textBridge = bridgeHarness(), textMain = harness(group('文字画框', [node('TEXT', '文字 A'), node('TEXT', '文字 B')]));
  const textUi = uiHarness(textBridge, textMain);
  assert.equal(textUi.elements.rastertexts.checked, false);
  textUi.elements.rastertexts.checked = true;
  const post = textMain.figma.ui.postMessage;
  const finished = new Promise(resolve => {
    textMain.figma.ui.postMessage = m => { post(m); if (m.type === 'export-state' && !m.busy) resolve(); };
  });
  textUi.elements.ship.onclick(); await finished;
  assert.equal(textBridge.imports[0].meta.texts.length, 0);
  assert.equal(textBridge.batches.length, 1); assert.equal(textBridge.batches[0].filter(im=>!im.reference).length, 2, 'The checkbox reaches the exporter through the actual UI message handler');
  const policyBridge = bridgeHarness(), policyMain = harness(node('FRAME', '选项画框', {clipsContent: true, fills: [{type: 'SOLID'}], children: [group('Group', [node('TEXT', '组文字')]), node('INSTANCE', 'Instance', {children: [node('TEXT', '实例文字')]})]}));
  const policyUi = uiHarness(policyBridge, policyMain);
  assert.equal(policyUi.elements.rasterallgroups.checked, false); assert.equal(policyUi.elements.rasterinstances.checked, false); assert.equal(policyUi.elements.enableclip.checked, true);
  policyUi.elements.rasterallgroups.checked = true; policyUi.elements.rasterinstances.checked = true; policyUi.elements.enableclip.checked = false;
  const policyPost = policyMain.figma.ui.postMessage;
  const policyDone = new Promise(resolve => {
    policyMain.figma.ui.postMessage = m => { policyPost(m); if (m.type === 'export-state' && !m.busy) resolve(); };
  });
  policyUi.elements.ship.onclick(); await policyDone;
  assert.equal(policyBridge.batches[0].filter(im=>!im.reference).length, 2); assert.equal(policyBridge.imports[0].meta.texts.length, 0);
  assert.equal(policyBridge.imports[0].meta.containers.length, 1); assert.equal(policyBridge.imports[0].meta.containers[0].clip, false);
  const blendBridge=bridgeHarness(),blendMain=harness(group('叠加',[node('RECTANGLE','底图',{cornerRadius:0,fills:[{type:'SOLID'}]}),node('RECTANGLE','柔光',{blendMode:'SOFT_LIGHT'}),node('TEXT','标题')]));
  const blendUi=uiHarness(blendBridge,blendMain);
  assert.equal(blendUi.elements.mergeblends.checked,true);
  async function clickBlend(){const post=blendMain.figma.ui.postMessage;await new Promise(resolve=>{blendMain.figma.ui.postMessage=m=>{post(m);if(m.type==='export-state'&&!m.busy){blendMain.figma.ui.postMessage=post;resolve();}};blendUi.elements.ship.onclick();});}
  await clickBlend();
  assert.equal(blendBridge.batches[0].filter(im=>im.mergedBlend).length,1,'Blend checkbox reaches exporter through the real iframe');
  blendUi.elements.mergeblends.checked=false;await clickBlend();
  assert.equal(blendBridge.batches[1].filter(im=>im.mergedBlend).length,0);
  const failedBridge=bridgeHarness(),failedMain=harness(group('page',[group('*broken image',[node('RECTANGLE','art')])]));
  failedMain.figma.currentPage.selection[0].children[0].exportAsync=async()=>{throw new Error('render failed');};
  const failedUi=uiHarness(failedBridge,failedMain);
  await failedMain.context.exportSelectionSVG(true,true,true,false,true,false,{});
  assert.equal(failedBridge.imports.length,1);assert.equal(failedBridge.batches.length,0);assert.equal(failedBridge.aborts.length,1);
  assert.match(failedUi.elements.msg.textContent,/broken_image.*render failed/);
  assert.equal(failedUi.elements.ship.disabled,false);
  console.log('PASS: explicit completion, slow/failed images, single batch, old protocol, main → actual UI → bridge, both mark buttons');
})().catch(e => { console.error(e); process.exitCode = 1; });
