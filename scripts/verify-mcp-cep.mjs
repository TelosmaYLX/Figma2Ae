import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Checks the actual CEP runtime and local service; does not evaluate host JSX.
const targets=await (await fetch('http://127.0.0.1:7368/json')).json();
const target=targets.find(item=>item.title==='F2A');
if(!target)throw new Error('Open the F2A panel in After Effects first.');
const socket=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
let nextId=0;
const pending=new Map();
socket.onmessage=event=>{
  const response=JSON.parse(event.data),job=pending.get(response.id);
  if(!job)return;pending.delete(response.id);clearTimeout(job.timer);
  response.error?job.reject(new Error(JSON.stringify(response.error))):job.resolve(response.result);
};
function command(method,params={}){
  return new Promise((resolve,reject)=>{
    const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timed out'));},10000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
  });
}
try {
  if(process.argv.includes('--reload'))await command('Page.reload');
  let state;
  for(let attempt=0;attempt<60;attempt++){
    const evaluated=await command('Runtime.evaluate',{expression:'({node:process.version,label:document.getElementById("mk-mcp-label")?.textContent,ready:document.getElementById("mk-mcp-dot")?.classList.contains("on")})',returnByValue:true});
    state=evaluated.result?.value;
    if(state?.ready)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(state?.ready,JSON.stringify(state));
  const service=await (await fetch('http://127.0.0.1:7367/health')).json();
  assert.equal(service.service,'f2a-mcp');
  const output=path.resolve('artifacts/mcp');await fs.mkdir(output,{recursive:true});
  const screenshot=await command('Page.captureScreenshot',{format:'png'});
  await fs.writeFile(path.join(output,'cep.png'),Buffer.from(screenshot.data,'base64'));
  const report={passed:true,cep:state,service,checkedAt:new Date().toISOString()};
  await fs.writeFile(path.join(output,'cep-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally {socket.close();}
