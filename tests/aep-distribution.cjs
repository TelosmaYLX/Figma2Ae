const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {fixture} = require('./direct-aep.cjs');
const {fixture:nativeMasks} = require('./native-image-masks.cjs');
const {fixture:nestedMasks} = require('./nested-image-masks.cjs');
const {fixture:instanceCopies} = require('./export-instances.cjs');
const {fixture:strokeStyles} = require('./stroke-styles.cjs');
const {fixture:outlinedStrokes} = require('./outlined-dashes.cjs');
const {gradePacket, inspect:inspectGrade} = require('./editable-image-grade.cjs');
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
  const serviceClosed = new Promise(resolve => child.once('close',resolve));
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
    assert.equal(rejected.status,400);const issue=await rejected.json();assert.match(issue.error,/Direct AEP smoke.*效果/);
    assert.equal(issue.nodeId,invalid.containers[0].sourceId,'Bundled Python → HTTP preserves the original Figma ID');
    assert.deepEqual(await fs.readdir(parent),['自定义 工程']);
    const independent=await nativeMasks();
    const nativeResponse=await fetch(base+'/export',{method:'POST',body:JSON.stringify({packet:independent.packet})});
    assert.equal(nativeResponse.status,200,await nativeResponse.clone().text());
    const nativeResult=await nativeResponse.json();
    for(let i=0;i<independent.packet.images.length;i++)if(independent.packet.images[i].name.endsWith('_photo'))
      assert.deepEqual(await fs.readFile(path.join(nativeResult.directory,'Assets',String(i).padStart(4,'0')+'.png')),independent.original);
    await run(python,[path.join(root,'tests/check-native-image-masks.py'),nativeResult.project],{env,windowsHide:true});
    const nested=await nestedMasks();
    const nestedResponse=await fetch(base+'/export',{method:'POST',body:JSON.stringify({packet:nested.packet})});
    assert.equal(nestedResponse.status,200,await nestedResponse.clone().text());
    const nestedResult=await nestedResponse.json();
    await run(python,[path.join(root,'tests/check-nested-image-masks.py'),nestedResult.project],{env,windowsHide:true});
    const detached=await instanceCopies();
    const instanceResponse=await fetch(base+'/export',{method:'POST',body:JSON.stringify({packet:detached.packet})});
    assert.equal(instanceResponse.status,200,await instanceResponse.clone().text());
    const instanceResult=await instanceResponse.json();assert.equal(instanceResult.counts.texts,1);assert.equal(instanceResult.warnings.length,0);
    assert.equal((await fs.readFile(instanceResult.project)).toString('ascii',0,4),'RIFX');
    const styleResults=[];
    for(const thin of [false,true]){
      const styled=strokeStyles(thin);
      const styleResponse=await fetch(base+'/export',{method:'POST',body:JSON.stringify({packet:styled.packet})});
      assert.equal(styleResponse.status,200,await styleResponse.clone().text());
      const styledResult=await styleResponse.json();assert.equal(styledResult.counts.texts,5);
      if(thin)assert.equal(styledResult.counts.precomps,7);
      const styleModel=path.join(testRoot,thin?'thin-stroke-model.json':'stroke-model.json');await fs.writeFile(styleModel,JSON.stringify(styled.model));
      await run(python,[path.join(root,'tests/check-stroke-styles.py'),styledResult.project,styleModel],{env,windowsHide:true});
      styleResults.push(styledResult);
    }
    const outlinedFixture=outlinedStrokes(true),outlinedPacket=await outlinedFixture.h.run(true,true,true,false,{target:'aep',outlineTexts:true});
    const outlinedResponse=await fetch(base+'/export',{method:'POST',body:JSON.stringify({packet:{...outlinedPacket.ship,imageCount:0,images:[]}})});
    assert.equal(outlinedResponse.status,200,await outlinedResponse.clone().text());
    const outlinedResult=await outlinedResponse.json();assert.equal(outlinedResult.counts.texts,0);
    await run(python,[path.join(root,'tests/check-outlined-dashes.py'),outlinedResult.project],{env,windowsHide:true});
    const grade = gradePacket();
    const gradedResponse = await fetch(base+'/export',{method:'POST',body:JSON.stringify({packet:grade})});
    assert.equal(gradedResponse.status,200,await gradedResponse.clone().text());
    const graded = await gradedResponse.json();
    await run(python,['-c',inspectGrade,graded.project,grade.name],{env,windowsHide:true});
    await fs.writeFile(path.join(testRoot,'report.json'),JSON.stringify({passed:true,isolatedPath:true,relocated:true,cleanVm:false,runtime,result,nativeResult,nestedResult,instanceResult,styleResult:styleResults[0],thinStyleResult:styleResults[1],outlinedResult},null,2));
    console.log('PASS: relocated Windows package, no Node/Python on PATH, isolated Python/Tcl, bundled HTTP service and real AEP folder');
    console.log(process.env.F2A_KEEP_DISTRIBUTION ? 'kept package copy: ' + testRoot : 'removed the 170 MB package copy (set F2A_KEEP_DISTRIBUTION=1 to keep it)');
  } finally {
    child.kill();
    await serviceClosed;
    if (!process.env.F2A_KEEP_DISTRIBUTION) await fs.rm(testRoot, {recursive: true, force: true});
  }
}
check().catch(error=>{console.error(error);process.exitCode=1;});
