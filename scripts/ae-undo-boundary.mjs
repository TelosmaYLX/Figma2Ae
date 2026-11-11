import fs from 'node:fs/promises';
import path from 'node:path';

// Import returns to CEP before undo/redo run, matching the real panel boundary. Both callbacks
// are scheduled together; no model/tool round trip is inserted between the native operations.
const root = path.resolve('.').replaceAll('\\', '/');
const source = await fs.readFile('tests/ae-undo.jsx', 'utf8');
const start = `var F2A_ROOT=${JSON.stringify(root)};var F2A_CASE='batch-boundary';\n` + source;
const check = `var F2A_ROOT=${JSON.stringify(root)};var F2A_CASE='boundary-check';\n` + source;
const targets = await (await fetch('http://127.0.0.1:8621/json')).json();
const target = targets.find(t => t.title === 'F2A');
if (!target) throw new Error('F2A panel is not running');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
const expression = `new Promise(resolve=>window.__adobe_cep__.evalScript(${JSON.stringify(start)},first=>{
  var parsed;try{parsed=JSON.parse(first);}catch(e){resolve(first);return;}
  if(!parsed.ready){resolve(first);return;}
  window.__adobe_cep__.evalScript(${JSON.stringify(check)},resolve);
}))`;
try {
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Undo boundary test timed out')), 180000);
    socket.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) { clearTimeout(timer); resolve(m); } };
    socket.send(JSON.stringify({id: 1, method: 'Runtime.evaluate', params: {expression, awaitPromise: true, returnByValue: true}}));
  });
  const value = result.result?.result?.value;
  if (typeof value !== 'string') throw new Error(JSON.stringify(result));
  const parsed = JSON.parse(value);
  await fs.mkdir('artifacts/undo', {recursive: true});
  await fs.writeFile('artifacts/undo/boundary-report.json', JSON.stringify(parsed, null, 2));
  console.log(JSON.stringify(parsed, null, 2));
  if (!parsed.passed) process.exitCode = 1;
} finally { socket.close(); }
