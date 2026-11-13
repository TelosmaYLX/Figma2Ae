const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {once}=require('node:events');
const {node,group,harness}=require('./export-options.cjs');
const {png}=require('./direct-aep.cjs');
const {exportAep}=require('../scripts/export-aep.cjs');
const {start}=require('../scripts/aep-server.cjs');
const geometry=[{data:'M0 0H100V60H0Z',windingRule:'NONZERO'}];
const solid=name=>node('RECTANGLE',name,{fills:[{type:'SOLID',color:{r:1,g:1,b:1}}],fillGeometry:geometry});
const blur={type:'LAYER_BLUR',visible:true,radius:5};
const inner={type:'INNER_SHADOW',visible:true,radius:4,offset:{x:0,y:2},color:{r:0,g:0,b:0,a:.5}};
function payload(h){return h.messages.filter(m=>m.type==='image-chunk'&&m.seq===0).map(m=>({...m.meta,
  data:h.messages.filter(c=>c.type==='image-chunk'&&c.index===m.index).map(c=>c.dataPart).join('')}));}
function scene(kind){
  const first=group('shadow',[solid('kept')]);
  const bad=kind==='group'?group('shadow',[solid('blurred'),node('TEXT','inside')],{effects:[blur]}):
    kind==='text'?node('TEXT','shadow',{effects:[inner]}):Object.assign(solid('shadow'),{effects:[blur]});
  const root=node('FRAME','AEP errors',{width:320,height:240,children:[first,bad,solid('outside')]});
  const h=harness(root),bytes=png();
  (function render(n){n.exportAsync=async()=>bytes;if(n.children)n.children.forEach(render);})(root);
  return {first,bad,root,h};
}
async function collect(h,options={},raster=false){const result=await h.run(true,raster,true,false,options);return {...result.ship,images:payload(h)};}
async function check(){
  const output=path.resolve(__dirname,'../artifacts/aep-error-layer');await fs.mkdir(output,{recursive:true});
  const server=start({port:0,quiet:true,chooseDestination:async()=>{throw new Error('Failed validation must not open the picker');}});
  await once(server,'listening');
  try{
    const url='http://127.0.0.1:'+server.address().port+'/export';
    for(const kind of ['group','text','shape']){
      const {first,bad,h}=scene(kind),packet=await collect(h);
      const response=await fetch(url,{method:'POST',body:JSON.stringify({packet})});
      assert.equal(response.status,400);const error=await response.json();
      assert.match(error.error,/shadow.*效果/);assert.equal(error.nodeId,bad.id,kind+' must locate the original node');
      assert.notEqual(error.nodeId,first.id,'Same-named layers must not be resolved by name');
      const repaired=await collect(h,{target:'aep'},true);
      assert.ok(repaired.images.some(im=>im.sourceId===bad.id&&im.rasterScale),'Rasterize only the effect owner for direct AEP');
      assert.ok(repaired.nodes.some(n=>n.name==='outside'));assert.ok(repaired.nodes.some(n=>n.name==='kept'));
      assert.ok(!repaired.containers.some(c=>c.sourceId===bad.id));
      const directory=await fs.mkdtemp(path.join(output,kind+'-'));const result=await exportAep(repaired,directory);
      assert.equal(result.warnings.length,0);
      assert.equal(bad.effects[0].type,kind==='text'?'INNER_SHADOW':'LAYER_BLUR');
      const ae=await collect(h,{},true);
      if(kind==='group')assert.ok(ae.containers.some(c=>c.sourceId===bad.id&&c.blur===5),'AE import keeps its supported native group blur');
      if(kind==='group'){
        const bytes=png(),outer=node('RECTANGLE','outer mask',{isMask:true,maskType:'ALPHA',fills:[{type:'IMAGE',imageHash:'mask',scaleMode:'FIT'}],fillGeometry:geometry});
        outer.exportAsync=async()=>bytes;outer.parent=h.figma.currentPage.selection[0];
        outer.parent.children.unshift(outer);
        first.children[0].fills=[{type:'IMAGE',imageHash:'photo',scaleMode:'FIT'}];
        h.figma.getImageByHash=()=>({getBytesAsync:async()=>bytes,getSizeAsync:async()=>({width:64,height:64})});
        try{
          const masked=await collect(h,{target:'aep',nativeImageMasks:true},true);
          const scope=masked.containers.find(c=>c.maskScope);
          assert.ok(scope&&masked.images.find(im=>im.sourceId===bad.id).path.includes(scope.id));
          const original=masked.images.find(im=>im.sourceId===first.children[0].id);
          assert.ok(original&&!original.rasterScale,'An unsupported sibling effect must not rasterize the original image');
        }finally{outer.parent.children.shift();first.children[0].fills=[{type:'SOLID',color:{r:1,g:1,b:1}}];}
      }
      h.messages.length=0;
      await h.context.exportSelectionSVG(true,true,true,false,false,false,{target:'aep'});
      const preflight=h.messages.find(m=>m.type==='error');assert.equal(preflight.nodeId,bad.id);assert.match(preflight.message,/自动栅格化/);
      if(kind==='shape'){
        const invalid=structuredClone(packet),target=invalid.nodes.find(n=>n.sourceId===bad.id);target.paths=[{d:'unsupported'}];
        const rejected=await fetch(url,{method:'POST',body:JSON.stringify({packet:invalid})});
        assert.equal((await rejected.json()).nodeId,bad.id,'Parser errors retain the same original ID');
      }
    }
    console.log('PASS: real AEP HTTP failures locate original group/text/shape IDs despite duplicate names; AEP-only effect rasterization, preflight, clean originals and parser errors');
  }finally{await new Promise(resolve=>server.close(resolve));}
}
check().catch(error=>{console.error(error);process.exitCode=1;});
