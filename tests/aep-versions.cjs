const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {fixture}=require('./direct-aep.cjs');
const {fixture:maskFixture}=require('./native-image-masks.cjs');
const {exportAep,AE_VERSIONS}=require('../scripts/export-aep.cjs');
const run=promisify(execFile);

async function check(){
  const root=path.resolve(__dirname,'..'),output=path.join(root,'artifacts/aep-versions');
  await fs.mkdir(output,{recursive:true});
  const directory=await fs.mkdtemp(path.join(output,'run-')),cases=[];
  const packets={basic:await fixture(),masks:(await maskFixture()).packet};
  for(const [kind,packet] of Object.entries(packets))for(const aeVersion of AE_VERSIONS){
    const result=await exportAep({...packet,aeVersion},path.join(directory,kind+'-'+aeVersion));
    assert.equal(result.aeVersion,aeVersion);assert.equal(result.warnings.length,0);
    if(kind==='masks')assert.ok(result.counts.mattes>=5);
    cases.push({name:kind+'-'+aeVersion,kind,aeVersion,project:result.project,counts:result.counts});
  }
  const file=path.join(output,'cases.json');await fs.writeFile(file,JSON.stringify(cases,null,2));
  const python=process.env.F2A_PYTHON||path.join(root,'.venv-aep/Scripts/python.exe');
  const checked=await run(python,[path.join(__dirname,'check-aep-versions.py'),file],{windowsHide:true});
  for(const c of cases.filter(c=>c.kind==='masks'))await run(python,[path.join(__dirname,'check-native-image-masks.py'),c.project],{windowsHide:true});
  console.log(checked.stdout.trim());
  console.log('PASS: all three target versions retain editable text, gradients, images, clips and independent alpha/luma mattes');
  console.log(file);
}
check().catch(error=>{console.error(error);process.exitCode=1;});
