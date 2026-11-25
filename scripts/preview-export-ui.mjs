import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const output = path.resolve('artifacts/export-options');
await fs.mkdir(output, {recursive:true});
// A Chromium profile is a few hundred throwaway files; keep it out of artifacts and remove it.
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'f2a-preview-'));
const child = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', '--remote-allow-origins=*', '--user-data-dir=' + profile, 'about:blank'
], {windowsHide: true, stdio: 'ignore'});
let socket;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  if (!port) throw new Error('Preview browser did not start');
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
  let seq = 0; const pending = new Map(), events = new Map();
  socket.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (events.has(m.method)) { events.get(m.method)(m); events.delete(m.method); }
  };
  const command = async (method, params = {}) => {
    const id = ++seq, done = new Promise(r => pending.set(id, r));
    socket.send(JSON.stringify({id, method, params}));
    const m = await done; if (m.error) throw new Error(JSON.stringify(m.error)); return m.result;
  };
  await command('Page.enable');
  // Preview only: do not connect the mock iframe to the running AE bridge.
  await command('Page.addScriptToEvaluateOnNewDocument', {source: 'window.WebSocket = function(){this.readyState=1;this.send=function(){};};window.fetch=async()=>({ok:true,json:async()=>({directory:"D:/Figma Assets/项目素材"})});'});
  const metrics = [];
  for (const width of [320, 375, 1280]) {
    await command('Emulation.setDeviceMetricsOverride', {width, height: 800, deviceScaleFactor: 1, mobile: false});
    const loaded = new Promise(r => events.set('Page.loadEventFired', r));
    await command('Page.navigate', {url: pathToFileURL(path.resolve('figma-plugin/ui.html')).href}); await loaded;
    const result = await command('Runtime.evaluate', {expression: '(async function(){await document.fonts.ready;selCount=1;setConn(true);mcpStatus(true,"MCP 已就绪");return {width:innerWidth,height:innerHeight,mcp:document.getElementById("mcp-status").textContent,contentHeight:document.querySelector(".wrap").getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth,markEnabled:!document.getElementById("mark-raster").disabled};})()', awaitPromise: true, returnByValue: true});
    metrics.push(result.result.value);
    const shot = await command('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
    await fs.writeFile(path.join(output, 'ui-' + width + '.png'), Buffer.from(shot.data, 'base64'));
    const expanded = await command('Runtime.evaluate', {expression: '(async function(){document.getElementById("advanced-options").open=true;document.getElementById("layer-tools").open=true;await new Promise(requestAnimationFrame);return {width:innerWidth,expanded:true,contentHeight:document.querySelector(".wrap").getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth};})()', awaitPromise: true, returnByValue: true});
    metrics.push(expanded.result.value);
    const expandedShot = await command('Page.captureScreenshot', {format: 'png', captureBeyondViewport: true});
    await fs.writeFile(path.join(output, 'ui-tools-' + width + '.png'), Buffer.from(expandedShot.data, 'base64'));
  }
  await fs.writeFile(path.join(output, 'ui-metrics.json'), JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics));
} finally {
  socket?.close(); child.kill();
  for (let i = 0; i < 20; i++) {                 // let the headless browser release its profile
    try { await fs.rm(profile, {recursive: true, force: true}); break; }
    catch { await new Promise(r => setTimeout(r, 150)); }
  }
}
