const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {node,group,harness}=require('./export-options.cjs');
const {png}=require('./direct-aep.cjs');
const {exportAep}=require('../scripts/export-aep.cjs');
const {normalize}=require('../scripts/aep/packet.cjs');
const run=promisify(execFile);
const fill=[{type:'SOLID',color:{r:.3,g:.6,b:.9}}];
function at(n,x,y,w=100,h=60){
  Object.assign(n,{width:w,height:h,absoluteBoundingBox:{x,y,width:w,height:h},absoluteRenderBounds:{x,y,width:w,height:h},absoluteTransform:[[1,0,x],[0,1,y]]});return n;
}
async function check(){
  const scale=Number(process.argv[2]||1);
  const curve=at(node('VECTOR','Bezier shape',{fills:fill,fillGeometry:[{data:'M0 0 C0 80 100 80 100 0 Z',windingRule:'NONZERO'}]}),540.375,250.625);
  const outlined=at(node('RECTANGLE','Outside stroke',{fills:fill,cornerRadius:8,strokes:fill,strokeWeight:3,strokeAlign:'OUTSIDE',fillGeometry:[{data:'M0 0H80V40H0Z',windingRule:'NONZERO'}]}),660.5,250.75,80,40);
  const texts=['LEFT','CENTER','RIGHT'].map((align,i)=>at(node('TEXT','Text '+align,{characters:'Anchor test',fills:fill,textAlignHorizontal:align}),550+i*150,335.25,140,24));
  const rotated=at(node('TEXT','Rotated text',{characters:'Rotated',fills:fill,rotation:23}),870,250,100,36);
  const angle=23*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
  rotated.absoluteTransform=[[cos,-sin,870],[sin,cos,250]];
  rotated.absoluteBoundingBox=rotated.absoluteRenderBounds={x:870-36*sin,y:250,width:100*cos+36*sin,height:100*sin+36*cos};
  const paragraph=at(node('TEXT','Paragraph text',{characters:'First line\nSecond line',fills:fill,textAutoResize:'HEIGHT'}),550,460,140,60);
  const rich=at(node('TEXT','Rich text',{characters:'Mixed sizes',fills:fill,getStyledTextSegments(){return[
    {characters:'Mixed ',fontName:{family:'Arial',style:'Regular'},fontSize:18,fills:fill},
    {characters:'sizes',fontName:{family:'Arial',style:'Regular'},fontSize:24,fills:fill}];}}),750,460,180,36);
  const gradient=at(node('TEXT','Gradient text',{characters:'Gradient',fills:[{type:'GRADIENT_LINEAR',gradientTransform:[[1,0,0],[0,1,0]],gradientStops:[{position:0,color:{r:1,g:0,b:0,a:1}},{position:1,color:{r:0,g:0,b:1,a:1}}]}]}),900,335,110,24);
  const raster=at(node('RECTANGLE','*Fractional raster'),780.375,270.625,100.37,37.21);
  const photo=mode=>at(node('RECTANGLE','Photo '+mode,{cornerRadius:0,fills:[{type:'IMAGE',imageHash:'photo',scaleMode:mode}]}),900,390,82.25,60.125);
  const mask=at(node('RECTANGLE','Mask',{isMask:true,cornerRadius:0,fills:fill,fillGeometry:[{data:'M0 0H70V40H0Z',windingRule:'NONZERO'}]}),560,390,70,40);
  const masked=at(node('RECTANGLE','Masked artwork',{cornerRadius:0,fills:fill,fillGeometry:[{data:'M0 0H100V60H0Z',windingRule:'NONZERO'}]}),550,380);
  const nested=at(node('FRAME','Nested clip',{clipsContent:true,cornerRadius:8,children:[curve,outlined,raster,rotated]}),525.5,230.25,460.5,90.25);
  const root=at(node('FRAME','AEP layout',{children:[nested,...texts,gradient,paragraph,rich,photo('FIT'),photo('FILL'),group('Mask group',[mask,masked])]}),500.125,200.375,640,360);
  const h=harness(root);
  (function render(n){n.exportAsync=async options=>png(Math.ceil(n.absoluteRenderBounds.width*options.constraint.value),Math.ceil(n.absoluteRenderBounds.height*options.constraint.value));if(n.children)n.children.forEach(render);})(root);
  h.context.figma.getImageByHash=()=>({getBytesAsync:async()=>png(300,200),getSizeAsync:async()=>({width:300,height:200})});
  const result=await h.run(true,true,true,false,{rasterScale:scale}),messages=h.messages;
  const images=messages.filter(m=>m.type==='image-chunk'&&m.seq===0).map(m=>({...m.meta,data:messages.filter(c=>c.type==='image-chunk'&&c.index===m.index).map(c=>c.dataPart).join('')}));
  const baked=images.find(im=>/Fractional_raster$/.test(im.name));
  assert.equal(baked.rasterScale,scale);assert.deepEqual([baked.natW,baked.natH],[Math.ceil(100.37*scale),Math.ceil(37.21*scale)]);
  assert.ok(Math.abs(Math.min(baked.cw/baked.natW,baked.ch/baked.natH)-1/scale)>.0001,'Reproduce the old fractional FIT shrink');
  assert.equal(images.find(im=>im.name==='Photo_FIT').rasterScale,null);
  const packet={...result.ship,images},directory=await fs.mkdtemp(path.resolve(__dirname,'../artifacts/aep-layout-'));
  const exported=await exportAep(packet,directory),expected=path.join(directory,'expected.json');
  await fs.writeFile(expected,JSON.stringify(normalize(packet)));
  const python=process.env.F2A_PYTHON||path.resolve(__dirname,'../.venv-aep',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const inspected=await run(python,[path.join(__dirname,'check-aep-layout.py'),exported.project,expected],{windowsHide:true,env:{...process.env,PYTHONUTF8:'1'}});
  await fs.writeFile(path.resolve(__dirname,'../artifacts/aep-layout-native.json'),JSON.stringify({project:exported.project,expected}));
  console.log(inspected.stdout.trim());console.log('PASS: Figma collection → real AEP; fractional baked PNG, normal FIT/FILL, centered anchors and unchanged scene placement');
  console.log(directory);
}
check().catch(error=>{console.error(error);process.exitCode=1;});
