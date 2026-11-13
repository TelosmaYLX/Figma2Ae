const assert = require('node:assert/strict');
const {node, group, harness} = require('./export-options.cjs');
const geometry = [{data:'M0 0H100V60H0Z',windingRule:'NONZERO'}];
const solid = (name, extra={}) => node('RECTANGLE',name,{fillGeometry:geometry,cornerRadius:0,
  fills:[{type:'SOLID',color:{r:.2,g:.4,b:.7}}],...extra});
const image = (name, mode='FILL') => solid(name,{fills:[{type:'IMAGE',imageHash:name,scaleMode:mode}]});
function setup(root) {
  const h=harness(root);
  h.figma.getImageByHash=()=>({getBytesAsync:async()=>Buffer.from([0x89,0x50,0,0]),getSizeAsync:async()=>({width:100,height:60})});
  return h;
}
async function check() {
  // Images already rasterized by the author stay separate, at any nesting/selection boundary.
  for(const mode of ['FILL','FIT','CROP']) {
    const card=group('card',[solid('background'),group('pictures',[image('photo A',mode),image('photo B',mode)]),solid('button')]);
    const h=setup(node('FRAME','page',{children:[card]})),r=await h.run();
    assert.equal(r.images.length,2,mode);
    assert.ok(r.images.every(im=>/photo/.test(im.name)));
    assert.ok(r.ship.nodes.some(n=>n.name==='background'));assert.ok(r.ship.nodes.some(n=>n.name==='button'));
    assert.ok(r.ship.containers.some(c=>c.name==='pictures'));
    h.figma.currentPage.selection=[card];
    const selected=await h.run();assert.equal(selected.images.length,2);
  }
  const boolean=solid('boolean result',{type:'BOOLEAN_OPERATION',children:[solid('operand')]});
  const native=await setup(group('page',[group('card',[solid('background'),boolean,solid('button')])])).run();
  assert.equal(native.images.length,0);assert.deepEqual(native.ship.nodes.map(n=>n.name),['background','boolean result','button']);
  const fallback=await setup(group('page',[group('card',[solid('background'),solid('boolean fallback',{type:'BOOLEAN_OPERATION',fillGeometry:[],children:[solid('operand')]}),solid('button')])])).run();
  assert.deepEqual(fallback.images.map(im=>im.name),['boolean_fallback']);assert.equal(fallback.ship.nodes.length,2);

  const mask=solid('simple mask',{isMask:true}),masked=group('masked',[mask,solid('masked shape'),node('TEXT','masked text')]);
  const editable=await setup(group('page',[solid('outside'),masked,solid('button')])).run();
  assert.equal(editable.images.length,0);assert.equal(editable.ship.texts.length,1);
  const source=editable.ship.nodes.find(n=>n.name==='simple mask');
  assert.equal(source.maskSource,source.id);assert.equal(editable.ship.texts[0].maskId,source.id);
  assert.equal(editable.ship.nodes.find(n=>n.name==='masked shape').maskId,source.id);
  assert.equal(editable.ship.nodes.find(n=>n.name==='outside').maskId,null);
  const grouped=await setup(group('page',[group('mask scope',[solid('mask',{isMask:true,opacity:.5}),
    group('editable content',[solid('overlap A'),solid('overlap B')],{opacity:.6})])])).run();
  const groupMask=grouped.ship.nodes.find(n=>n.name==='mask');
  assert.equal(grouped.ship.containers.find(c=>c.name==='editable content').maskId,groupMask.id);
  assert.ok(grouped.ship.nodes.filter(n=>/^overlap/.test(n.name)).every(n=>n.maskId===null));
  const frame=solid('masked frame',{type:'FRAME',opacity:.6,blendMode:'MULTIPLY',children:[solid('frame content')]});
  const framed=await setup(group('page',[solid('frame mask',{isMask:true}),frame])).run();
  const frameContainer=framed.ship.containers.find(c=>c.name==='masked frame');
  const framePaint=framed.ship.nodes.find(n=>n.name==='masked frame');
  assert.ok(frameContainer.maskId);assert.equal(framePaint.maskId,null);assert.equal(framePaint.opacity,1);assert.equal(framePaint.blend,'NORMAL');
  const paintedFrame=image('frame photo');paintedFrame.type='FRAME';paintedFrame.children=[];paintedFrame.opacity=.6;
  const withPhoto=await setup(group('page',[solid('photo mask',{isMask:true}),paintedFrame])).run();
  const photoContainer=withPhoto.ship.containers.find(c=>c.name==='frame photo');
  assert.ok(photoContainer.maskId);assert.equal(withPhoto.images[0].maskId,null);assert.equal(withPhoto.images[0].opacity,1);
  assert.ok(withPhoto.images[0].path.includes(photoContainer.id));

  // Two unsupported mask scopes share a parent with its own fill, effect and opacity.
  // Each PNG must exclude every sibling and the parent's styling, without changing layout.
  const gradient=()=>solid('gradient mask',{isMask:true,fills:[{type:'GRADIENT_LINEAR',gradientStops:[{position:0,color:{r:1,g:1,b:1,a:0}},{position:1,color:{r:1,g:1,b:1,a:1}}]}]});
  const m1=gradient(),m2=gradient(),scopes=[m1,node('TEXT','inside A'),m2,node('TEXT','inside B')];
  const clip=node('FRAME','clip boundary',{clipsContent:true,children:[solid('clip artwork')]}),outside=solid('outside mask');
  const container=node('FRAME','parent',{opacity:.6,effects:[{type:'LAYER_BLUR',visible:true,radius:3}],
    fills:[{type:'SOLID',color:{r:1,g:0,b:0}}],children:[solid('before masks'),...scopes,clip,outside]});
  const h=setup(group('page',[container]));const snapshots=[];
  container.exportAsync=async function(options) {
    snapshots.push({names:this.children.filter(n=>n.opacity>0).map(n=>n.name),masks:this.children.filter(n=>n.isMask).map(n=>n.name),
      opacity:this.opacity,fills:this.fills.length,effects:this.effects.length});
    return Buffer.alloc(24);
  };
  const raster=await h.run();
  assert.equal(raster.images.length,2);assert.equal(raster.ship.texts.length,0);
  assert.ok(raster.ship.nodes.some(n=>n.name==='before masks'));assert.ok(raster.ship.nodes.some(n=>n.name==='outside mask'));
  assert.deepEqual(snapshots.map(s=>s.names),[['gradient mask','inside A'],['gradient mask','inside B']]);
  assert.ok(snapshots.every(s=>s.masks.length===1&&s.opacity===1&&s.fills===0&&s.effects===0));
  const parent=raster.ship.containers.find(c=>c.name==='parent');
  assert.ok(raster.images.every(im=>im.path.includes(parent.id)&&im.opacity===1));
  assert.equal(container.opacity,.6);assert.equal(container.effects.length,1);assert.equal(container.fills.length,1);
  assert.ok(scopes.every(n=>n.opacity===1));assert.ok(m1.isMask&&m2.isMask);
  assert.equal(raster.ship.nodes.find(n=>n.name==='outside mask').maskId,null);
  container.exportAsync=async()=>{throw new Error('scoped render failed');};
  await h.context.exportSelectionSVG(true,true,true,false,true,false,{});
  assert.match(h.messages.find(m=>m.type==='error').message,/gradient mask.*scoped render failed/);
  assert.equal(container.opacity,.6);assert.equal(container.effects.length,1);assert.ok(m1.isMask&&m2.isMask);

  const drop={type:'DROP_SHADOW',visible:true,radius:4,offset:{x:0,y:2},color:{r:0,g:0,b:0,a:.5}};
  const shadow=await setup(group('page',[group('card',[solid('background'),solid('shadowed',{effects:[drop]}),solid('button')])])).run();
  assert.equal(shadow.images.length,1);assert.ok(shadow.images[0].shadow);assert.equal(shadow.ship.nodes.length,3);

  // Background blur stays on its own PNG. Keep the copied backdrop and unrelated foreground
  // intact while Figma renders the node, without merging them into the exported image layer.
  const blurred=solid('底框',{effects:[{type:'BACKGROUND_BLUR',visible:true,radius:8},drop]});
  const blurScene=group('page',[image('background photo'),group('card',[solid('card background'),blurred,node('TEXT','editable title'),solid('button')])]);
  const blurHost=setup(blurScene),blurRenders=[];
  blurred.exportAsync=async function(options){
    assert.equal(options.format,'PNG');assert.equal(options.constraint.value,1);
    assert.equal(this.effects.length,2,'Figma receives both effects unchanged');
    assert.ok(this.parent.children.some(n=>n.name==='card background'&&n.opacity===1));
    assert.ok(this.parent.children.some(n=>n.name==='editable title'&&n.opacity===1));
    blurRenders.push(this.id);return Buffer.alloc(24);
  };
  const blurResult=await blurHost.run();
  assert.equal(blurResult.images.length,2);assert.equal(blurResult.images.filter(im=>im.sourceId===blurred.id).length,1);
  assert.equal(blurResult.images.filter(im=>im.shadow).length,0,'The PNG already contains its drop shadow');
  assert.equal(blurResult.ship.texts.length,1);assert.equal(blurResult.ship.texts[0].characters,'Editable text');
  assert.deepEqual(blurResult.ship.nodes.map(n=>n.name),['background photo','card background','button']);
  assert.ok(blurResult.ship.containers.some(c=>c.name==='card'));assert.equal(blurRenders.length,1);
  assert.equal(blurred.effects.length,2);assert.ok(blurScene.children.every(n=>n.opacity===1));
  await blurHost.context.exportSelectionSVG(true,true,true,false,false,false,{});
  const disabled=blurHost.messages.find(m=>m.type==='error');assert.match(disabled.message,/底框.*开启自动栅格化/);assert.equal(disabled.nodeId,blurred.id);

  const failed=setup(group('page',[group('*broken PNG',[solid('art')]),solid('button')]));
  failed.figma.currentPage.selection[0].children[0].exportAsync=async()=>{throw new Error('renderer failed');};
  await failed.context.exportSelectionSVG(true,true,true,false,true,false,{});
  assert.match(failed.messages.find(m=>m.type==='error').message,/broken_PNG.*renderer failed/);
  assert.equal(failed.messages.some(m=>m.type==='images-done'),false);assert.equal(failed.context._exporting,false);
  for(const [art,reason] of [
    [solid('missing photo',{fills:[{type:'IMAGE',imageHash:null}]}),/missing photo.*素材缺失/],
    [group('unsupported group',[solid('child')],{effects:[{type:'GLASS',visible:true}]}),/unsupported group.*不支持的效果/],
    [solid('empty mask',{isMask:true}),/empty mask.*没有被遮罩/]
  ]){
    const invalid=setup(group('page',[art]));await invalid.context.exportSelectionSVG(true,true,true,false,true,false,{});
    assert.match(invalid.messages.find(m=>m.type==='error').message,reason);assert.equal(invalid.messages.some(m=>m.type==='ship'),false);
  }
  console.log('PASS: independent bitmaps; native/fallback booleans; native/scoped masks; clipping boundaries; parent styling; editable shadows; named PNG failures');
}
check().catch(error=>{console.error(error);process.exitCode=1;});
