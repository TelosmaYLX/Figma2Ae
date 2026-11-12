const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {node,group,harness}=require('./export-options.cjs');
const {png}=require('./direct-aep.cjs');
const {exportAep}=require('../scripts/export-aep.cjs');
const {normalize}=require('../scripts/aep/packet.cjs');
const geometry=[{data:'M0 0H100V60H0Z',windingRule:'NONZERO'}];
const shape=(name,extra={})=>node('RECTANGLE',name,{cornerRadius:0,fillGeometry:geometry,fills:[{type:'SOLID',color:{r:.2,g:.4,b:.7}}],...extra});
async function check(){
  const picture=name=>shape(name,{fills:[{type:'IMAGE',imageHash:name,scaleMode:'FILL'}]});
  const mask=shape('Editable mask',{isMask:true});
  const scope=group('Mask scope',[mask,group('Editable masked group',[shape('Masked A'),shape('Masked B')],{opacity:.6})]);
  const fallback=group('Fallback scope',[shape('Outside fallback'),shape('Gradient mask',{isMask:true,fills:[{type:'GRADIENT_LINEAR',gradientStops:[{position:0,color:{r:1,g:1,b:1,a:0}},{position:1,color:{r:1,g:1,b:1,a:1}}]}]}),shape('Masked fallback')]);
  const root=node('FRAME','Scoped AEP',{width:640,height:360,absoluteBoundingBox:{x:20,y:30,width:640,height:360},
    children:[shape('Editable background'),picture('Photo A'),picture('Photo B'),shape('Editable boolean',{type:'BOOLEAN_OPERATION',children:[shape('Operand')]}),scope,fallback]});
  const h=harness(root),pixels=png();
  (function render(n){n.exportAsync=async()=>pixels;if(n.children)n.children.forEach(render);})(root);
  h.figma.getImageByHash=()=>({getBytesAsync:async()=>pixels,getSizeAsync:async()=>({width:64,height:64})});
  const collected=await h.run(true,true,true,false,{mergeBlends:true});
  const images=h.messages.filter(m=>m.type==='image-chunk'&&m.seq===0).map(m=>({...m.meta,
    data:h.messages.filter(c=>c.type==='image-chunk'&&c.index===m.index).map(c=>c.dataPart).join('')}));
  const packet={...collected.ship,images};
  assert.ok(packet.nodes.some(n=>n.name==='Editable boolean'));assert.ok(packet.nodes.some(n=>n.name==='Outside fallback'));
  assert.equal(collected.images.length,3); // Two independent bitmaps and one scoped mask PNG.
  const parent=path.resolve(__dirname,'../artifacts/aep-fidelity');await fs.mkdir(parent,{recursive:true});
  const directory=await fs.mkdtemp(path.join(parent,'success-')),result=await exportAep(packet,directory);
  assert.equal(result.warnings.length,0);assert.equal(result.counts.images,4);assert.equal(result.counts.mattes,3);
  assert.ok(result.counts.shapes>=5);assert.equal((await fs.readFile(result.project)).toString('ascii',0,4),'RIFX');
  const withShadow={...packet,imageCount:images.length+1,images:[...images,{...images[0],name:'Extracted shadow',shadow:true,shadowBase:null,matte:null,maskId:null,path:[],z:-1}]};
  const shadowDirectory=await fs.mkdtemp(path.join(parent,'shadow-')),shadowResult=await exportAep(withShadow,shadowDirectory);
  assert.equal(shadowResult.counts.images,5);assert.equal(shadowResult.warnings.length,0);
  const model=normalize(packet);const editableGroup=model.containers.find(c=>c.name==='Editable masked group');
  assert.ok(editableGroup.maskId);assert.ok(model.shapes.filter(s=>/^Masked [AB]/.test(s.name)).every(s=>!s.maskId));
  assert.throws(()=>normalize({...packet,imageCount:images.length+1}),/图片数据不完整/);
  assert.throws(()=>normalize({...packet,nodes:[{...packet.nodes[0],paths:[{d:'unsupported'}]}]}),/Editable background.*路径无法解析/);
  for(const [name,mutate,pattern] of [
    ['effects',p=>{p.containers[0].blur=3;},/Scoped AEP.*效果/],
    ['missing-mask',p=>{p.containers.find(c=>c.name==='Editable masked group').maskId='missing';},/缺少 Figma 蒙版/],
    ['missing-font',p=>{p.texts=[{name:'Missing font title',characters:'Test',family:'F2A missing font 12345',fontSize:16,x:0,y:0,w:100,h:30}];},/找不到字体/]
  ]){
    const invalid=structuredClone(packet);mutate(invalid);
    const output=await fs.mkdtemp(path.join(parent,name+'-'));
    await assert.rejects(()=>exportAep(invalid,output),pattern);
    await assert.rejects(()=>fs.access(path.join(output,'project.aep')));
    await assert.rejects(()=>fs.access(path.join(output,'report.json')));
    await assert.rejects(()=>fs.access(path.join(output,'packet.json')));
  }
  await fs.writeFile(path.join(parent,'report.json'),JSON.stringify({passed:true,syntheticFigma:true,...result},null,2));
  console.log('PASS: production collection → real AEP; independent images, editable boolean/group mask, scoped fallback; incomplete paths/images, effects, missing mask/font fail without an AEP');
}
check().catch(error=>{console.error(error);process.exitCode=1;});
