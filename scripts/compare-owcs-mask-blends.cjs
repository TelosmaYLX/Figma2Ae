'use strict';
// Rebuild a captured, normalized packet with the production mask distribution functions.
// This does not invoke Figma rendering or stand in for a fresh plugin export.
const fs=require('node:fs/promises');
const path=require('node:path');
const vm=require('node:vm');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
async function main(){
  const [input,destination,designFile]=process.argv.slice(2);
  if(!input||!destination||!designFile)throw Error('Usage: node scripts/compare-owcs-mask-blends.cjs export-directory new-directory figma-node.json');
  const model=JSON.parse(await fs.readFile(path.join(input,'debug-packet.json'),'utf8'));
  const design=JSON.parse(await fs.readFile(designFile,'utf8')),nodes=new Map();
  (function walk(n){nodes.set(n.id,n);for(const c of n.children||[])walk(c);})(design);
  for(const image of model.images){
    if(image.rasterScale||image.maskSource)continue;
    const paint=nodes.get(image.sourceId)?.fills?.find(p=>p.type==='IMAGE');
    if(paint)image.opacity*=paint.opacity??1;
  }
  for(const c of model.containers)if(c.id===c.maskId+'-scope')c.maskScope=true;
  const root=model.containers.find(c=>c.root),bounds=root.cb||{x:root.x,y:root.y,w:root.w,h:root.h};
  const code=await fs.readFile(path.resolve(__dirname,'../figma-plugin/code.js'),'utf8');
  function definition(name){const start=code.indexOf('function '+name+'('),tail=code.slice(start),end=tail.slice(1).search(/\n(?:async )?function /);return end<0?tail:tail.slice(0,end+1);}
  const context=vm.createContext({_contentBounds:()=>bounds,model,root});
  vm.runInContext(definition('_distributeBlendMasks')+'\n'+definition('_markBlendPassThrough')+
    '\n_distributeBlendMasks(root,[model.shapes,model.texts,model.images],model.containers);'+
    '\n_markBlendPassThrough(model.containers,[model.shapes,model.texts,model.images]);',context);
  await fs.mkdir(destination,{recursive:true});
  const file=path.join(destination,'debug-packet.json');await fs.writeFile(file,JSON.stringify(model));
  const python=path.resolve(__dirname,'../.venv-aep/Scripts/python.exe');
  const result=await promisify(execFile)(python,[path.join(__dirname,'aep/writer.py'),file,destination],{windowsHide:true,env:{...process.env,PYTHONUTF8:'1'}});
  console.log(result.stdout.trim());
}
main().catch(error=>{console.error(error.stderr||error);process.exitCode=1;});
