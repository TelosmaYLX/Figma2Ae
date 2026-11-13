const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {promisify}=require('node:util');
const {execFile}=require('node:child_process');
const {node,harness}=require('./export-options.cjs');
const {png}=require('./direct-aep.cjs');
const {exportAep}=require('../scripts/export-aep.cjs');
const run=promisify(execFile);
const white=[{type:'SOLID',color:{r:1,g:1,b:1}}];
function at(n,x,y,w,h){
  Object.assign(n,{width:w,height:h,absoluteBoundingBox:{x,y,width:w,height:h},absoluteRenderBounds:{x,y,width:w,height:h},
    absoluteTransform:[[1,0,x],[0,1,y]],fillGeometry:[{data:`M0 0H${w}V${h}H0Z`,windingRule:'NONZERO'}]});return n;
}
function payload(h){
  return h.messages.filter(m=>m.type==='image-chunk'&&m.seq===0).map(m=>({...m.meta,
    data:h.messages.filter(c=>c.type==='image-chunk'&&c.index===m.index).map(c=>c.dataPart).join('')}));
}
async function fixture(){
  const x=100.25,y=80.5,original=png(160,80),maskBytes=png(80,48),points=[];
  const photo=(name,px,py)=>at(node('RECTANGLE',name,{fills:[{type:'IMAGE',imageHash:'original',scaleMode:'FIT'}]}),px,py,80,48);
  const outer=at(node('RECTANGLE','image 381',{isMask:true,maskType:'ALPHA',opacity:.5,
    fills:[{type:'IMAGE',imageHash:'mask',scaleMode:'FIT'}]}),x,y,480,300);
  for(let i=0;i<4;i++){
    const px=x+20+i*100,py=y+100;
    const inner=at(node('RECTANGLE','image 378 '+i,{isMask:true,maskType:i===3?'LUMINANCE':'ALPHA',
      fills:i<2?white:[{type:'IMAGE',imageHash:'mask',scaleMode:'FIT'}]}),px,py,80,48);
    points.push(at(node('GROUP','point '+i,{blendMode:'PASS_THROUGH',children:[inner,photo('image 379 '+i,px,py)]}),px,py,80,48));
  }
  const background=at(node('RECTANGLE','unmasked background',{fills:white}),x,y,480,300);
  const angle=photo('image 383 angle',x+20,y+20);
  const hidden=at(node('RECTANGLE','hidden light',{visible:false,fills:white}),x,y,100,60);
  const next=at(node('RECTANGLE','next mask',{isMask:true,maskType:'ALPHA',fills:white}),x+340,y+210,80,48);
  const kv=at(node('GROUP','KV',{opacity:.8,blendMode:'NORMAL',children:[background,outer,...points,angle,hidden,next,photo('next photo',x+340,y+210)]}),x,y,480,300);
  const root=at(node('FRAME','Nested KV masks',{children:[kv]}),x,y,480,360),h=harness(root),renders=[];
  (function render(n){n.exportAsync=async function(options){
    renders.push({name:n.name,isMask:this.isMask,children:this.children?this.children.filter(c=>c.opacity>0).map(c=>c.name):[]});
    return png(Math.max(1,Math.round(this.width*options.constraint.value)),Math.max(1,Math.round(this.height*options.constraint.value)));
  };if(n.children)n.children.forEach(render);})(root);
  h.figma.getImageByHash=hash=>({getBytesAsync:async()=>hash==='original'?original:maskBytes,
    getSizeAsync:async()=>hash==='original'?{width:160,height:80}:{width:80,height:48}});
  const result=await h.run(true,true,true,false,{nativeImageMasks:true}),packet={...result.ship,images:payload(h)};
  const source=packet.images.find(im=>im.name==='image_381');
  assert.ok(source&&source.maskSource,'The outer KV mask must remain an independent mask source');
  const scope=packet.containers.find(c=>c.maskScope&&c.maskId===source.maskSource);
  assert.ok(scope,'All outer-masked artwork needs one shared precomp');
  assert.equal(scope.name,'image 381 内容');
  const kvContainer=packet.containers.find(c=>c.name==='KV');
  assert.ok(scope.path.includes(kvContainer.id));
  const groups=packet.containers.filter(c=>/^point /.test(c.name));
  assert.equal(groups.length,4);assert.ok(groups.every(c=>c.path.includes(scope.id)&&c.maskId===null));
  const photos=packet.images.filter(im=>/^image_379_|^image_383/.test(im.name));
  assert.equal(photos.length,5);assert.ok(photos.every(im=>im.data===original.toString('base64')&&!im.bicubic&&!im.rasterScale));
  assert.ok(photos.every(im=>im.path.includes(scope.id)));
  assert.ok(photos.filter(im=>/^image_379_/.test(im.name)).every(im=>im.maskId&&im.maskId!==source.maskSource));
  assert.equal(photos.find(im=>/^image_383/.test(im.name)).maskId,null,'Apply the outer matte only on the shared comp');
  assert.equal(packet.nodes.find(n=>n.name==='unmasked background').path.includes(scope.id),false);
  assert.equal(packet.images.find(im=>im.name==='next_photo').path.includes(scope.id),false);
  assert.equal(source.path.includes(scope.id),false);
  assert.equal(packet.nodes.some(n=>n.name==='hidden light'),false);
  assert.ok(!renders.some(r=>/^image 379|image 383|^point |^KV$/.test(r.name)),'Do not flatten photos or mask groups');
  assert.equal(outer.isMask,true);assert.equal(outer.opacity,.5);assert.equal(kv.opacity,.8);
  assert.deepEqual(kv.children.map(n=>n.name),['unmasked background','image 381','point 0','point 1','point 2','point 3','image 383 angle','hidden light','next mask','next photo']);
  await h.run(true,true,true,false,{nativeImageMasks:true,bicubicExport:true});
  assert.ok(payload(h).filter(im=>/^image_379_|^image_383/.test(im.name)).every(im=>!im.bicubic&&im.data===original.toString('base64')));
  hidden.visible=true;
  try{
    const shown=await h.run(true,true,true,false,{nativeImageMasks:true});
    const shownScope=shown.ship.containers.find(c=>c.maskScope&&c.name==='image 381 内容');
    assert.ok(shown.ship.nodes.find(n=>n.name==='hidden light').path.includes(shownScope.id));
  }finally{hidden.visible=false;}
  angle.effects=[{type:'LAYER_BLUR',visible:true,radius:2}];
  angle.absoluteRenderBounds={x:angle.absoluteBoundingBox.x-2,y:angle.absoluteBoundingBox.y-2,width:84,height:52};
  try{
    const local=await h.run(true,true,true,false,{nativeImageMasks:true});
    const localScope=local.ship.containers.find(c=>c.maskScope&&c.name==='image 381 内容');
    const raster=local.images.find(im=>im.name==='image_383_angle');
    assert.ok(raster.rasterScale&&raster.path.includes(localScope.id)&&raster.maskId===null,'Local effect PNGs remain inside the shared outer matte');
    assert.equal(localScope.x,18);assert.equal(localScope.y,18,'The isolated comp must retain effect overflow');
  }finally{angle.effects=[];angle.absoluteRenderBounds={...angle.absoluteBoundingBox};}
  h.figma.currentPage.selection=[kv];
  try{
    const selected=await h.run(true,true,true,false,{nativeImageMasks:true});
    const selectedKV=selected.ship.containers.find(c=>c.name==='KV'&&c.root);
    const selectedScope=selected.ship.containers.find(c=>c.maskScope&&c.name==='image 381 内容');
    assert.deepEqual(selectedScope.path,[selectedKV.id],'Selecting KV itself retains the shared outer precomp');
  }finally{h.figma.currentPage.selection=[root];}
  h.messages.length=0;
  await h.context.exportSelectionSVG(true,false,true,false,true,false,{nativeImageMasks:true});
  assert.match(h.messages.find(m=>m.type==='error').message,/image 381.*预合成/);
  const old=await h.run(true,true,true,false,{nativeImageMasks:false});
  assert.ok(old.images.some(im=>im.rasterScale),'The merged option still renders the full nested scope');
  assert.ok(renders.some(r=>r.name==='KV'&&r.children.includes('image 381')&&r.children.includes('point 0')&&r.children.includes('image 383 angle')));
  return {packet,original};
}
async function check(){
  const {packet}=await fixture(),output=path.resolve(__dirname,'../artifacts/nested-image-masks');
  await fs.mkdir(output,{recursive:true});
  const directory=await fs.mkdtemp(path.join(output,'aep-')),result=await exportAep(packet,directory);
  await fs.writeFile(path.join(output,'packet.json'),JSON.stringify(packet));
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result));
  const assets=path.join(output,'assets');await fs.mkdir(assets,{recursive:true});
  const hostImages=[];
  for(let i=0;i<packet.images.length;i++){
    const {data,bicubic,...meta}=packet.images[i],file=String(i).padStart(4,'0')+'.png';
    await fs.writeFile(path.join(assets,file),Buffer.from(data,'base64'));hostImages.push({...meta,file});
  }
  for(const [name,data] of [['nodes',packet.nodes],['texts',packet.texts],['containers',packet.containers],['images',hostImages]])
    await fs.writeFile(path.join(output,name+'.json'),JSON.stringify(data));
  await fs.writeFile(path.join(output,'job.json'),JSON.stringify({nodesPath:path.join(output,'nodes.json'),textsPath:path.join(output,'texts.json'),
    containersPath:path.join(output,'containers.json'),imagesPath:path.join(output,'images.json'),imageFolder:assets}));
  const python=process.env.F2A_PYTHON||path.resolve(__dirname,'../.venv-aep/Scripts/python.exe');
  const inspected=await run(python,[path.join(__dirname,'check-nested-image-masks.py'),result.project],{windowsHide:true,env:{...process.env,PYTHONUTF8:'1'}});
  console.log(inspected.stdout.trim());
  console.log('PASS: nested KV masks, shared outer precomp, original bytes, four independent inner mattes, mask boundaries and merged mode');
}
if(require.main===module)check().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={fixture};
