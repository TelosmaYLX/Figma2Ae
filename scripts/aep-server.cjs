'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {exportAep, chooseDirectory} = require('./export-aep.cjs');

async function createOutputDirectory(parent, name) {
  let base = String(name || 'Figma').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100).replace(/[. ]+$/, '') || 'Figma';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(base)) base = '_' + base;
  for (let index = 1; ; index++) {
    const directory = path.join(parent, base + (index === 1 ? '' : ' (' + index + ')'));
    try { await fs.mkdir(directory); return directory; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

function start(options = {}) {
  const destinations = new Map();
  let queue = Promise.resolve();
  function enqueue(task) {
    const job = queue.then(task);
    queue = job.catch(() => {});
    return job;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({service: 'f2a-aep', version: 2})); return;
    }
    if (req.method !== 'POST' || !['/select-directory', '/export'].includes(req.url)) { res.writeHead(404); res.end(); return; }
    try {
      if (req.url === '/select-directory') {
        const directory = await enqueue(() => (options.chooseDirectory || chooseDirectory)(options));
        let destination = null;
        if (directory) {
          destination = randomUUID();
          destinations.set(destination, path.resolve(directory));
        }
        res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
        res.end(JSON.stringify({destination})); return;
      }
      const parts = [];
      let bytes = 0;
      for await (const part of req) {
        bytes += part.length;
        if (bytes > 512 * 1024 * 1024) throw new Error('导出数据超过 512 MB');
        parts.push(part);
      }
      const {destination, packet} = JSON.parse(Buffer.concat(parts).toString('utf8'));
      const parent = destinations.get(destination);
      if (!parent) throw new Error('请重新选择导出位置');
      destinations.delete(destination);
      const result = await enqueue(async () => {
        const directory = await createOutputDirectory(parent, packet.name);
        return exportAep(packet, directory, options);
      });
      res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
      res.end(JSON.stringify(result));
      console.log('AEP: ' + result.project + ' (' + result.totalMs + ' ms)');
    } catch (error) {
      if (error.cause) console.error(error.cause.stderr || error.cause);
      res.writeHead(400, {'Content-Type': 'application/json; charset=utf-8'});
      res.end(JSON.stringify({error: error.message}));
    }
  });
  server.listen(options.port ?? 7868, '127.0.0.1', () => {
    if (!options.quiet) console.log('F2A AEP: http://127.0.0.1:' + server.address().port + '\n导出时选择文件夹');
  });
  return server;
}

if (require.main === module) start();
module.exports = {start};
