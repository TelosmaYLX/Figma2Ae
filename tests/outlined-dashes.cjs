const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {node,harness}=require('./export-options.cjs');
const {normalize}=require('../scripts/aep/packet.cjs');
const {exportAep}=require('../scripts/export-aep.cjs');
const {execFileSync}=require('node:child_process');
const ffx=require('../client/ffxGradient.js');
const fill=[{type:'SOLID',color:{r:.2,g:.3,b:.4},opacity:.4}],stroke=[{type:'SOLID',color:{r:.1,g:.6,b:1},opacity:.8}];
const rectPath=(x,y,w,h)=>`M${x} ${y}H${x+w}V${y+h}H${x}Z`;
const capsule='M2 0H8C10 0 10 4 8 4H2C0 4 0 0 2 0Z';
const geometry=[{data:'M0 0H80V50H0Z',windingRule:'NONZERO'}];
function fixture(allText=false,offset={x:-321.5,y:4008}){
  const outlined=[],temporary=[],calls=[],originals=[];
  function dashed(name,x,y,extra={}){
    const shape=node(extra.type||'RECTANGLE',name,{width:80,height:50,cornerRadius:0,fillGeometry:geometry,fills:[],strokes:stroke,
      strokeWeight:2,strokeAlign:'CENTER',dashPattern:[10,6],absoluteTransform:[[1,0,x],[0,1,y]],
      absoluteBoundingBox:{x,y,width:80,height:50},absoluteRenderBounds:{x:x-2,y:y-2,width:84,height:54},...extra});
    shape.outlineStroke=function(){
      assert.ok(!originals.includes(this),'Outline only an isolated temporary copy');
      assert.ok(this.parent.name==='F2A 临时导出','Keep new geometry outside auto-layout');
      calls.push({name:this.name,align:this.strokeAlign,cap:this.strokeCap,width:this.strokeWeight});
      const paths=[];
      for(let dx=0;dx<80;dx+=16){paths.push({data:rectPath(dx,0,10,2),windingRule:'NONZERO'});paths.push({data:rectPath(dx,48,10,2),windingRule:'NONZERO'});}
      if(this.name==='Round line')paths.splice(0,paths.length,{data:capsule,windingRule:'NONZERO'},{data:'M18 0H24C26 0 26 4 24 4H18C16 4 16 0 18 0Z',windingRule:'NONZERO'});
      if(this.name==='Gradient dash')paths[0]={data:rectPath(0,0,10,2)+rectPath(2,.5,6,1),windingRule:'EVENODD'};
      if(!this.dashPattern.length){
        const w=this.strokeWeight,outer=this.strokeAlign==='INSIDE'?0:this.strokeAlign==='OUTSIDE'?w:w/2,inner=w-outer;
        paths.splice(0,paths.length,{data:rectPath(2-outer,2-outer,80+2*outer,50+2*outer)+rectPath(2+inner,2+inner,80-2*inner,50-2*inner),windingRule:'EVENODD'});
      }
      const m=this.absoluteTransform.map(r=>r.slice());m[0][2]-=2;m[1][2]-=2;
      const vector=node('VECTOR','outline result',{fillGeometry:paths,fills:this.strokes,strokes:[],absoluteTransform:m,
        vectorNetwork:{regions:paths.map(()=>({fills:stroke}))}});
      vector.remove=function(){this.removed=true;};outlined.push(vector);temporary.push(this);return vector;
    };
    originals.push(shape);return shape;
  }
  const filled=dashed('Rectangle 7',30,30,{fills:fill,opacity:.6,strokeAlign:'INSIDE'});
  const empty=dashed('Border only',160,30,{strokeAlign:'OUTSIDE'});
  const line=dashed('Round line',30,130,{type:'LINE',height:0,fillGeometry:[],vectorPaths:[{data:'M0 0H80',windingRule:'NONZERO'}],strokeCap:'ROUND'});
  const rotated=dashed('Rotated',160,130,{absoluteTransform:[[.866,-.5,160],[.5,.866,130]],strokeWeight:.6666666865348816});
  const mask=node('RECTANGLE','mask',{isMask:true,maskType:'ALPHA',width:80,height:50,absoluteTransform:[[1,0,28],[0,1,218]],absoluteBoundingBox:{x:28,y:218,width:80,height:50},fillGeometry:geometry,fills:[{type:'SOLID',color:{r:1,g:1,b:1}}]});
  const masked=dashed('Masked dash',30,220);
  const scope=node('GROUP','Mask scope',{blendMode:'PASS_THROUGH',children:[mask,masked]});
  const solid=node('RECTANGLE','Solid style',{width:80,height:50,absoluteTransform:[[1,0,160],[0,1,220]],absoluteBoundingBox:{x:160,y:220,width:80,height:50},fillGeometry:geometry,fills:fill,strokes:stroke,strokeWeight:2,strokeAlign:'INSIDE'});
  const thin=dashed('Thin inside',30,300,{fills:fill,dashPattern:[],strokeWeight:.6666666865348816,strokeAlign:'INSIDE'});
  const tiny=dashed('Thin outside',160,300,{dashPattern:[],strokeWeight:.125,strokeAlign:'OUTSIDE'});
  const thinText=dashed('Thin text',30,390,{type:'TEXT',fills:fill,dashPattern:[],strokeWeight:.6666666865348816,characters:'Text',fontName:{family:'F2A unavailable font',style:'Regular'}});
  const gradient=[{type:'GRADIENT_LINEAR',opacity:.7,gradientTransform:[[1,0,0],[0,1,0]],gradientStops:[{position:0,color:{r:1,g:0,b:0,a:1}},{position:1,color:{r:0,g:0,b:1,a:.5}}]}];
  const grad=dashed('Gradient dash',160,390,{fills:fill,strokes:gradient});
  const normalText=node('TEXT','Normal text',{characters:'Ab',fontName:{family:allText?'F2A unavailable font':'Arial',style:'Regular'},fontSize:20,fills:fill,fillGeometry:geometry});
  const rich=node('TEXT','Rich outline',{characters:'AB',fills:[],fillGeometry:geometry,fontName:{family:'F2A unavailable font',style:'Regular'},glyphPaints:[[{type:'SOLID',color:{r:1,g:0,b:0}}],[{type:'SOLID',color:{r:0,g:0,b:1}}]],absoluteTransform:[[1,0,30],[0,1,470]]});
  const root=node('FRAME','Outlined dashes',{width:300,height:540,absoluteBoundingBox:{x:0,y:0,width:300,height:540},absoluteRenderBounds:{x:0,y:0,width:300,height:540},absoluteTransform:[[1,0,0],[0,1,0]],children:[filled,empty,line,rotated,scope,solid,thin,tiny,thinText,grad,normalText,...(allText?[rich]:[])]});
  (function move(n){n.absoluteTransform[0][2]+=offset.x;n.absoluteTransform[1][2]+=offset.y;for(const key of ['absoluteBoundingBox','absoluteRenderBounds']){n[key].x+=offset.x;n[key].y+=offset.y;}if(n.children)n.children.forEach(move);})(root);
  const h=harness(root),before=JSON.stringify(originals.map(n=>({id:n.id,dash:n.dashPattern,strokes:n.strokes,fills:n.fills,transform:n.absoluteTransform})));
  if(allText)rich.fills=h.figma.mixed;
  h.figma.flatten=function(nodes,parent){
    const text=nodes[0];assert.equal(text.type,'TEXT');assert.equal(parent.name,'F2A 临时导出');assert.equal(text.strokes.length,0);
    const paints=text.glyphPaints||[text.fills],paths=paints.map((p,i)=>({data:rectPath(2+i*16,2,10,20),windingRule:'NONZERO'}));
    const vector=node('VECTOR','glyphs',{fillGeometry:paths,fills:paints[0],absoluteTransform:text.absoluteTransform,vectorNetwork:{regions:paints.map(p=>({fills:p}))}});
    vector.remove=function(){this.removed=true;};outlined.push(vector);text.remove();return vector;
  };
  return {h,root,originals,outlined,temporary,calls,before};
}
async function collect(){
  const f=fixture(),r=await f.h.run(true,true,true,false,{target:'aep',nativeImageMasks:true}),packet={...r.ship,imageCount:0,images:[]};
  assert.equal(f.calls.length,9);assert.ok(f.outlined.every(n=>n.removed));assert.ok(f.temporary.every(n=>n.removed));
  assert.equal(JSON.stringify(f.originals.map(n=>({id:n.id,dash:n.dashPattern,strokes:n.strokes,fills:n.fills,transform:n.absoluteTransform}))),f.before);
  assert.deepEqual(f.h.figma.currentPage.selection,[f.root]);
  assert.ok(packet.nodes.filter(n=>n.name!=='Solid style'&&n.name!=='mask').every(n=>!n.dash&&!n.strokes.length));
  const model=normalize(packet),filled=model.shapes.find(s=>s.name==='Rectangle 7');
  assert.ok(filled.prim&&filled.extraPaints.some(p=>p.subpaths.length===10));
  assert.equal(filled.opacity,.6);assert.equal(filled.fillOpacity,.4);assert.equal(filled.extraPaints[0].opacity,.8);
  assert.ok(model.shapes.find(s=>s.name==='Solid style').layerStroke);
  assert.ok(model.shapes.find(s=>s.name==='Masked dash').maskId);
  assert.ok(!model.shapes.find(s=>s.name==='Thin inside').layerStroke);
  assert.ok(model.shapes.find(s=>s.name==='Thin inside').extraPaints[0].subpaths.length===2);
  assert.ok(!model.shapes.find(s=>s.name==='Thin outside').layerStroke);
  assert.ok(model.shapes.find(s=>s.name==='Thin text'));assert.equal(model.texts.length,1);
  assert.ok(model.shapes.every(s=>!s.strokeDash));
  const output=path.resolve('artifacts/outlined-dashes');await fs.mkdir(output,{recursive:true});
  const directory=await fs.mkdtemp(path.join(output,'aep-')),result=await exportAep(packet,directory);
  const vectorFixture=fixture(true),vectorResult=await vectorFixture.h.run(true,true,true,false,{target:'aep',outlineTexts:true}),vectorPacket={...vectorResult.ship,imageCount:0,images:[]},vectorModel=normalize(vectorPacket);
  assert.equal(vectorPacket.texts.length,0);assert.equal(vectorModel.texts.length,0);
  const zero=fixture(true,{x:0,y:0}),zeroResult=await zero.h.run(true,true,true,false,{target:'aep',outlineTexts:true}),zeroModel=normalize({...zeroResult.ship,imageCount:0,images:[]});
  const fingerprint=shapes=>JSON.stringify(shapes,(key,value)=>['sourceId','srcIndex','path','maskId','maskSource'].includes(key)?undefined:typeof value==='number'?Math.round(value*1e6)/1e6:value);
  assert.equal(fingerprint(vectorModel.shapes),fingerprint(zeroModel.shapes),'Page offsets must not move contours, multicolor glyphs or gradient handles');
  assert.ok(vectorModel.shapes.find(s=>s.name==='Normal text'));
  assert.ok(vectorModel.shapes.find(s=>s.name==='Rich outline').extraPaints.some(p=>p.color[2]===1));
  const vectorOutput=await fs.mkdtemp(path.join(output,'vector-')),vectorWritten=await exportAep(vectorPacket,vectorOutput);
  assert.equal(vectorWritten.counts.texts,0);assert.ok(vectorFixture.outlined.every(n=>n.removed));
  const presets={},gradShape=model.shapes.findIndex(s=>s.name==='Gradient dash'),ep=model.shapes[gradShape].extraPaints[0],preset=path.join(output,'outline.ffx');
  await fs.writeFile(preset,ffx.generate(await fs.readFile('host/figma/grad-template.ffx'),{colorStops:ep.gradient.stops.map(s=>({loc:s.offset,rgb:s.color})),alphaStops:ep.gradient.stops.map(s=>({loc:s.offset,a:s.opacity}))}));
  presets[gradShape]={extras:[{i:0,ffx:preset.replaceAll('\\','/')}]};
  await fs.writeFile(path.join(output,'input.json'),JSON.stringify({model,presets,project:result.project,vectorModel,vectorProject:vectorWritten.project}));
  execFileSync(path.resolve('.venv-aep/Scripts/python.exe'),['tests/check-outlined-dashes.py',result.project],{stdio:'inherit'});
  const failed=fixture();failed.originals[0].outlineStroke=function(){throw new Error('forced outline failure');};
  await failed.h.context.exportSelectionSVG(true,true,true,true,true,false,{target:'aep'});
  const error=failed.h.messages.find(m=>m.type==='error');assert.equal(error.nodeId,failed.originals[0].id);assert.match(error.message,/Rectangle 7.*轮廓化失败/);
  console.log('PASS: outline API on temporary copies; filled/empty/open/rotated/masked dashes and subpixel strokes; original settings and source error IDs preserved');
  return {packet,model,result};
}
if(require.main===module)collect().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={fixture,collect};
