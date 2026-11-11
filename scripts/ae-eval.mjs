import fs from 'node:fs/promises';
import path from 'node:path';

// Evaluate a local JSX through the running CEP panel. No project is opened or replaced.
const script = path.resolve(process.argv[2]).replaceAll('\\', '/');
const targets = await (await fetch('http://127.0.0.1:8621/json')).json();
const target = targets.find(t => t.title === 'F2A');
if (!target) throw new Error('F2A panel is not running');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
const source = `var F2A_CASE = ${JSON.stringify(process.argv[4] || 'after')};\nvar F2A_ROOT = ${JSON.stringify(path.resolve('.').replaceAll('\\', '/'))};\n` + await fs.readFile(script, 'utf8');
const expression = `new Promise(resolve => window.__adobe_cep__.evalScript(${JSON.stringify(source)}, resolve))`;
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('AE evaluation timed out')), 120000);
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    resolve(message);
  };
  socket.send(JSON.stringify({id: 1, method: 'Runtime.evaluate', params: {expression, awaitPromise: true, returnByValue: true}}));
});
socket.close();
if (result.error || result.result?.exceptionDetails) throw new Error(JSON.stringify(result));
const value = result.result.result.value;
if (typeof value !== 'string' || !value.length) throw new Error('Empty AE result: ' + JSON.stringify(result));
if (process.argv[3]) {
  await fs.mkdir(path.dirname(process.argv[3]), {recursive: true});
  await fs.writeFile(process.argv[3], value, 'utf8');
}
else console.log(value);
