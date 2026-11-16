const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {node, group, harness} = require('./export-options.cjs');
const {png} = require('./direct-aep.cjs');
const {exportAep} = require('../scripts/export-aep.cjs');
const white = [{type:'SOLID',color:{r:1,g:1,b:1}}];
const rect = (name, extra={}) => node('RECTANGLE',name,{fills:white,cornerRadius:0,
  fillGeometry:[{data:'M0 0H100V60H0Z',windingRule:'NONZERO'}],...extra});
const bitmapMask = name => rect(name,{isMask:true,maskType:'ALPHA',fills:[{type:'IMAGE',imageHash:'mask',scaleMode:'FIT'}]});
async function fixture() {
  const photo = (name,blendMode) => rect(name,{blendMode,fills:[{type:'IMAGE',imageHash:'photo',scaleMode:'FIT',opacity:.8}]});
  const root = group('Card',[
    rect('Blue backdrop'),
    group('Texture',[bitmapMask('Outer mask'),rect('Texture burn',{blendMode:'COLOR_BURN',opacity:.2}),
      group('KV',[bitmapMask('Inner mask'),photo('Building 630','LINEAR_BURN'),photo('Building 633','COLOR_BURN'),rect('Tint')])])
  ]);
  const h = harness(root), pixels = png(100,60);
  h.figma.getImageByHash = () => ({getBytesAsync:async()=>pixels,getSizeAsync:async()=>({width:100,height:60})});
  (function renders(n){n.exportAsync=async()=>pixels;if(n.children)n.children.forEach(renders);})(root);
  const result=await h.run(true,true,true,false,{target:'aep',nativeImageMasks:true,mergeBlends:false});
  const packet={...result.ship,images:h.messages.filter(m=>m.type==='image-chunk'&&m.seq===0).map(m=>({...m.meta,
    data:h.messages.filter(c=>c.type==='image-chunk'&&c.index===m.index).map(c=>c.dataPart).join('')}))};
  const output=path.resolve('artifacts/masked-blend-layers');await fs.mkdir(output,{recursive:true});
  await fs.writeFile(path.join(output,'packet.json'),JSON.stringify(packet));
  assert.ok(!packet.containers.some(c=>c.maskScope),'Shared masked blends must not keep an isolated shared scope');
  const byId=Object.fromEntries(packet.containers.map(c=>[c.id,c]));
  for(const name of ['Card','Texture','KV']) {
    const c=packet.containers.find(c=>c.name===name);
    assert.equal(c.collapseForBlends,true,name+' must pass the retained blend to the backdrop');
    assert.equal(c.maskId,null);
  }
  for(const [name,mode] of [['Building_630','LINEAR_BURN'],['Building_633','COLOR_BURN']]) {
    const image=packet.images.find(im=>im.name===name), wrappers=image.path.map(id=>byId[id]).filter(c=>c.maskId);
    assert.equal(wrappers.length,2,name+' needs both inherited masks');
    assert.equal(wrappers[0].blend,mode);assert.equal(wrappers[0].opacity,.8);
    assert.equal(wrappers[0].collapseForBlends,false,'The masked drawing computes its own pixels before blending outside');
    assert.equal(wrappers[1].blend,'NORMAL');assert.equal(image.blend,'NORMAL');assert.equal(image.opacity,1);
    assert.ok(wrappers.every(c=>c.x===0&&c.y===0&&c.cb.x===0&&c.cb.y===0),'Each wrapper keeps its own frame-relative bounds');
    assert.equal(image.data,pixels.toString('base64'),'Keep original footage bytes');
  }
  const tint=packet.nodes.find(n=>n.name==='Tint');
  assert.equal(tint.path.map(id=>byId[id]).filter(c=>c.maskId).length,2,'Normal artwork also receives each shared mask');
  const directory=await fs.mkdtemp(path.join(output,'aep-')),aep=await exportAep(packet,directory);
  await fs.writeFile(path.join(output,'packet.json'),JSON.stringify(packet));
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify(aep));
  return {packet,aep};
}
if(require.main===module)fixture().then(()=>console.log('PASS: shared nested masks per drawing, external blend and opacity, continuous pass-through chain and real AEP')).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={fixture};
