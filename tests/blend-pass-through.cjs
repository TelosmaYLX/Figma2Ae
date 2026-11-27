const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {node,group,harness}=require('./export-options.cjs');
const {exportAep}=require('../scripts/export-aep.cjs');
const {normalize}=require('../scripts/aep/packet.cjs');
const fill=[{type:'SOLID',color:{r:.8,g:.8,b:.8}}];
const rect=(name,extra={})=>node('RECTANGLE',name,{fills:fill,cornerRadius:0,fillGeometry:[{data:'M0 0H100V60H0Z',windingRule:'NONZERO'}],...extra});
async function fixture(){
 const nested=group('Pass wrapper',[group('Mask group',[rect('Mask',{isMask:true,maskType:'ALPHA'}),rect('Overlay',{blendMode:'OVERLAY'})])]);
 const normal=group('Normal boundary',[group('Inner pass',[rect('Internal multiply',{blendMode:'MULTIPLY'})])],{blendMode:'NORMAL'});
 const source=group('Scene',[rect('External backdrop'),nested,group('Plain group',[rect('Plain artwork')]),normal],{blendMode:'NORMAL'});
 const h=harness(source),result=await h.run(true,false,true,false,{target:'aep',nativeImageMasks:true,mergeBlends:false}),packet={...result.ship,imageCount:0,images:[]};
 const flags=Object.fromEntries(packet.containers.map(c=>[c.name,c.collapseForBlends]));
 assert.deepEqual(flags,{'Scene':false,'Pass wrapper':true,'Mask group':true,'Plain group':false,'Normal boundary':false,'Inner pass':true});
 const overlay=packet.nodes.find(n=>n.name==='Overlay');
 assert.ok(overlay.maskId&&packet.nodes.some(n=>n.maskSource===overlay.maskId),'The retained blend still has its independent matte');
 const fade = group('Faded pass-through', [
   group('Secondary fade', [
     rect('Independent mask', {isMask:true, maskType:'ALPHA'}),
     rect('Faded color blend', {blendMode:'COLOR', opacity:.5}),
   ], {opacity:.75}),
   group('Local composite', [rect('Local fill')], {blendMode:'NORMAL', opacity:.8}),
 ], {opacity:.6});
 const fadedScene = group('Faded scene', [rect('Color backdrop'), fade], {blendMode:'NORMAL'});
 for (const target of ['ae', 'aep', 'web']) {
   const {ship} = await harness(fadedScene).run(true,false,true,false,{target,mergeBlends:false});
   const containers = Object.fromEntries(ship.containers.map(c => [c.name, c]));
   const blend = ship.nodes.find(n => n.name === 'Faded color blend');
   const matte = ship.nodes.find(n => n.maskSource === blend.maskId);
   if (target === 'web') {
     assert.equal(containers['Faded pass-through'].opacity, .6);
     assert.equal(containers['Faded pass-through'].collapseForBlends, false);
     assert.equal(blend.opacity, .5);
     continue;
   }
   assert.equal(containers['Faded pass-through'].collapseForBlends, true);
   assert.equal(containers['Secondary fade'].collapseForBlends, true);
   assert.equal(containers['Secondary fade'].opacity, 1);
   assert.equal(containers['Faded pass-through'].opacity, 1);
   assert.ok(Math.abs(blend.opacity - .225) < 1e-9);
   assert.equal(blend.blend, 'COLOR');
   assert.equal(matte.opacity, 1);
   assert.equal(containers['Local composite'].collapseForBlends, false);
   assert.equal(containers['Local composite'].opacity, .48);
   assert.equal(ship.nodes.find(n => n.name === 'Local fill').opacity, 1);
 }
 const text=await harness(group('Text scene',[rect('Text backdrop'),group('Normal text wrapper',[node('TEXT','Mixed text',{blendMode:'MULTIPLY'})],{blendMode:'NORMAL'})])).run(true,false,true,false,{target:'aep',mergeBlends:false});
 const textBoundary=text.ship.containers.find(c=>c.name==='Normal text wrapper');
 assert.ok(textBoundary&&!textBoundary.collapseForBlends,'A text-only normal wrapper must remain an isolation boundary');
 assert.ok(text.ship.containers.every(c=>!c.collapseForBlends),'A normal text wrapper must stop outward blending');
 const merged=await harness(group('Closed merge',[rect('Opaque backdrop'),rect('Baked overlay',{blendMode:'OVERLAY'})],{blendMode:'NORMAL'})).run(true,false,true,false,{target:'aep',mergeBlends:true});
 assert.ok(merged.ship.containers.every(c=>!c.collapseForBlends),'Already merged blend content needs no pass-through');
 const output=await fs.mkdtemp(path.resolve('artifacts/blend-pass-through-')),resultAep=await exportAep(packet,output);
 await fs.writeFile(path.join(output,'packet.json'),JSON.stringify(packet));
 await fs.writeFile(path.join(output,'fixture.json'),JSON.stringify({model:normalize(packet),project:resultAep.project,directory:output}));
 console.log('PASS: retained blend layers mark only pass-through ancestor chains; normal/plain/merged groups stay uncollapsed; real AEP written');
 return {packet,project:resultAep.project,flags};
}
if(require.main===module)fixture().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={fixture};
