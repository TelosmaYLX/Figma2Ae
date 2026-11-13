const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {fixture} = require('./direct-aep.cjs');
const run = promisify(execFile);

async function check() {
  const root = path.resolve(__dirname, '..');
  const source = path.resolve(process.argv[2] || path.join(root, 'artifacts/F2A-AEP-Windows-x64'));
  const testRoot = await fs.mkdtemp(path.join(root, 'artifacts/aep-distribution-'));
  const target = path.join(testRoot, '设备 中文');
  await fs.cp(source, target, {recursive:true});
  const env = {...process.env, PATH:path.join(process.env.SystemRoot, 'System32'), PYTHONPATH:'Z:/unavailable-python', PYTHONHOME:'Z:/unavailable-python'};
  delete env.F2A_PYTHON;
  const pythonRoot = path.join(target, 'runtime/python');
  const python = path.join(pythonRoot, 'python.exe'), node = path.join(target, 'runtime/node/node.exe');
  const probe = await run(python, ['-c', 'import json,sys,tkinter,py_aep; r=tkinter.Tk(); r.withdraw(); print(json.dumps({"prefix":sys.prefix,"base":sys.base_prefix,"paths":sys.path,"tcl":r.tk.eval("info library"),"mounts":list(r.tk.call("zipfs","mount"))[1::2] if r.tk.eval("info library").startswith("//zipfs:") else [],"aep":py_aep.__version__})); r.destroy()'], {env,windowsHide:true});
  const runtime = JSON.parse(probe.stdout);
  assert.equal(path.resolve(runtime.prefix).toLowerCase(),pythonRoot.toLowerCase());
  assert.equal(path.resolve(runtime.base).toLowerCase(),pythonRoot.toLowerCase());
  assert.ok(runtime.paths.every(p=>path.resolve(p).toLowerCase().startsWith(pythonRoot.toLowerCase()+path.sep)||path.resolve(p).toLowerCase()===pythonRoot.toLowerCase()));
  const tclSources=runtime.mounts.length?runtime.mounts:[runtime.tcl];
  assert.ok(tclSources.every(p=>path.resolve(p).toLowerCase().startsWith(pythonRoot.toLowerCase()+path.sep)));
  const parent = path.join(testRoot,'导出 位置');
  await fs.mkdir(parent);
  const child = spawn(node, ['-e', "const s=require(process.argv[1]).start({port:0,quiet:true,chooseDestination:async()=>process.argv[2]});s.on('listening',()=>process.stdout.write('PORT:'+s.address().port+'\\n'));", path.join(target,'scripts/aep-server.cjs'), path.join(parent,'自定义 工程')], {env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',part=>{stderr+=part;});
  try {
    const port = await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Bundled service did not start: '+stderr)),15000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',code=>{clearTimeout(timer);reject(new Error('Bundled service exited: '+code+' '+stderr));});
      child.stdout.on('data',part=>{const m=String(part).match(/PORT:(\d+)/);if(m){clearTimeout(timer);resolve(Number(m[1]));}});
    });
    const base='http://127.0.0.1:'+port;
    const health=await(await fetch(base+'/health')).json();assert.equal(health.service,'f2a-aep');
    assert.equal(health.version,3);
    const response=await fetch(base+'/export',{method:'POST',body:JSON.stringify({packet:await fixture()})});
    assert.equal(response.status,200,await response.clone().text());
    const result=await response.json();
    assert.equal(result.counts.texts,1);assert.equal(result.counts.images,2);
    assert.equal((await fs.readFile(result.project)).toString('ascii',0,4),'RIFX');
    assert.deepEqual((await fs.readdir(result.directory)).sort(),['Assets','report.json','自定义 工程.aep']);
    const invalid=await fixture();invalid.containers[0].blur=3;
    const rejected=await fetch(base+'/export',{method:'POST',body:JSON.stringify({packet:invalid})});
    assert.equal(rejected.status,400);assert.match((await rejected.json()).error,/Direct AEP smoke.*效果/);
    assert.deepEqual(await fs.readdir(parent),['自定义 工程']);
    await fs.writeFile(path.join(testRoot,'report.json'),JSON.stringify({passed:true,isolatedPath:true,relocated:true,cleanVm:false,runtime,result},null,2));
    console.log('PASS: relocated Windows package, no Node/Python on PATH, isolated Python/Tcl, bundled HTTP service and real AEP folder');
    console.log(testRoot);
  } finally {child.kill();}
}
check().catch(error=>{console.error(error);process.exitCode=1;});
