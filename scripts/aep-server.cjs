'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {randomUUID} = require('node:crypto');
const {exportAep, chooseDestination, AE_VERSIONS} = require('./export-aep.cjs');
const run = promisify(execFile);

function outputName(name) {
  let base = String(name || 'Figma').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100).replace(/[. ]+$/, '') || 'Figma';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(base)) base = '_' + base;
  return base;
}

async function createOutputDirectory(parent, name) {
  const base = outputName(name);
  for (let index = 1; ; index++) {
    const directory = path.join(parent, base + (index === 1 ? '' : ' (' + index + ')'));
    try { await fs.mkdir(directory); return directory; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

function start(options = {}) {
  const exports = new Map();
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
      res.end(JSON.stringify({service: 'f2a-aep', version: 3, aeVersions: AE_VERSIONS})); return;
    }
    if (req.method !== 'POST' || !['/export', '/open-directory'].includes(req.url)) { res.writeHead(404); res.end(); return; }
    try {
      const parts = [];
      let bytes = 0;
      for await (const part of req) {
        bytes += part.length;
        if (bytes > 512 * 1024 * 1024) throw new Error('导出数据超过 512 MB');
        parts.push(part);
      }
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (req.url === '/open-directory') {
        const directory = exports.get(body.exportId);
        if (!directory) throw new Error('请先完成 AEP 导出');
        try { await fs.access(directory); }
        catch (error) { if (error.code === 'ENOENT') throw new Error('导出文件夹已被移动或删除'); throw error; }
        await (options.openDirectory || openDirectory)(directory);
        res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
        res.end(JSON.stringify({ok:true})); return;
      }
      const result = await enqueue(async () => {
        const temporary = await fs.mkdtemp(path.join(options.tempRoot || os.tmpdir(), 'f2a-aep-'));
        try {
          const prepared = await exportAep(body.packet, temporary, options);
          if (prepared.warnings.length) {
            const issue = prepared.warnings[0];
            throw new Error('图层「' + (issue.layer || '未知') + '」：' + (issue.detail || issue.code || '存在未导出的属性'));
          }
          const destination = await (options.chooseDestination || chooseDestination)({...options, name:outputName(body.packet.name)});
          if (!destination) return {cancelled:true};
          const target = path.resolve(destination);
          const directory = await createOutputDirectory(path.dirname(target), path.basename(target).replace(/\.aep$/i, ''));
          const project = path.join(directory, path.basename(directory) + '.aep');
          try {
            await fs.cp(temporary, directory, {recursive:true});
            await fs.rename(path.join(directory, 'project.aep'), project);
          }
          catch (error) { await fs.rm(directory, {recursive:true, force:true}); throw error; }
          const exportId = randomUUID();
          exports.set(exportId, directory);
          return {...prepared, directory, project, exportId};
        } finally { await fs.rm(temporary, {recursive:true, force:true}); }
      });
      res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
      res.end(JSON.stringify(result));
      if (!options.quiet && !result.cancelled) console.log('AEP: ' + result.project + ' (' + result.totalMs + ' ms)');
    } catch (error) {
      if (error.cause) console.error(error.cause.stderr || error.cause);
      res.writeHead(400, {'Content-Type': 'application/json; charset=utf-8'});
      res.end(JSON.stringify({error: error.message, nodeId: error.nodeId || null}));
    }
  });
  server.listen(options.port ?? 7366, '127.0.0.1', () => {
    if (!options.quiet) console.log('F2A AEP: http://127.0.0.1:' + server.address().port + '\n导出时选择位置和名称');
  });
  return server;
}

async function openDirectory(directory) {
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', path.join(__dirname, 'open-aep-directory.ps1'), '-Directory', directory], {windowsHide:true, timeout:15000});
}

if (require.main === module) start();
module.exports = {start, openDirectory};
