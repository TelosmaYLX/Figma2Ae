const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {node,group,harness}=require('./export-options.cjs');
const {png}=require('./direct-aep.cjs');
const {exportAep}=require('../scripts/export-aep.cjs');
const run=promisify(execFile);
const fill=opacity=>[{type:'SOLID',color:{r:1,g:1,b:1},opacity}];
const rich=(name,extra={})=>node('TEXT',name,{characters:'AB CDE',opacity:.6,...extra,
  getStyledTextSegments(){return [
    {characters:extra.textAutoResize==='HEIGHT'?'AB\n':'AB',fontName:{family:'Arial',style:'Regular'},fontSize:20,fills:fill(.25)},
    {characters:' CD',fontName:{family:'Arial',style:'Regular'},fontSize:20,fills:fill(.75)},
    {characters:'E',fontName:{family:'Arial',style:'Regular'},fontSize:20,fills:fill(0)}];}});
async function check(){
  const texts=[node('TEXT','Plain',{characters:'MMMM',opacity:.6,fills:fill(.25)}),
    rich('Rich'),rich('Rich box',{textAutoResize:'HEIGHT',characters:'AB\n CDE',width:20}),rich('Rich rotated',{rotation:15}),
    node('TEXT','Zero layer',{opacity:0,fills:fill(.5)}),node('TEXT','Zero fill',{opacity:.5,fills:fill(0)}),
    node('TEXT','Hidden paint',{opacity:.6,fills:[{...fill(.1)[0],visible:false},fill(.35)[0]]}),
    node('TEXT','No fill',{opacity:.6,fills:[]}),node('TEXT','Hidden fills',{opacity:.6,fills:[{...fill(.5)[0],visible:false}]}),
    node('TEXT','Gradient',{opacity:.6,fills:[{type:'GRADIENT_LINEAR',opacity:.2,gradientTransform:[[1,0,0],[0,1,0]],gradientStops:[{position:0,color:{r:1,g:0,b:0,a:1}},{position:1,color:{r:0,g:0,b:1,a:.5}}]}]})];
  const parent=group('Parent opacity',texts,{opacity:.4});
  const root=node('FRAME','Text opacity',{width:640,height:360,opacity:.5,children:[parent]}),h=harness(root);
  root.exportAsync=async()=>png();
  const collected=await h.run(),byName=Object.fromEntries(collected.ship.texts.map(t=>[t.name,t]));
  assert.equal(byName.Plain.opacity,.6);assert.equal(byName.Plain.fillOpacity,.25);
  for(const name of ['Rich','Rich box','Rich rotated']){assert.equal(byName[name].opacity,.6);assert.deepEqual(byName[name].segs.map(s=>s.opacity),[.25,.75,0]);}
  assert.equal(byName['Zero layer'].opacity,0);assert.equal(byName['Zero fill'].fillOpacity,0);
  assert.equal(byName['Hidden paint'].fillOpacity,.35);assert.equal(byName.Gradient.grad.opacity,.2);
  assert.equal(byName['No fill'].fillOpacity,0);assert.equal(byName['Hidden fills'].fillOpacity,0);
  assert.equal(collected.ship.containers.find(c=>c.name==='Parent opacity').opacity,.4);
  const images=h.messages.filter(m=>m.type==='image-chunk'&&m.seq===0).map(m=>({...m.meta,data:h.messages.filter(c=>c.type==='image-chunk'&&c.index===m.index).map(c=>c.dataPart).join('')}));
  const directory=await fs.mkdtemp(path.resolve(__dirname,'../artifacts/text-opacity-'));
  const packet={...collected.ship,images},result=await exportAep(packet,directory);
  const expected=path.join(directory,'expected.json');await fs.writeFile(expected,JSON.stringify({texts:packet.texts,containers:packet.containers}));
  const python=process.env.F2A_PYTHON||path.resolve(__dirname,'../.venv-aep',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const inspected=await run(python,[path.join(__dirname,'check-text-opacity.py'),result.project,expected],{windowsHide:true,env:{...process.env,PYTHONUTF8:'1'}});
  const flat=await h.run(true,true,false),flatPlain=flat.ship.texts.find(t=>t.name==='Plain'),flatRich=flat.ship.texts.find(t=>t.name==='Rich');
  assert.ok(Math.abs(flatPlain.opacity-.12)<1e-9);assert.equal(flatPlain.fillOpacity,.25);
  assert.ok(Math.abs(flatRich.opacity-.12)<1e-9);assert.deepEqual(flatRich.segs.map(s=>s.opacity),[.25,.75,0]);
  const nativeCase=path.resolve(__dirname,'../artifacts/text-opacity-native.json');
  await fs.writeFile(nativeCase,JSON.stringify({project:result.project,texts:packet.texts,containers:packet.containers}));
  console.log(inspected.stdout.trim());
  console.log('PASS: Figma collection → real AEP → binary readback; plain/rich/box/rotated text, zero and per-run alpha, hidden paints, gradients, parent opacity once');
  console.log(directory);
}
check().catch(error=>{console.error(error);process.exitCode=1;});
