import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const dir=path.resolve('artifacts/fidelity/light-passes');
const profile=path.resolve('artifacts/fidelity/edge-profile-'+Date.now());
const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const child=spawn(edge,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--remote-allow-origins=*','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
let socket;
try{
  let port;
  for(let i=0;i<100;i++){try{port=(await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{await new Promise(r=>setTimeout(r,100));}}
  if(!port)throw new Error('Headless renderer did not start');
  const targets=await(await fetch('http://127.0.0.1:'+port+'/json')).json();
  socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
  let seq=0;const pending=new Map();const events=new Map();
  socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}else if(events.has(m.method)){events.get(m.method)(m);events.delete(m.method);}};
  const command=async(method,params={})=>{const id=++seq;const done=new Promise(r=>pending.set(id,r));socket.send(JSON.stringify({id,method,params}));const m=await done;if(m.error)throw new Error(JSON.stringify(m.error));return m.result;};
  await command('Page.enable');
  await command('Emulation.setDefaultBackgroundColorOverride',{color:{r:0,g:0,b:0,a:0}});
  for(const file of (await fs.readdir(dir)).filter(n=>n.endsWith('.svg'))){
    const source=await fs.readFile(path.join(dir,file),'utf8');
    const width=Number(source.match(/\bwidth="([\d.]+)"/)[1]);
    const height=Number(source.match(/\bheight="([\d.]+)"/)[1]);
    await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    const loaded=new Promise(r=>events.set('Page.loadEventFired',r));
    await command('Page.navigate',{url:pathToFileURL(path.join(dir,file)).href});await loaded;
    const shot=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await fs.writeFile(path.join(dir,file.replace('.svg','.png')),Buffer.from(shot.data,'base64'));
    console.log(file);
  }
}finally{socket?.close();child.kill();}
