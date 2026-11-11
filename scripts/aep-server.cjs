'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {exportAep} = require('./export-aep.cjs');

function start(options = {}) {
  const output = path.resolve(options.output || path.join(__dirname, '../artifacts/aep-exports'));
  let serial = 0, queue = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'X-F2A-Warnings');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({service: 'f2a-aep', version: 1})); return;
    }
    if (req.method !== 'POST' || req.url !== '/export') { res.writeHead(404); res.end(); return; }
    try {
      const parts = [];
      let bytes = 0;
      for await (const part of req) {
        bytes += part.length;
        if (bytes > 512 * 1024 * 1024) throw new Error('导出数据超过 512 MB');
        parts.push(part);
      }
      const packet = JSON.parse(Buffer.concat(parts).toString('utf8'));
      const directory = path.join(output, Date.now() + '-' + (++serial));
      const job = queue.then(() => exportAep(packet, directory, options));
      queue = job.catch(() => {});
      const result = await job;
      const zip = await fs.readFile(result.archive);
      res.writeHead(200, {'Content-Type': 'application/zip', 'Content-Length': zip.length,
        'Content-Disposition': 'attachment; filename="F2A-project.zip"', 'X-F2A-Warnings': result.warnings.length});
      res.end(zip);
      console.log('AEP: ' + result.project + ' (' + result.totalMs + ' ms)');
    } catch (error) {
      if (error.cause) console.error(error.cause.stderr || error.cause);
      res.writeHead(400, {'Content-Type': 'application/json; charset=utf-8'});
      res.end(JSON.stringify({error: error.message}));
    }
  });
  server.listen(options.port ?? 7868, '127.0.0.1', () => {
    if (!options.quiet) console.log('F2A AEP: http://127.0.0.1:' + server.address().port + '\n输出: ' + output);
  });
  return server;
}

if (require.main === module) start({output: process.argv[2]});
module.exports = {start};
