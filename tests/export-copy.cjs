const assert=require('node:assert/strict');
const {node,group,harness}=require('./export-options.cjs');

function protect(n) {
  for(const key of ['opacity','visible','fills','clipsContent','name']) {
    const value=n[key];
    Object.defineProperty(n,key,{enumerable:true,configurable:true,get(){return value;},set(next){
      assert.notEqual(this,n,'Export attempted to write original '+key);
      Object.defineProperty(this,key,{value:next,enumerable:true,configurable:true,writable:true});
    }});
  }
  if(n.children)n.children.forEach(protect);
}
async function run({failReference=false,failClone=false,failPng=false,multi=false}={}) {
  const marked=group('*raster',[node('TEXT','baked text')]);
  const scene=node('FRAME','original',{children:[marked,node('TEXT','live text')],clipsContent:true});
  const other=node('FRAME','other',{children:[node('TEXT','other text')]});
  const ancestor=node('FRAME','original ancestor',{children:[scene,other],clipsContent:true});
  const h=harness(ancestor),events=[],copies=[],workspaces=[];
  const originalSelection=multi?[scene,other]:[scene];h.figma.currentPage.selection=originalSelection;
  for(const original of originalSelection) {
    const render=original.exportAsync,clone=original.clone;
    original.exportAsync=async()=>{throw new Error('The guide must render in the export workspace');};
    original.clone=function(){
      events.push('clone');if(failClone&&(failClone!==2||copies.length===1))throw new Error('clone failed');
      const copy=clone.call(this);copies.push(copy);
      (function attach(n){
        const exportAsync=n.exportAsync;
        n.exportAsync=async function(options){
          assert.equal(n.removed,undefined,'Copy must exist throughout rendering');
          if(n===copy){
            events.push('reference');
            assert.equal(options.format,'PNG');
            assert.equal(n.parent.name,'F2A 临时导出');
            assert.equal(n.clipsContent,original.clipsContent);
            if(failReference)throw new Error('reference failed');
            return render(options);
          }
          events.push('copy render');
          if(failPng&&options.format==='PNG')throw new Error('copy PNG failed');
          return exportAsync.call(n,options);
        };
        if(n.children)n.children.forEach(attach);
      })(copy);
      return copy;
    };
  }
  protect(ancestor);
  const createFrame=h.figma.createFrame;
  h.figma.createFrame=()=>{const f=createFrame();workspaces.push(f);return f;};
  await h.context.exportSelectionSVG(true,true,true,false,true,true,{enableClip:false});
  const error=h.messages.find(m=>m.type==='error');
  if(failReference||failClone||failPng)assert.ok(error);else assert.equal(error,undefined,error?.message);
  assert.deepEqual(h.figma.currentPage.selection,originalSelection);
  assert.equal(scene.parent,ancestor);assert.equal(other.parent,ancestor);
  assert.equal(ancestor.clipsContent,true);assert.equal(scene.clipsContent,true);
  assert.deepEqual(ancestor.children,[scene,other]);
  assert.ok(workspaces.every(n=>n.removed));assert.ok(copies.every(n=>n.removed));
  assert.equal(h.context._exporting,false);
  if(!failReference&&!failClone) {
    const chunks=h.messages.filter(m=>m.type==='image-chunk'&&m.seq===0);
    const refs=chunks.filter(m=>m.meta.reference);
    assert.equal(refs.length,failPng?0:originalSelection.length);assert.ok(refs.every(r=>r.meta.hidden&&r.meta.path.length===0));
    assert.equal(events.filter(e=>e==='reference').length,originalSelection.length);
    assert.ok(events.lastIndexOf('clone')<events.indexOf('reference'));
    if(events.includes('copy render'))assert.ok(events.lastIndexOf('reference')<events.indexOf('copy render'));
    assert.equal(h.messages.some(m=>m.type==='images-done'),!failPng);
  }
}
async function checkFractionalReference() {
  const box = {x:14788,y:3453,width:569.08,height:341.85};
  const geometry = {width:box.width,height:box.height,absoluteBoundingBox:box,
    absoluteRenderBounds:box,absoluteTransform:[[1,0,box.x],[0,1,box.y]]};
  const baked = group('*Raster', [node('RECTANGLE','Artwork',geometry)], geometry);
  const frame = node('FRAME','Photo',{...geometry,children:[baked],clipsContent:true});
  const parent = node('FRAME','Clipping parent',{children:[frame],clipsContent:true});
  Object.defineProperty(frame,'absoluteRenderBounds',{enumerable:true,get(){
    return this.parent===parent ? {...box,height:box.height-42} : box;
  }});
  const h = harness(parent);
  h.figma.currentPage.selection = [frame];
  const createFrame = h.figma.createFrame;
  h.figma.createFrame = () => {
    const canvas = createFrame();
    const render = canvas.exportAsync;
    canvas.exportAsync = function (options) {
      if (!options.useAbsoluteBounds) return render.call(this, options);
      const bytes = Buffer.alloc(25);
      bytes[0] = 0x89; bytes[1] = 0x50;
      bytes.writeUInt32BE(this.width * options.constraint.value,16);
      bytes.writeUInt32BE(this.height * options.constraint.value,20);
      return bytes;
    };
    return canvas;
  };
  const {images, references} = await h.run(true,true,true,false,{target:'aep'});
  assert.equal(images.length,1);
  assert.equal(references.length,1);
  const placement = im => [im.x,im.y,im.w,im.h,im.cx,im.cy,im.natW,im.natH];
  assert.deepEqual(placement(images[0]),[0,0,570,342,285,171,570,342]);
  assert.deepEqual(placement(references[0]),placement(images[0]));
}
(async()=>{
  await run();await run({multi:true});await run({failReference:true});await run({failClone:true});await run({multi:true,failClone:2});await run({failPng:true});
  await checkFractionalReference();
  console.log('PASS: untouched originals, references share the artwork scope and pixel grid, multi-selection and cleanup');
})().catch(e=>{console.error(e);process.exitCode=1;});
