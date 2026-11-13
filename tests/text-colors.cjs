const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {node,harness}=require('./export-options.cjs');
const {exportAep}=require('../scripts/export-aep.cjs');
const {execFileSync}=require('node:child_process');
const paint=color=>[{type:'SOLID',color:{r:color[0],g:color[1],b:color[2]}}];
async function check(){
  const colors=[
    ['Button gray',[0.054901961237192154,0.054901961237192154,0.054901961237192154]],
    ['Black',[0,0,0]],['White',[1,1,1]],['Near black',[1/255,1/255,1/255]],
    ['Long RGB',[.123456789,.7654321,.333333333]],['Tiny RGB',[1e-8,1e-6,.000123456789]],
    ['Almost white',[.99999994,.99999982,.99999976]],['Red',[1,0,0]],['Green',[0,1,0]],['Blue',[0,0,1]]
  ];
  const texts=colors.map(([name,color],i)=>node('TEXT',name,{characters:'Text',fills:paint(color),
    absoluteBoundingBox:{x:24,y:24+i*42,width:160,height:28},fontSize:24}));
  texts.push(node('TEXT','Thin colored text',{characters:'Text',fills:paint(colors[0][1]),strokes:paint([1,0,0]),strokeWeight:.6666666865348816,strokeAlign:'OUTSIDE',fontSize:24}));
  const rich=node('TEXT','Rich colors',{characters:'RGB',fills:Symbol(),getStyledTextSegments(){
    return colors.slice(0,3).map(([name,color],i)=>({characters:'RGB'[i],fontName:{family:'Arial',style:'Regular'},fontSize:24,fills:paint(color)}));
  }});
  const root=node('FRAME','Text colors',{width:240,height:500,children:[...texts,rich]}),h=harness(root);
  rich.fills=h.figma.mixed;
  const result=await h.run(),packet={...result.ship,imageCount:0,images:[]};
  for(const [name,color] of colors)assert.deepEqual(packet.texts.find(t=>t.name===name).color,color,'Figma colors must be collected without changing their value');
  const output=path.resolve('artifacts/text-colors');await fs.mkdir(output,{recursive:true});
  const directory=await fs.mkdtemp(path.join(output,'aep-')),written=await exportAep(packet,directory);
  assert.equal(written.counts.texts,12);assert.equal(written.warnings.length,0);
  await fs.writeFile(path.join(output,'input.json'),JSON.stringify({project:written.project,texts:packet.texts}));
  execFileSync(path.resolve('.venv-aep/Scripts/python.exe'),['tests/check-text-colors.py',path.join(output,'input.json')],{stdio:'inherit'});
  console.log('PASS: actual Figma collector preserves RGB; plain and rich text colors generate a real AEP, including the exact gray that AE previously read as cyan');
  console.log(written.project);
}
check().catch(error=>{console.error(error);process.exitCode=1;});
