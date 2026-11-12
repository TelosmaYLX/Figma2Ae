const assert=require('node:assert/strict');
const {node,group,harness}=require('./export-options.cjs');
const {extractShadow}=require('../client/figmaRasterEffects.js');
const drop={type:'DROP_SHADOW',visible:true,radius:8,offset:{x:2,y:4},color:{r:0,g:0,b:0,a:.5}};
function composite(fg,bg) {
  const af=fg[3]/255,ab=bg[3]/255,a=af+ab*(1-af);
  return [0,1,2].map(i=>a?Math.round((fg[i]*af+bg[i]*ab*(1-af))/a):0).concat(Math.round(a*255));
}
for(const foreground of [[0,0,0,0],[255,255,255,255],[90,180,225,128],[220,140,60,64]]) {
  for(const shadow of [[0,0,0,128],[30,70,120,80]]) {
    const full=composite(foreground,shadow),recovered=Array.from(extractShadow(full,foreground));
    const rebuilt=composite(foreground,recovered);
    assert.ok(rebuilt.every((v,i)=>Math.abs(v-full[i])<=1),JSON.stringify({full,recovered,rebuilt}));
  }
}
(async()=>{
  const text=node('TEXT','button label',{effects:[drop]});
  const geometry=[{data:'M0 0H100V60H0Z',windingRule:'NONZERO'}];
  const back=node('RECTANGLE','button background',{fillGeometry:geometry,cornerRadius:0,fills:[{type:'SOLID',color:{r:.2,g:.3,b:.8}}]});
  const button=group('button',[back,text],{effects:[drop]});
  const h=harness(button),result=await h.run();
  assert.equal(result.ship.texts.length,1);assert.equal(result.ship.texts[0].characters,'Editable text');
  assert.equal(result.ship.texts[0].fx.length,0);
  assert.ok(result.ship.containers.every(c=>!c.fx.length));assert.equal(result.ship.effects.length,0);
  const shadows=result.images.filter(im=>im.shadowBase),backgrounds=result.images.filter(im=>!im.shadowBase);
  assert.equal(shadows.length,2,'Group silhouette and text-local shadows must both be retained');
  assert.ok(shadows.every(im=>im.shadow));
  assert.ok(shadows.some(im=>im.external),'The root shadow must stay outside the root clip');
  assert.equal(backgrounds.length,0);assert.equal(result.ship.nodes.length,1);assert.equal(result.references.length,1);
  assert.deepEqual(button.effects,[drop]);assert.deepEqual(text.effects,[drop]);
  const onlyText=harness(node('TEXT','shadow text',{effects:[drop]}));
  const tr=await onlyText.run();assert.equal(tr.ship.texts.length,1);assert.equal(tr.images.length,1);assert.ok(tr.images[0].shadowBase);
  const leaf=harness(node('RECTANGLE','shadow shape',{fillGeometry:geometry,cornerRadius:0,effects:[drop],fills:[{type:'SOLID',color:{r:1,g:0,b:0}}]}));
  const lr=await leaf.run();assert.equal(lr.images.length,1);assert.ok(lr.images[0].shadowBase);assert.equal(lr.ship.nodes.length,1);
  for(const effect of [{type:'INNER_SHADOW',visible:true,radius:4,offset:{x:0,y:2},color:{r:0,g:0,b:0,a:.5}},{type:'LAYER_BLUR',visible:true,radius:4}]) {
    const plain=await harness(node('RECTANGLE','non-text effect',{effects:[effect]})).run();
    assert.equal(plain.images.length,1);assert.equal(plain.ship.nodes.length,0);
  }
  const marked=group('*whole button',[node('TEXT','baked label')],{effects:[drop]});
  const mr=await harness(marked).run();assert.equal(mr.ship.texts.length,0);assert.equal(mr.images.length,1);assert.equal(mr.images[0].shadowBase,null);
  const off=await h.run(true,false);assert.equal(off.images.filter(im=>im.shadowBase).length,0);assert.ok(off.ship.texts[0].fx.length);
  console.log('PASS: Figma shadow extraction reconstructs RGBA, editable button/group/text shadows, no AE shadow duplication, non-text effect rasterization, explicit marks and option off');
})().catch(e=>{console.error(e);process.exitCode=1;});
