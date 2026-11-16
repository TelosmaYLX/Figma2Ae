'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {once} = require('node:events');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname,'..');

async function check() {
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'F2A MCP 中文 '));
  const probe=net.createServer().listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  let relayPid;
  try {
    for(const file of ['launcher.cjs','relay.cjs'])await fs.copyFile(path.join(root,'mcp',file),path.join(temporary,file));
    const script="const {ensureRelay}=require(process.argv[1]);Promise.all(Array.from({length:4},()=>new Promise((resolve,reject)=>ensureRelay((e,v)=>e?reject(e):resolve(v))))).then(results=>console.log(JSON.stringify(results))).catch(e=>{console.error(e);process.exitCode=1;});";
    const child=spawn(process.execPath,['-e',script,path.join(temporary,'launcher.cjs')],{env:{...process.env,F2A_MCP_PORT:String(port)},windowsHide:true});
    let output='',error='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>error+=data);
    const [code]=await once(child,'exit');assert.equal(code,0,error);
    const results=JSON.parse(output);relayPid=results[0].pid;
    assert.equal(new Set(results.map(info=>info.pid)).size,1,'Concurrent starts reuse one relay');
    assert.equal(results[0].service,'f2a-mcp');assert.ok(relayPid>0);
    const healthy=await (await fetch('http://127.0.0.1:'+port+'/health')).json();assert.equal(healthy.pid,relayPid);
    console.log('PASS: cold start, four simultaneous launchers, shared detached relay, relocated Chinese/space path and no node_modules');
  } finally {
    if(relayPid)process.kill(relayPid);
    await fs.rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:50});
  }
}
check().catch(error=>{console.error(error);process.exitCode=1;});
