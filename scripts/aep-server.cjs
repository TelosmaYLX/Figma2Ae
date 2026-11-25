'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const {watchFile, unwatchFile} = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {randomUUID} = require('node:crypto');
const {statSync} = require('node:fs');
const {publishAep, chooseDestination, AE_VERSIONS} = require('./export-aep.cjs');
const run = promisify(execFile);

// The service is started once in the background and reused by every panel / plugin window, so a
// restart of AE or Figma does not restart it. Reload the web exporter whenever its sources change
// on disk, otherwise exports keep running whatever writer was loaded when the service started.
const WEB_MODULES = ['./export-web.cjs', './web/writer.cjs', './aep/packet.cjs', '../client/figmaImageGrade.js', '../host/figma/aeFilename.js']
  .map(file => require.resolve(file));
let webStamp = null;
let webApi = null;
function loadWeb() {
  const stamp = WEB_MODULES.map(file => { try { return statSync(file).mtimeMs; } catch { return 0; } }).join('|');
  if (!webApi || stamp !== webStamp) {
    if (webApi) for (const file of WEB_MODULES) delete require.cache[file];
    webApi = require('./export-web.cjs');
    webStamp = stamp;
  }
  return webApi;
}
loadWeb();

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
      res.end(JSON.stringify({service: 'f2a-aep', version: 3, aeVersions: AE_VERSIONS, preserveImageFilters: true, preserveBackgroundBlur: true, singleLayerLabel: true, webExport: true})); return;
    }
    if (req.method !== 'POST' || !['/export', '/export-web', '/open-directory', '/open-preview'].includes(req.url)) { res.writeHead(404); res.end(); return; }
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
        const record = exports.get(body.exportId);
        const directory = typeof record === 'string' ? record : record?.directory;
        if (!directory) throw new Error('请先完成导出');
        try { await fs.access(directory); }
        catch (error) { if (error.code === 'ENOENT') throw new Error('导出文件夹已被移动或删除'); throw error; }
        await (options.openDirectory || openDirectory)(directory);
        res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
        res.end(JSON.stringify({ok:true})); return;
      }
      if (req.url === '/open-preview') {
        const record = exports.get(body.exportId);
        const entry = record && typeof record === 'object' ? record.entry : null;
        if (!entry) throw new Error('请先完成 HTML 网页导出');
        try { await fs.access(entry); }
        catch (error) { if (error.code === 'ENOENT') throw new Error('导出的网页文件已被移动或删除'); throw error; }
        await (options.openPreview || loadWeb().openWebPreview)(entry);
        res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
        res.end(JSON.stringify({ok:true})); return;
      }
      if (req.url === '/export-web') {
        const result = await enqueue(async () => {
          const {publishWeb, chooseWebDestination} = loadWeb();
          const prepared = await publishWeb(body.packet,
            name => (options.chooseWebDestination || options.chooseDestination || chooseWebDestination)({...options, name}), options);
          if (prepared.cancelled) return prepared;
          const exportId = randomUUID();
          exports.set(exportId, {directory: prepared.directory, entry: prepared.entry});
          return {...prepared, exportId};
        });
        res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
        res.end(JSON.stringify(result));
        if (!options.quiet && !result.cancelled) console.log('Web: ' + result.entry + ' (' + result.totalMs + ' ms)');
        return;
      }
      const result = await enqueue(async () => {
        const prepared = await publishAep(body.packet,
          name => (options.chooseDestination || chooseDestination)({...options, name}), options);
        if (prepared.cancelled) return prepared;
        const exportId = randomUUID();
        exports.set(exportId, {directory: prepared.directory, entry: null});
        return {...prepared, exportId};
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
  if (options.updateSignal) {
    // Drain the queued exports before the installer replaces the writer on disk.
    watchFile(options.updateSignal, {interval: 250, persistent: false}, current => {
      if (current.nlink && server.listening) server.close();
    });
    server.once('close', () => unwatchFile(options.updateSignal));
  }
  return server;
}

async function openDirectory(directory) {
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', path.join(__dirname, 'open-aep-directory.ps1'), '-Directory', directory], {windowsHide:true, timeout:15000});
}

if (require.main === module) start({port: process.argv.includes('--workspace') ? 17366 : 7366,
  updateSignal: path.join(__dirname, '..', '.f2a-update-aep')});
module.exports = {start, openDirectory, loadWeb};
