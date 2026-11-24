const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {node,harness}=require('./export-options.cjs');
const {png}=require('./direct-aep.cjs');
const {exportAep}=require('../scripts/export-aep.cjs');
const {normalize}=require('../scripts/aep/packet.cjs');
const run=promisify(execFile);
const solid=[{type:'SOLID',color:{r:1,g:1,b:1}}];
function at(n,x,y,w=80,h=48){
  Object.assign(n,{width:w,height:h,absoluteBoundingBox:{x,y,width:w,height:h},absoluteRenderBounds:{x,y,width:w,height:h},absoluteTransform:[[1,0,x],[0,1,y]]});
  n.fillGeometry=[{data:`M0 0H${w}V${h}H0Z`,windingRule:'NONZERO'}];return n;
}
async function checkAutoLayoutMask() {
  const imageFill = [{type: 'IMAGE', imageHash: 'swatch', scaleMode: 'FILL'}];
  const mask = at(node('RECTANGLE', 'Swatch mask', {maskType: 'ALPHA', fills: imageFill, maskEnabled: true}), 44.5, 80.25);
  const photo = at(node('RECTANGLE', 'Swatch photo', {fills: imageFill}), 44.5, 80.25);
  const dim = at(node('RECTANGLE', 'Dim swatch', {fills: solid, opacity: .3}), 32, -38, 120, 284);
  const swatch = at(node('GROUP', 'Swatch', {children: [mask, photo, dim]}), 44.5, 80.25);
  const row = at(node('FRAME', 'Swatch row', {layoutMode: 'HORIZONTAL', children: [swatch]}), 44.5, 80.25);
  const h = harness(at(node('FRAME', 'Page', {children: [row]}), 20, 30, 200, 200));
  Object.defineProperty(mask, 'isMask', {
    get() { return this.maskEnabled; },
    set(value) {
      this.maskEnabled = value;
      if (!value && this.parent.parent?.layoutMode === 'HORIZONTAL') {
        // Figma grows the group to include the dim overlay and recenters it in the row.
        const [horizontal, vertical] = this.absoluteTransform;
        this.absoluteTransform = [horizontal, [vertical[0], vertical[1], vertical[2] + 118]];
        this.absoluteBoundingBox = {...this.absoluteBoundingBox, y: this.absoluteBoundingBox.y + 118};
        this.absoluteRenderBounds = {...this.absoluteRenderBounds, y: this.absoluteRenderBounds.y + 118};
      }
    },
  });
  const collection = {id: 'palette'};
  Object.defineProperty(mask, 'resolvedVariableModes', {
    get() { return {palette: this.mode || (this.parent?.parent?.layoutMode === 'HORIZONTAL' ? 'dim' : 'default')}; },
  });
  mask.setExplicitVariableModeForCollection = function (requested, mode) {
    assert.equal(requested, collection);
    this.mode = mode;
  };
  h.figma.variables = {getVariableCollectionByIdAsync: async id => id === collection.id ? collection : null};
  const pixels = png(80, 48);
  mask.exportAsync = async function () {
    assert.deepEqual(this.children[0].resolvedVariableModes, {palette: 'dim'});
    return png(Math.round(this.width), Math.round(this.height));
  };
  h.figma.getImageByHash = () => ({getBytesAsync: async () => pixels, getSizeAsync: async () => ({width: 80, height: 48})});

  const {ship, images} = await h.run(true, true, true, false, {nativeImageMasks: true, precompLayers: true});
  const matte = images.find(image => image.maskSource);
  assert.deepEqual([matte.x, matte.y, matte.w, matte.h], [24, 50, 81, 49], 'The alpha mask stays on the pattern when rendered on the pixel grid');
  assert.ok(ship.containers.some(container => container.maskScope && container.maskId === matte.maskSource));
  assert.equal(mask.isMask, true);
  assert.equal(mask.absoluteTransform[1][2], 80.25);
}
async function fixture(){
  const scopes=[],original=png(160,80),maskBytes=png(80,48);
  const cases=[['Vector','vector','FIT'],['Bitmap','ALPHA','FIT'],['Luma','LUMINANCE','FILL'],['Cropped','vector','CROP'],['Grouped','ALPHA','CROP']];
  for(let i=0;i<cases.length;i++){
    const [label,kind,mode]=cases[i],x=120+(i%2)*200,y=100+Math.floor(i/2)*120;
    const mask=at(node('RECTANGLE',label+' mask',{isMask:true,maskType:kind==='vector'?'ALPHA':kind,
      fills:kind==='vector'?solid:[{type:'IMAGE',imageHash:'mask',scaleMode:'FIT'}]}),x,y);
    const image=at(node('RECTANGLE',label+' photo',{cornerRadius:mode==='CROP'?8:0,
      fills:[{type:'IMAGE',imageHash:'original',scaleMode:mode,...(mode==='CROP'?{imageTransform:[[.5,0,.125],[0,.6,.15]]}:{})}]}),x,y);
    const content=label==='Grouped'?at(node('GROUP','Grouped content',{blendMode:'PASS_THROUGH',children:[image]}),x,y):image;
    const children=[mask,content];
    if(label==='Bitmap')children.push(at(node('TEXT','Masked label',{characters:'Masked',fills:solid}),x+5,y+5,60,20));
    scopes.push(at(node('GROUP',label+' scope',{blendMode:'PASS_THROUGH',children}),x,y));
  }
  const root=at(node('FRAME','Native image masks',{children:scopes}),100,80,480,420),h=harness(root),renders=[];
  (function render(n){n.exportAsync=async function(options){
    renders.push({name:n.name,isMask:this.isMask,scale:options.constraint.value});
    if(this.isMask===false&&n.name.includes('mask'))return maskBytes;
    return png(Math.round(this.width*options.constraint.value),Math.round(this.height*options.constraint.value));
  };if(n.children)n.children.forEach(render);})(root);
  h.figma.getImageByHash=hash=>({getBytesAsync:async()=>hash==='original'?original:maskBytes,getSizeAsync:async()=>hash==='original'?{width:160,height:80}:{width:80,height:48}});
  const collected=await h.run(true,true,true,false,{nativeImageMasks:true});
  const images=h.messages.filter(m=>m.type==='image-chunk'&&m.seq===0).map(m=>({...m.meta,
    data:h.messages.filter(c=>c.type==='image-chunk'&&c.index===m.index).map(c=>c.dataPart).join('')}));
  const photos=images.filter(im=>im.name.endsWith('_photo')),sources=images.filter(im=>im.maskSource);
  assert.equal(photos.length,5);assert.equal(sources.length,3);assert.equal(collected.ship.texts.length,1);
  assert.ok(photos.every(im=>im.data===original.toString('base64')&&im.rasterScale===null&&!im.bicubic),'Keep exact source bytes for every independent picture');
  assert.ok(photos.filter(im=>!['Grouped_photo','Bitmap_photo'].includes(im.name)).every(im=>im.maskId));
  const shared=collected.ship.containers.find(c=>c.maskScope&&c.name==='Bitmap mask 内容');
  assert.ok(shared&&photos.find(im=>im.name==='Bitmap_photo').path.includes(shared.id));
  assert.equal(collected.ship.texts[0].maskId,null);assert.ok(collected.ship.texts[0].path.includes(shared.id));
  assert.deepEqual(sources.map(im=>im.maskType).sort(),['ALPHA','ALPHA','LUMINANCE']);
  assert.ok(sources.every(im=>im.data===maskBytes.toString('base64')&&!im.maskId));
  assert.ok(collected.ship.nodes.filter(n=>n.maskSource).every(n=>n.name.includes('Vector')||n.name.includes('Cropped')));
  const crop=photos.find(im=>im.name==='Cropped_photo');
  assert.deepEqual(crop.imageMatrix,[160,0,0,80,200,128]);
  assert.ok(crop.matte&&crop.matte.r===8);
  assert.ok(renders.every(render=>!render.name.endsWith('photo')),'Photos must not be re-rendered');
  assert.ok(scopes.every(scope=>scope.children[0].isMask===true),'Keep original Figma masks unchanged');
  const packet={...collected.ship,images};
  const bicubic=await h.run(true,true,true,false,{nativeImageMasks:true,bicubicExport:true});
  assert.ok(bicubic.images.filter(im=>im.name.endsWith('_photo')).every(im=>!im.bicubic));
  assert.ok(bicubic.images.filter(im=>im.maskSource).every(im=>im.bicubic));
  const again=await h.run(true,true,true,false,{nativeImageMasks:false});
  assert.equal(again.images.length,5);assert.ok(again.images.every(im=>im.rasterScale&&!im.maskSource),'Option off restores merged scope PNGs');
  const independent=harness(root);independent.figma.getImageByHash=h.figma.getImageByHash;
  await independent.run(true,false,true,false,{nativeImageMasks:true});
  return {packet,original};
}
async function check(){
  await checkAutoLayoutMask();
  const {packet,original}=await fixture(),output=path.resolve(__dirname,'../artifacts/native-image-masks');
  await fs.mkdir(output,{recursive:true});
  const directory=await fs.mkdtemp(path.join(output,'aep-')),result=await exportAep(packet,directory);
  const model=normalize(packet);
  const images=packet.images;
  for(let i=0;i<images.length;i++)if(images[i].name.endsWith('_photo'))assert.deepEqual(await fs.readFile(path.join(directory,'Assets',String(i).padStart(4,'0')+'.png')),original);
  await fs.writeFile(path.join(output,'packet.json'),JSON.stringify(packet));
  await fs.writeFile(path.join(output,'model.json'),JSON.stringify(model));
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result));
  const assets=path.join(output,'assets');await fs.mkdir(assets,{recursive:true});
  const hostImages=[];
  for(let i=0;i<packet.images.length;i++){
    const {data,...meta}=packet.images[i],file=String(i).padStart(4,'0')+'.png';
    await fs.writeFile(path.join(assets,file),Buffer.from(data,'base64'));hostImages.push({...meta,file});
  }
  for(const [name,data] of [['nodes',packet.nodes],['texts',packet.texts],['containers',packet.containers],['images',hostImages]])
    await fs.writeFile(path.join(output,name+'.json'),JSON.stringify(data));
  await fs.writeFile(path.join(output,'job.json'),JSON.stringify({nodesPath:path.join(output,'nodes.json'),textsPath:path.join(output,'texts.json'),
    containersPath:path.join(output,'containers.json'),imagesPath:path.join(output,'images.json'),imageFolder:assets}));
  const python=process.env.F2A_PYTHON||path.resolve(__dirname,'../.venv-aep/Scripts/python.exe');
  const inspected=await run(python,[path.join(__dirname,'check-native-image-masks.py'),result.project],{windowsHide:true,env:{...process.env,PYTHONUTF8:'1'}});
  console.log(inspected.stdout.trim());
  console.log('PASS: actual exporter with simulated Figma → real AEP; original image bytes, independent alpha/luma/vector masks, crop + external matte, masked text, off/reset and auto-raster off');
}
if(require.main===module)check().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={fixture};
