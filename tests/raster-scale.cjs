const assert=require('node:assert/strict');
const {node,group,harness}=require('./export-options.cjs');
const {png}=require('./direct-aep.cjs');
async function check(){
  const shadow=node('RECTANGLE','Editable shadow',{fills:[{type:'SOLID',color:{r:1,g:1,b:1}}],
    fillGeometry:[{data:'M0 0H20V10H0Z',windingRule:'NONZERO'}],effects:[{type:'DROP_SHADOW',visible:true,radius:3,offset:{x:0,y:2},color:{r:0,g:0,b:0,a:.5}}],width:20,height:10,
    absoluteBoundingBox:{x:40,y:50,width:20,height:10}});
  Object.defineProperty(shadow,'absoluteRenderBounds',{get(){return this.effects.some(e=>e.type==='DROP_SHADOW')?{x:35,y:47,width:30,height:16}:this.absoluteBoundingBox;}});
  const root=node('FRAME','Scale scene',{width:320,height:200,children:[shadow,
    group('*Marked raster',[node('TEXT','Baked label')]),
    node('RECTANGLE','Blurred leaf',{effects:[{type:'LAYER_BLUR',visible:true,radius:3}]}),
    node('RECTANGLE','Original photo',{fills:[{type:'IMAGE',imageHash:'photo',scaleMode:'FIT'}]})]});
  const calls=[];
  const h=harness(root);
  (function render(n){n.exportAsync=async function(options){
    assert.equal(options.format,'PNG');calls.push({name:this.name,scale:options.constraint.value});
    const b=this.absoluteRenderBounds,s=options.constraint.value;return png(Math.ceil(b.width*s),Math.ceil(b.height*s));
  };if(n.children)n.children.forEach(render);})(root);
  h.figma.getImageByHash=()=>({getBytesAsync:async()=>png(8,4),getSizeAsync:async()=>({width:8,height:4})});
  for(const scale of [1,2,3,4,undefined]){
    calls.length=0;
    const expected=scale||1,result=await h.run(true,true,true,false,scale?{rasterScale:scale}:{});
    assert.ok(calls.length>=5,JSON.stringify({calls,images:result.images.map(image=>({name:image.name,shadow:!!image.shadowBase}))}));assert.ok(calls.every(call=>call.scale===expected),'Every Figma PNG render must use the selected scale');
    const all=[...result.images,...result.references],photo=all.find(image=>image.name==='Original_photo');
    assert.equal(photo.rasterScale,null);assert.deepEqual([photo.natW,photo.natH],[8,4]);
    assert.ok(all.filter(image=>image!==photo).every(image=>image.rasterScale===expected));
    const projected=all.find(image=>image.shadowBase);
    assert.deepEqual([projected.shadowBase.dx,projected.shadowBase.dy,projected.shadowBase.w,projected.shadowBase.h],[5*expected,3*expected,20*expected,10*expected]);
    assert.equal(result.references[0].natW,100*expected);assert.equal(result.references[0].natH,60*expected);
  }
  calls.length=0;h.messages.length=0;
  await h.context.exportSelectionSVG(true,true,true,false,true,false,{rasterScale:0});
  assert.match(h.messages.find(message=>message.type==='error').message,/切图倍率/);
  assert.equal(calls.length,0);assert.equal(h.messages.at(-1).busy,false);
  console.log('PASS: default 1× and selected 1/2/3/4× reach all raster/reference/shadow PNGs; shadow offsets match; original photos unchanged; invalid scale fails before rendering');
}
check().catch(error=>{console.error(error);process.exitCode=1;});
