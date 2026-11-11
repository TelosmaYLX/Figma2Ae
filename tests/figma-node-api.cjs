const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {node,group,harness}=require('./export-options.cjs');
const source='"use strict";\n'+fs.readFileSync(path.join(__dirname,'../figma-plugin/code.js'),'utf8');
function strictGroups(n){
  if(n.children)n.children.forEach(strictGroups);
  if(n.type!=='GROUP')return;
  // Real Groups expose geometry, opacity, effects and children, but no fills or strokes.
  delete n.fills;delete n.strokes;
  n.relativeTransform=[[1,0,20],[0,1,30]];
  n.removed=undefined;
  Object.preventExtensions(n);
}
const solid=()=>node('RECTANGLE','base',{cornerRadius:0,fills:[{type:'SOLID',color:{r:.2,g:.4,b:.7}}]});
const blend=()=>node('RECTANGLE','glow',{blendMode:'SOFT_LIGHT'});
async function check(){
  for(const rasterGroups of [false,true]){
    const root=group('sealed group',[solid(),blend(),node('TEXT','title')]);
    const h=harness(root,source);strictGroups(root);
    const r=await h.run(true,rasterGroups,true,false,{mergeBlends:true});
    assert.equal(r.images.length,1);assert.equal(r.ship.texts.length,1);assert.equal(r.references.length,1);
    assert.ok(!Object.isExtensible(root));assert.equal('fills' in root,false);assert.equal('strokes' in root,false);
    assert.equal(root.removed,undefined);assert.equal(root.children[1].blendMode,'SOFT_LIGHT');
  }
  const inner=group('inner',[blend(),node('RECTANGLE','front')]),root=group('root',[solid(),inner,node('TEXT','title')]);
  const nested=harness(root,source);strictGroups(root);
  const n=await nested.run(true,true,true,false,{mergeBlends:true});
  assert.equal(n.images.length,1);assert.equal(n.ship.texts.length,1);
  const drop={type:'DROP_SHADOW',visible:true,color:{r:0,g:0,b:0,a:.5},offset:{x:0,y:3},radius:5};
  const shadowRoot=group('shadowed',[solid(),blend(),node('TEXT','title')],{effects:[drop]});
  const shadow=harness(shadowRoot,source);strictGroups(shadowRoot);
  const s=await shadow.run(true,true,true,false,{mergeBlends:true});
  assert.equal(s.images.length,2);assert.equal(s.ship.texts.length,1);assert.deepEqual(shadowRoot.effects,[drop]);
  console.log('PASS: strict non-extensible Figma Groups export blend ranges, nested groups and shadows without adding unsupported paint properties');
}
check().catch(e=>{console.error(e);process.exitCode=1;});
