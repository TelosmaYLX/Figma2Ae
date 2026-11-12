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
    original.exportAsync=async function(options) {
      events.push('reference');assert.equal(options.format,'PNG');assert.equal(copies.length,0);
      if(failReference)throw new Error('reference failed');return render(options);
    };
    original.clone=function(){
      events.push('clone');if(failClone&&(failClone!==2||copies.length===1))throw new Error('clone failed');
      const copy=clone.call(this);copies.push(copy);
      (function attach(n){
        const exportAsync=n.exportAsync;
        n.exportAsync=async function(options){
          events.push('copy render');
          assert.equal(n.removed,undefined,'Copy must exist throughout rendering');
          if(failPng&&options.format==='PNG')throw new Error('copy PNG failed');
          // The original root's exporter is deliberately read-only, so the clone has
          // its own renderer rather than the test closure bound to that original root.
          if(n===copy)return render(options);
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
    assert.ok(events.lastIndexOf('reference')<events.indexOf('clone'));
    assert.equal(h.messages.some(m=>m.type==='images-done'),!failPng);
  }
}
(async()=>{
  await run();await run({multi:true});await run({failReference:true});await run({failClone:true});await run({multi:true,failClone:2});await run({failPng:true});
  console.log('PASS: untouched originals and ancestors, reference before cloning, multi-selection, hidden references, whole-copy cleanup on success and failures');
})().catch(e=>{console.error(e);process.exitCode=1;});
