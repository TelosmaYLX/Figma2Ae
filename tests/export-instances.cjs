const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {node,harness}=require('./export-options.cjs');
const {png}=require('./direct-aep.cjs');
const {exportAep}=require('../scripts/export-aep.cjs');
const geometry=[{data:'M0 0H100V60H0Z',windingRule:'NONZERO'}];
function state(n){return {id:n.id,type:n.type,name:n.name,visible:n.visible,opacity:n.opacity,isMask:n.isMask,
  fills:n.fills,effects:n.effects,clipsContent:n.clipsContent,transform:n.absoluteTransform,bounds:n.absoluteBoundingBox,
  parent:n.parent?.id,children:n.children?.map(state)};}
function payload(h){return h.messages.filter(m=>m.type==='image-chunk'&&m.seq===0).map(m=>({...m.meta,
  data:h.messages.filter(c=>c.type==='image-chunk'&&c.index===m.index).map(c=>c.dataPart).join('')}));}
function setup(){
  const mask=node('RECTANGLE','image 378',{isMask:true,maskType:'ALPHA',fills:[{type:'IMAGE',imageHash:'mask',scaleMode:'FIT'}],fillGeometry:geometry});
  const photo=node('RECTANGLE','image 379',{fills:[{type:'IMAGE',imageHash:'photo',scaleMode:'FIT'}],fillGeometry:geometry});
  const text=node('TEXT','live text',{characters:'Instance override',fills:[{type:'SOLID',color:{r:1,g:1,b:1}}]});
  const inner=node('INSTANCE','Repeated',{children:[mask,photo,text],clipsContent:true,opacity:.8});
  const other=node('INSTANCE','Repeated',{children:[node('RECTANGLE','unmasked',{fills:[{type:'SOLID',color:{r:1,g:0,b:0}}],fillGeometry:geometry})]});
  const instance=node('INSTANCE','Root instance',{children:[inner,other],clipsContent:true,width:320,height:240,
    absoluteBoundingBox:{x:20,y:30,width:320,height:240},absoluteRenderBounds:{x:20,y:30,width:320,height:240}});
  const root=node('FRAME','Instance scene',{children:[instance]}),h=harness(root),original=png(160,80),render=png(100,60),detached=[],copies=[],workspaces=[];
  Object.defineProperty(mask,'isMask',{enumerable:true,configurable:true,get(){return true;},set(value){
    assert.notEqual(this,mask,'Do not write the original mask');
    for(let p=this.parent;p;p=p.parent)if(p.type==='INSTANCE')throw new Error('in set_isMask: This property cannot be overridden in an instance: is-mask');
    Object.defineProperty(this,'isMask',{value,writable:true,enumerable:true,configurable:true});
  }});
  for(const originalInstance of [instance,inner,other]){
    const detach=originalInstance.detachInstance;
    originalInstance.detachInstance=function(){
      assert.notEqual(this,originalInstance,'Do not detach the original instance');
      for(let p=this.parent;p;p=p.parent)assert.notEqual(p.type,'INSTANCE','Detach the outer instance before its descendants');
      detached.push({name:this.name,id:this.id});return detach.call(this);
    };
  }
  (function renderNode(n){n.exportAsync=async()=>render;if(n.children)n.children.forEach(renderNode);})(root);
  const clone=root.clone;root.clone=function(){const copy=clone.call(this);copies.push(copy);return copy;};
  const createFrame=h.figma.createFrame;h.figma.createFrame=()=>{const frame=createFrame();workspaces.push(frame);return frame;};
  h.figma.getImageByHash=hash=>({getBytesAsync:async()=>hash==='photo'?original:render,getSizeAsync:async()=>hash==='photo'?{width:160,height:80}:{width:100,height:60}});
  return {root,instance,inner,other,mask,photo,text,h,original,detached,copies,workspaces};
}
async function fixture(){
  const f=setup(),{root,instance,inner,mask,photo,text,h}=f,before=state(root);
  const result=await h.run(true,true,true,false,{target:'aep',nativeImageMasks:true}),packet={...result.ship,images:payload(h)};
  assert.equal(f.detached.length,3);assert.equal(f.detached[0].name,'Root instance');
  assert.deepEqual(state(root),before);assert.deepEqual(h.figma.currentPage.selection,[root]);
  assert.equal(h.calls.undo,0);
  assert.ok(f.copies.every(n=>n.removed)&&f.workspaces.every(n=>n.removed));
  assert.ok(packet.containers.some(c=>c.sourceId===instance.id&&c.type==='FRAME'));
  assert.ok(packet.containers.some(c=>c.sourceId===inner.id&&c.opacity===.8&&c.clip));
  const source=packet.images.find(im=>im.maskSource);assert.equal(source.sourceId,mask.id);
  assert.equal(packet.images.find(im=>im.sourceId===photo.id).data,f.original.toString('base64'));
  assert.equal(packet.texts.find(t=>t.sourceId===text.id).characters,'Instance override');
  assert.ok(packet.containers.some(c=>c.maskScope&&c.maskId===source.maskSource));
  for(const options of [{rasterInstances:true},{rasterInstances:true,enableClip:false},{rasterAllGroups:true}]){
    const selected=options.rasterAllGroups?root:instance;
    if(selected===root)root.type='GROUP';
    h.figma.currentPage.selection=[selected];
    const raster=await h.run(true,true,true,false,{...options,nativeImageMasks:true,target:'aep'});
    assert.equal(raster.images.length,1);assert.ok(raster.images[0].rasterScale);assert.equal(raster.ship.texts.length,0);
    assert.equal(raster.images[0].sourceId,selected.id);
    if(selected===root)root.type='FRAME';
  }
  h.figma.currentPage.selection=[inner];
  const selected=await h.run(true,true,true,false,{nativeImageMasks:true});
  assert.ok(selected.ship.containers.some(c=>c.root&&c.sourceId===inner.id));
  assert.equal(instance.type,'INSTANCE');assert.equal(inner.type,'INSTANCE');
  assert.equal(Object.keys(h.context._exportSourceIds).length,0);
  assert.equal(Object.keys(h.context._exportInstanceNodes).length,0);
  const failed=setup();
  failed.other.detachInstance=function(){assert.notEqual(this,failed.other);throw new Error('forced detach failure');};
  const failedState=state(failed.root);
  failed.h.figma.currentPage.selection=[failed.instance];
  await failed.h.context.exportSelectionSVG(true,true,true,false,true,false,{nativeImageMasks:true});
  const error=failed.h.messages.find(m=>m.type==='error');assert.match(error.message,/分离.*forced detach failure/);assert.equal(error.nodeId,failed.other.id);
  assert.notEqual(error.nodeId,failed.inner.id,'Same-named instances must retain distinct original IDs');
  assert.ok(failed.workspaces.every(n=>n.removed));assert.deepEqual(state(failed.root),failedState);
  assert.deepEqual(failed.h.figma.currentPage.selection,[failed.instance]);
  const later=setup();later.photo.fills=[{type:'IMAGE',imageHash:null,scaleMode:'FIT'}];
  const laterState=state(later.root);
  await later.h.context.exportSelectionSVG(true,true,true,false,true,false,{nativeImageMasks:true});
  const afterDetach=later.h.messages.find(m=>m.type==='error');
  assert.match(afterDetach.message,/图片素材缺失/);assert.equal(afterDetach.nodeId,later.photo.id);
  assert.deepEqual(state(later.root),laterState);assert.ok(later.workspaces.every(n=>n.removed));
  const maskInstance=node('INSTANCE','Mask instance',{isMask:true,maskType:'ALPHA',children:[node('RECTANGLE','mask geometry',{fillGeometry:geometry,fills:[{type:'SOLID',color:{r:1,g:1,b:1}}]})]});
  const artwork=node('INSTANCE','Raster content',{children:[node('RECTANGLE','raw photo',{fillGeometry:geometry,fills:[{type:'IMAGE',imageHash:'photo',scaleMode:'FIT'}]})]});
  const maskRoot=node('FRAME','Instance mask scope',{children:[maskInstance,artwork]}),maskHarness=harness(maskRoot),bytes=png(100,60);
  Object.defineProperty(maskInstance,'isMask',{enumerable:true,configurable:true,get(){return true;},set(value){
    if(this.type==='INSTANCE')throw new Error('in set_isMask: This property cannot be overridden in an instance: is-mask');
    Object.defineProperty(this,'isMask',{value,writable:true,enumerable:true,configurable:true});
  }});
  (function render(n){n.exportAsync=async()=>bytes;if(n.children)n.children.forEach(render);})(maskRoot);
  maskHarness.figma.getImageByHash=()=>({getBytesAsync:async()=>bytes,getSizeAsync:async()=>({width:100,height:60})});
  const sourceRaster=await maskHarness.run(true,true,true,false,{nativeImageMasks:true,rasterInstances:true});
  assert.equal(sourceRaster.images.filter(im=>!im.maskSource).length,1);
  assert.ok(sourceRaster.images.find(im=>im.maskSource&&im.sourceId===maskInstance.id));
  assert.equal(maskInstance.type,'INSTANCE');assert.equal(maskInstance.isMask,true);
  return {packet};
}
async function check(){
  const {packet}=await fixture(),output=path.resolve(__dirname,'../artifacts/export-instances');
  await fs.mkdir(output,{recursive:true});const directory=await fs.mkdtemp(path.join(output,'aep-'));
  const result=await exportAep(packet,directory);assert.equal(result.counts.texts,1);assert.equal(result.warnings.length,0);
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify({passed:true,simulatedFigma:true,...result},null,2));
  console.log('PASS: locked instance masks, outer-first nested detach, original IDs/content, independent masks, raw images, raster options, selected nested instances, original/selection preservation and failed-detach cleanup; real AEP generation');
}
if(require.main===module)check().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={fixture};
