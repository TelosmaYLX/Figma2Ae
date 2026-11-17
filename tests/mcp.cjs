'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const {once} = require('node:events');
const {spawn} = require('node:child_process');
const {WebSocket} = require('../mcp/node_modules/ws');
const {start} = require('../mcp/relay.cjs');
const root = path.resolve(__dirname,'..');
const quiet = {log() {},info() {},debug() {},warn() {},error() {}};

async function connectPlugin(port, name, configure = () => {}) {
  const source = await fs.readFile(path.join(root,'figma-plugin/code.js'),'utf8');
  const html = await fs.readFile(path.join(root,'figma-plugin/ui.html'),'utf8');
  const nodes = new Map();
  let nextId = 0, mcpSocket, lastSocket;
  const startupErrors=[];
  const page = {id:'0:1', name:name+' Page', type:'PAGE', selection:[], children:[], async loadAsync() {}, appendChild(node) {node.parent = this; this.children.push(node);}};
  const figma = {root:{name, children:[page]}, fileKey:name + '-key', currentPage:page, mixed:Symbol('mixed'),
    showUI() {}, on() {}, notify() {}, commitUndo() {}, ui:{postMessage(message) {window.onmessage({data:{pluginMessage:message}});}},
    async getNodeByIdAsync(id) {return nodes.get(id);},
    createRectangle() {
      const node = {id:'1:'+(++nextId), name:'Rectangle', type:'RECTANGLE', visible:true, fills:[], strokes:[],
        resize(width,height) {this.width=width;this.height=height;},
        remove() {nodes.delete(this.id);this.parent.children=this.parent.children.filter(child=>child!==this);}};
      nodes.set(node.id,node); return node;
    }
  };
  configure({figma, nodes, page});
  const elements = {};
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) elements[match[1]] = {checked:/\bchecked\b/.test(match[0]), disabled:/\bdisabled\b/.test(match[0])};
  elements['raster-scale'].value='1'; elements['text-mode'].value='editable'; elements['native-image-masks'].value='separate';
  const window = {onmessage() {}};
  const main = vm.createContext({figma,__html__:'',console:{...quiet,error(...args){startupErrors.push(args.map(String).join(' '));}},setTimeout,clearTimeout});
  vm.runInContext(source,main);
  // Install the UI before forwarding startup messages from the actual plugin main.
  function Socket(url) {
    if (!url.endsWith('/plugin')) {this.readyState=0;return;}
    mcpSocket = new WebSocket('ws://127.0.0.1:'+port+'/plugin');
    lastSocket = mcpSocket;
    return mcpSocket;
  }
  vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], {
    window, WebSocket:Socket, document:{getElementById:id=>elements[id]},
    parent:{postMessage(message) {figma.ui.onmessage(message.pluginMessage);}},
    fetch:async()=>({ok:true,json:async()=>({directory:''})}), console:quiet,
    setTimeout() {}, clearTimeout() {}
  });
  await once(mcpSocket,'open');
  assert.deepEqual(startupErrors,[],'Plugin startup must not run the separate upstream settings initializer');
  await new Promise(resolve => {const timer=setInterval(()=>{if(elements['mcp-status'].textContent==='MCP 已就绪'){clearInterval(timer);resolve();}},5);});
  return {figma,main,elements,nodes,socket:lastSocket, async close(){const closed=once(lastSocket,'close');lastSocket.close();await closed;}};
}

function mcpClient(file, port) {
  const child = spawn(process.execPath,[file],{env:{...process.env,F2A_MCP_PORT:String(port)},stdio:['pipe','pipe','pipe'],windowsHide:true});
  const pending = new Map(); let nextId=0, buffer='', stderr='';
  child.stderr.on('data',data=>stderr+=data);
  child.stdout.on('data',data=>{
    buffer+=data;
    while(buffer.includes('\n')){
      const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      if(!line)continue;
      const response=JSON.parse(line),job=pending.get(response.id);
      if(job){pending.delete(response.id);clearTimeout(job.timer);response.error?job.reject(new Error(JSON.stringify(response.error))):job.resolve(response.result);}
    }
  });
  child.on('exit',()=>{for(const job of pending.values()){clearTimeout(job.timer);job.reject(new Error('MCP exited: '+stderr));}pending.clear();});
  function call(method,params={}) {
    return new Promise((resolve,reject)=>{
      const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP timeout: '+method+' '+stderr));},10000);
      pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    });
  }
  return {child,call, tool:(name,args={})=>call('tools/call',{name,arguments:args}),
    async init(){const result=await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'F2A test',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');return result;},
    async close(){const exited=once(child,'exit');child.kill();await exited;}};
}

function result(response) {assert.ok(!response.isError,JSON.stringify(response));return response.content.map(item=>item.text||'').join('\n');}

async function check() {
  const relay = start({port:0,commandTimeout:120,idleTimeout:60000});
  await once(relay.server,'listening');
  const port=relay.server.address().port;
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'f2a-mcp-'));
  const clients=[],plugins=[];
  try {
    // A relocated runtime has no node_modules: shipped bundles must be self-contained.
    await require('../scripts/package-aep-service.cjs').copyMcp(temporary);
    const runtime=path.join(temporary,'mcp');
    await assert.rejects(fs.access(path.join(runtime,'node_modules')));
    const client=mcpClient(path.join(runtime,'server.cjs'),port);clients.push(client);
    assert.equal((await client.init()).serverInfo.name,'F2A');
    const tools=(await client.call('tools/list')).tools;
    assert.ok(tools.length>=50);assert.ok(tools.some(tool=>tool.name==='get_f2a_status'));
    // F2A's own layer-organisation tools must be advertised beside the upstream set.
    for(const name of ['group_nodes','ungroup_nodes','reorder_nodes','reparent_nodes','batch_rename_nodes','set_visible','set_locked','set_clips_content','search_nodes','detach_instances','batch']){
      assert.ok(tools.some(tool=>tool.name===name),'missing tool '+name);
    }
    assert.deepEqual(JSON.parse(result(await client.tool('get_f2a_status'))),{sessions:[]});
    assert.match(result(await client.tool('get_selection')),/打开 F2A/);

    const first=await connectPlugin(port,'First');plugins.push(first);
    const sessions=JSON.parse(result(await client.tool('get_f2a_status'))).sessions;
    assert.equal(sessions.length,1);assert.equal(sessions[0].name,'First');
    assert.equal(JSON.parse(result(await client.tool('get_selection'))).selectionCount,0);
    const createdText=result(await client.tool('create_rectangle',{x:12,y:24,width:80,height:40,name:'MCP Rectangle'}));
    const created=JSON.parse(createdText.slice(createdText.indexOf('{'),createdText.lastIndexOf('}')+1));
    assert.equal(first.nodes.get(created.id).x,12);
    assert.equal(first.nodes.get(created.id).width,80);
    assert.match(result(await client.tool('rename_node',{nodeId:created.id,name:'Renamed'})),/Renamed/);
    assert.equal(first.nodes.get(created.id).name,'Renamed');
    const exported=await first.main.exportSelectionSVG(true,true,true,true,true,false,{});
    assert.equal(first.elements['mcp-status'].textContent,'MCP 已就绪');

    // A second MCP client must choose when multiple F2A documents are open.
    const second=await connectPlugin(port,'Second');plugins.push(second);
    const chooser=mcpClient(path.join(runtime,'server.cjs'),port);clients.push(chooser);await chooser.init();
    assert.match(result(await chooser.tool('get_selection')),/多个 F2A/);
    assert.equal(JSON.parse(result(await chooser.tool('join_channel',{channel:'Second'}))).name,'Second');
    assert.equal(JSON.parse(result(await chooser.tool('get_document_info'))).name,'Second Page');
    assert.equal(JSON.parse(result(await client.tool('get_document_info'))).name,'First Page');
    await second.close();plugins.splice(plugins.indexOf(second),1);
    assert.match(result(await chooser.tool('get_selection')),/断开/);
    assert.equal(JSON.parse(result(await chooser.tool('join_channel'))).name,'First');

    const direct=async(command,params={})=>fetch('http://127.0.0.1:'+port+'/command',{method:'POST',body:JSON.stringify({sessionId:sessions[0].id,command,params})});
    first.main._exporting=true;
    assert.match((await (await direct('get_selection')).json()).error,/正在导出/);
    first.main._exporting=false;
    assert.match((await (await direct('unsupported_command')).json()).error,/Unknown command/);
    // Falsy results and errors must return immediately, never wait for the timeout.
    first.main.F2AMCP.execute=async()=>false;
    assert.equal((await (await direct('get_selection')).json()).result,false);
    first.main.F2AMCP.execute=async()=>{await new Promise(resolve=>setTimeout(resolve,40));return null;};
    assert.equal((await (await direct('get_selection')).json()).result,null);
    first.main.F2AMCP.execute=async(command,params)=>{
      for(let index=0;index<4;index++){
        await new Promise(resolve=>setTimeout(resolve,50));
        first.figma.ui.postMessage({type:'command_progress',commandId:params.commandId});
      }
      return 'progress completed';
    };
    assert.equal((await (await direct('get_selection')).json()).result,'progress completed');
    first.main.F2AMCP.execute=async()=>new Promise(()=>{});
    const timeout=await direct('get_selection');assert.match((await timeout.json()).error,/超时/);
    const disconnected=direct('get_selection');await new Promise(resolve=>setTimeout(resolve,20));await first.close();plugins.splice(plugins.indexOf(first),1);
    assert.match((await (await disconnected).json()).error,/断开/);
    const rejected=await fetch('http://127.0.0.1:'+port+'/command',{method:'POST',headers:{Origin:'https://example.com'},body:'{}'});
    assert.equal(rejected.status,403);
    console.log('PASS: '+tools.length+' MCP tools; relocated stdio bundle → HTTP relay → real UI script → embedded Figma commands; read/write, automatic discovery, multiple documents, export lock, falsy results, errors, timeout and disconnect');
  } finally {
    await Promise.all(clients.map(client=>client.close()));
    await Promise.all(plugins.map(plugin=>plugin.close()));
    relay.server.closeAllConnections();await new Promise(resolve=>relay.server.close(resolve));
    await fs.rm(temporary,{recursive:true,force:true});
  }
}

if (require.main === module) check().catch(error=>{console.error(error);process.exitCode=1;});
module.exports = {connectPlugin, mcpClient, result};
