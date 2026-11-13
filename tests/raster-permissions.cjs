const assert = require('node:assert/strict');
const {node, group, harness} = require('./export-options.cjs');
const {png} = require('./direct-aep.cjs');
const geometry = [{data:'M0 0H100V60H0Z',windingRule:'NONZERO'}];
const solid = (name, extra={}) => node('RECTANGLE',name,{fillGeometry:geometry,
  fills:[{type:'SOLID',color:{r:.2,g:.4,b:.7}}],...extra});
const disabled = {effects:false,paints:false,imageCrops:false,masks:false,booleans:false};
const names = {effects:'模糊、阴影和特殊效果',paints:'特殊填充与描边',imageCrops:'图片裁剪',masks:'复杂蒙版',booleans:'布尔运算结果'};
const original = png(100,60);
function setup(art) {
  const h=harness(group('page',[node('TEXT','Editable caption'),art,solid('unrelated shape')]));
  h.figma.getImageByHash=()=>({getBytesAsync:async()=>original,getSizeAsync:async()=>({width:100,height:60})});
  return h;
}
function options(rasterize={}, extra={}) {return {target:'aep',nativeImageMasks:true,rasterize:{...disabled,...rasterize},...extra};}
async function reject(h, setting, sourceId) {
  h.messages.length=0;
  await h.context.exportSelectionSVG(true,true,true,true,true,false,options());
  const error=h.messages.find(m=>m.type==='error');
  assert.ok(error,setting+' must not silently bake or lose artwork');
  assert.ok(error.message.includes('开启“'+names[setting]+'”'),error.message);
  assert.equal(error.nodeId,sourceId,'Errors locate the original source');
  assert.equal(h.messages.some(m=>m.type==='ship'),false);
}
async function check() {
  const cases = [
    ['effects',()=>solid('shadow',{effects:[{type:'DROP_SHADOW',visible:true,radius:4,offset:{x:0,y:2},color:{r:0,g:0,b:0,a:.5}}]})],
    ['effects',()=>solid('blur',{effects:[{type:'LAYER_BLUR',visible:true,radius:4}]})],
    ['effects',()=>solid('frosted',{effects:[{type:'BACKGROUND_BLUR',visible:true,radius:4}]})],
    ['effects',()=>solid('glass',{effects:[{type:'GLASS',visible:true}]})],
    ...['GRADIENT_ANGULAR','GRADIENT_DIAMOND','VIDEO','PATTERN','SHADER'].map(type=>['paints',()=>solid(type,{fills:[{type}]})]),
    ['imageCrops',()=>solid('cropped photo',{fills:[{type:'IMAGE',imageHash:'photo',scaleMode:'CROP',imageTransform:[[.5,0,.2],[0,.5,.1]]}]})],
    ['booleans',()=>solid('boolean without path',{type:'BOOLEAN_OPERATION',fillGeometry:[],children:[solid('operand')]})]
  ];
  for(const [setting,make] of cases) {
    const art=make(),h=setup(art);
    await reject(h,setting,art.id);
    const result=await h.run(true,true,true,false,options({[setting]:true}));
    assert.equal(result.images.length,1,art.name+' uses only its own permission');
    assert.ok(result.ship.texts.some(t=>t.name==='Editable caption'));
    assert.ok(result.ship.nodes.some(n=>n.name==='unrelated shape'));
    if(art.name==='shadow')assert.ok(result.images[0].shadow,'Drop shadow keeps a separate image');
  }

  // Turning off unrelated categories must preserve native paths, gradients and simple masks.
  const vector=solid('ordinary boolean',{type:'BOOLEAN_OPERATION',children:[solid('operand')]}),mask=solid('simple mask',{isMask:true});
  const native=await setup(group('native content',[vector,group('mask scope',[mask,solid('masked vector')])])).run(true,true,true,false,options());
  assert.equal(native.images.length,0);assert.ok(native.ship.nodes.some(n=>n.name==='ordinary boolean'));
  assert.ok(native.ship.nodes.some(n=>n.name==='masked vector'&&n.maskId));
  const nativeEffect=await setup(group('native AE blur',[solid('blur content')],{effects:[{type:'LAYER_BLUR',visible:true,radius:4}]})).run(true,true,true,false,options({}, {target:'ae'}));
  assert.equal(nativeEffect.images.length,0);assert.ok(nativeEffect.ship.containers.some(c=>c.name==='native AE blur'&&c.blur===4));

  const fade=solid('fade mask',{isMask:true,fills:[{type:'GRADIENT_LINEAR',gradientStops:[{position:0,color:{r:1,g:1,b:1,a:0}},{position:1,color:{r:1,g:1,b:1,a:1}}]}]}),
    textScope=setup(group('text fade',[fade,node('TEXT','Text inside gradient mask')]));
  await reject(textScope,'masks',fade.id);
  const faded=await textScope.run(true,true,true,false,options({masks:true}));
  assert.equal(faded.images.length,1);assert.equal(faded.ship.texts.length,1,'A non-image complex scope is merged; the outside caption stays editable');

  // An independent complex mask can become a PNG without baking the original photo or text.
  const source=solid('bitmap mask',{isMask:true,maskType:'ALPHA',fills:[{type:'IMAGE',imageHash:'mask',scaleMode:'FIT'}]}),
    photo=solid('masked photo',{fills:[{type:'IMAGE',imageHash:'photo',scaleMode:'CROP',imageTransform:[[.5,0,.2],[0,.5,.1]]}]}),
    scope=group('masked content',[source,photo,node('TEXT','Masked editable text')]),h=setup(scope);
  await reject(h,'masks',source.id);
  const separate=await h.run(true,true,true,false,options({masks:true}));
  assert.equal(separate.images.filter(im=>im.maskSource).length,1);
  assert.ok(separate.images.some(im=>im.sourceId===photo.id&&!im.rasterScale));
  assert.ok(separate.ship.texts.some(t=>t.name==='Masked editable text'));
  const originalChunk=h.messages.find(m=>m.type==='image-chunk'&&m.meta?.sourceId===photo.id);
  assert.equal(originalChunk.dataPart,original.toString('base64'),'Original source pixels remain intact');

  // Explicit merged-mask and manual whole-group choices have their own visible controls.
  const merged=await h.run(true,true,true,false,options({}, {nativeImageMasks:false}));
  assert.equal(merged.images.length,1);assert.equal(merged.ship.texts.length,1);
  const marked=await setup(group('*manual group',[node('TEXT','Baked text')],{effects:[{type:'LAYER_BLUR',visible:true,radius:4}]})).run(true,true,true,false,options());
  assert.equal(marked.images.length,1);assert.equal(marked.ship.texts.length,1);
  console.log('PASS: five independent raster permissions; exact error locations; native artwork; source-preserving complex masks; explicit merge/manual boundaries');
}
check().catch(error=>{console.error(error);process.exitCode=1;});
