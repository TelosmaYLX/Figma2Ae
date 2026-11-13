const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const source=fs.readFileSync(path.join(__dirname,'../scripts/aep-server.cjs'),'utf8');
const launches=[];
let failure=false,unrefs=0;
const context=vm.createContext({module:{exports:{}},process,console,require(name){
  if(name==='node:child_process')return {spawn(file,args,options){
    launches.push({file,args,options});
    const child=new EventEmitter();child.unref=()=>unrefs++;
    queueMicrotask(()=>failure?child.emit('error',new Error('Explorer unavailable')):child.emit('spawn'));
    return child;
  }};
  if(name==='./export-aep.cjs')return require('../scripts/export-aep.cjs');
  return require(name);
}});
vm.runInContext(source,context);
(async()=>{
  const directory='D:\\导出 位置\\自定义 工程';
  await context.module.exports.openDirectory(directory);
  const launch=launches[0];
  assert.equal(launch.file,path.join(process.env.SystemRoot,'explorer.exe'));
  assert.deepEqual(Array.from(launch.args),[directory]);
  assert.equal(launch.options.windowsHide,false,'The explicitly requested Explorer window must be visible');
  assert.equal(launch.options.detached,true);assert.equal(unrefs,1);
  failure=true;await assert.rejects(()=>context.module.exports.openDirectory(directory),/Explorer unavailable/);
  console.log('PASS: native Explorer launch is visible, preserves Unicode/spaces, detaches after spawn and reports launch errors');
})().catch(error=>{console.error(error);process.exitCode=1;});
