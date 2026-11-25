const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../scripts/aep-server.cjs'),'utf8');
const launches=[];
let failure=false;
function fakeRequire(name){
  if(name==='node:child_process')return {execFile(file,args,options,callback){
    launches.push({file,args,options});
    queueMicrotask(()=>callback(failure?new Error('Explorer unavailable'):null,'',''));
  }};
  if(name==='./export-aep.cjs')return require('../scripts/export-aep.cjs');
  if(name==='./export-web.cjs')return require('../scripts/export-web.cjs');
  return require(name);
}
// scripts/aep-server.cjs resolves its reloadable module list from its own folder.
fakeRequire.resolve = name => path.resolve(__dirname,'../scripts',name);
const context=vm.createContext({module:{exports:{}},__dirname:path.resolve(__dirname,'../scripts'),process,console,require:fakeRequire});
vm.runInContext(source,context);
(async()=>{
  const directory='D:\\导出 位置\\自定义 工程';
  await context.module.exports.openDirectory(directory);
  const launch=launches[0];
  assert.equal(launch.file,path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'));
  assert.deepEqual(Array.from(launch.args),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden',
    '-File',path.resolve(__dirname,'../scripts/open-aep-directory.ps1'),'-Directory',directory]);
  assert.equal(launch.options.windowsHide,true,'Only the helper console is hidden; Explorer is shown by the helper');
  assert.equal(launch.options.timeout,15000);
  failure=true;await assert.rejects(()=>context.module.exports.openDirectory(directory),/Explorer unavailable/);
  console.log('PASS: folder activation helper receives the literal Unicode/spaced path, hides its console and reports completion/errors');
})().catch(error=>{console.error(error);process.exitCode=1;});
