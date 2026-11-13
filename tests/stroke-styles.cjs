'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {normalize}=require('../scripts/aep/packet.cjs');
const {exportAep}=require('../scripts/export-aep.cjs');
const {execFileSync}=require('node:child_process');
const ffx=require('../client/ffxGradient.js');
const parser=require('../host/figma/svgParser.js');
const fill={kind:'solid',color:[.2,.4,.6],opacity:1};
const stroke={kind:'solid',color:[.9,.2,.1],opacity:.75};
function rect(name,align,x,y,extra={}){
  return {name,sourceId:name,paths:[{d:'M0 0H80V50H0Z'}],matrix:[1,0,0,1,x,y],
    fills:[fill],strokes:[stroke],strokeWeight:4,strokeAlign:align,
    prim:{k:'rect',w:80,h:50,r:0},z:y+x/1000,...extra};
}
function fixture(){
  const nodes=['INSIDE','OUTSIDE','CENTER'].map((align,i)=>rect(align,align,30+i*130,30));
  nodes.push(rect('Border only','INSIDE',30,120,{fills:[]}));
  nodes.push(rect('Translucent fill','OUTSIDE',160,120,{fills:[{...fill,opacity:.3}]}));
  const gradient={kind:'grad',type:'linear',p0:[290,120],p1:[370,170],opacity:.5,
    stops:[{offset:0,color:[1,0,0],opacity:.25},{offset:1,color:[0,0,1],opacity:1}]};
  nodes.push(rect('Gradient fill','CENTER',290,120,{fills:[gradient]}));
  nodes.push(rect('Multiple borders','OUTSIDE',30,210,{strokes:[{...stroke,color:[0,1,0]},stroke]}));
  const texts=['INSIDE','OUTSIDE','CENTER'].map((align,i)=>({name:'Text '+align,sourceId:'text-'+i,
    characters:'Abc',family:'Arial',style:'Regular',fontSize:28,color:[.2,.4,.6],x:30+i*130,y:305,w:100,h:40,
    stroke:{color:[.9,.2,.1],width:2,align,opacity:.6},align:'LEFT',z:400+i}));
  texts.push({...texts[0],name:'Rich stroke',runs:true,x:30,y:360,segs:[
    {characters:'A',family:'Arial',style:'Regular',fontSize:28,color:[0,0,1]},
    {characters:'bc',family:'Arial',style:'Bold',fontSize:28,color:[0,1,0]}]});
  texts.push({...texts[1],name:'Text translucent',x:160,y:360,fillOpacity:.3});
  const packet={name:'Stroke styles',svg:'<svg width="440" height="430"></svg>',frame:{width:440,height:430},nodes,texts,imageCount:0};
  return {packet,model:normalize(packet),gradient,texts};
}
async function check(){
  const {packet,model,gradient,texts}=fixture(),styles=model.shapes.filter(s=>s.layerStroke);
  assert.equal(styles.length,8);assert.ok(model.shapes.every(s=>!s.stroke&&!s.strokeGradient));
  assert.equal(styles.find(s=>s.name==='Border only').layerFillOpacity,0);
  assert.equal(styles.find(s=>s.name==='Translucent fill').layerFillOpacity,.3);
  assert.ok(model.shapes.find(s=>s.name==='Gradient fill').gradient);
  assert.equal(styles.find(s=>s.name==='Gradient fill stroke').layerFillOpacity,0);
  assert.deepEqual(styles.slice(0,3).map(s=>s.layerStroke.align),['INSIDE','OUTSIDE','CENTER']);
  assert.ok(styles.every(s=>s.layerStroke.opacity===.75));
  const svg=parser.parse('<svg width="100" height="80"><rect x="10" y="10" width="60" height="40" fill="none" stroke="red" stroke-width="3"/></svg>');
  assert.equal(svg.shapes[0].layerFillOpacity,0);assert.equal(svg.shapes[0].layerStroke.width,3);
  const line=parser.fromNodes([{...packet.nodes[0],prim:null,paths:[{d:'M0 0L80 0'}],fills:[]}],100,80).shapes[0];
  assert.ok(line.stroke);assert.ok(!line.layerStroke,'Open lines remain path geometry');
  const parent=path.resolve('artifacts/stroke-styles');await fs.mkdir(parent,{recursive:true});
  const directory=await fs.mkdtemp(path.join(parent,'aep-')),result=await exportAep(packet,directory);
  assert.equal(result.warnings.length,0);assert.equal(result.counts.texts,5);
  const expected=path.join(parent,'model.json');await fs.writeFile(expected,JSON.stringify(model));
  const gradFile=path.join(parent,'fill.ffx');
  await fs.writeFile(gradFile,ffx.generate(await fs.readFile('host/figma/grad-template.ffx'),{
    colorStops:gradient.stops.map(s=>({loc:s.offset,rgb:s.color})),alphaStops:gradient.stops.map(s=>({loc:s.offset,a:s.opacity}))}));
  const presets={5:{fill:gradFile.replaceAll('\\','/')}};
  await fs.writeFile(path.join(parent,'input.json'),JSON.stringify({packet,model,presets,project:result.project}));
  execFileSync(path.resolve('.venv-aep/Scripts/python.exe'),['tests/check-stroke-styles.py',result.project,expected],{stdio:'inherit'});
  await fs.writeFile(path.join(parent,'report.json'),JSON.stringify({passed:true,styles:styles.length,texts:texts.length,...result},null,2));
  console.log('PASS: solid closed borders and editable text use Layer Styles; native alignments, fill/stroke alpha, no-fill, gradients, multiple borders; real AEP generation');
}
if(require.main===module)check().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={fixture};
