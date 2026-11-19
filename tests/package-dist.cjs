'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {execFile, spawn} = require('node:child_process');
const {promisify} = require('node:util');
const {once} = require('node:events');
const {createHash} = require('node:crypto');
const {fixture} = require('./direct-aep.cjs');
const {privacyIssues} = require('../scripts/package-dist.cjs');
const surehand = require('../mcp/vendor/surehand/catalog.json');
const {version} = require('../version.json');
const run = promisify(execFile);
const root = path.resolve(__dirname, '..');

async function checkMcp(target) {
  const relay = require(path.join(target, 'mcp/relay.cjs')).start({port: 0, idleTimeout: 60000});
  await once(relay.server, 'listening');
  const child = spawn(process.execPath, [path.join(target, 'mcp/server.cjs')], {
    cwd: target, windowsHide: true, env: {...process.env, F2A_MCP_PORT: String(relay.server.address().port), NODE_PATH: ''},
  });
  let text = '', stderr = '', id = 0;
  const pending = new Map();
  child.stderr.on('data', data => {stderr += data;});
  child.stdout.on('data', data => {
    text += data;
    let newline;
    while ((newline = text.indexOf('\n')) >= 0) {
      const line = text.slice(0, newline); text = text.slice(newline + 1);
      let response;
      try {response = JSON.parse(line);} catch {continue;}
      const job = pending.get(response.id);
      if (job) {pending.delete(response.id); clearTimeout(job.timer); response.error ? job.reject(new Error(JSON.stringify(response.error))) : job.resolve(response.result);}
    }
  });
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const current = ++id;
      const timer = setTimeout(() => {pending.delete(current); reject(new Error('MCP timeout: ' + method + ' ' + stderr));}, 15000);
      pending.set(current, {resolve, reject, timer});
      child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: current, method, params}) + '\n');
    });
  }
  try {
    const initialized = await call('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'package-check', version: '1'}});
    assert.equal(initialized.serverInfo.name, 'F2A');
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
    const result = await call('tools/list', {});
    assert.ok(result.tools.length >= 165);
    assert.ok(result.tools.some(tool => tool.name === 'get_f2a_status'));
    assert.ok(result.tools.some(tool => tool.name === 'ae_render_background'));
    return result.tools.length;
  } finally {
    for (const job of pending.values()) clearTimeout(job.timer);
    const ended = once(child, 'exit'); child.kill(); await ended;
    relay.server.closeAllConnections();
    await new Promise(resolve => relay.server.close(resolve));
  }
}

async function check() {
  const archive = path.join(root, 'dist', 'F2A-Windows-x64-v' + version + '.zip');
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'F2A 分发 中文 '));
  // mkdtemp returns this task's disposable directory; never operate on the source checkout.
  assert.equal(path.dirname(scratch), os.tmpdir());
  try {
    const actualHash = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
    assert.equal((await fs.readFile(archive + '.sha256', 'utf8')).split(' ')[0], actualHash);
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:F2A_ZIP_SOURCE, $env:F2A_ZIP_TARGET)'],
    {windowsHide: true, env: {...process.env, F2A_ZIP_SOURCE: archive, F2A_ZIP_TARGET: scratch}});
    assert.deepEqual(await fs.readdir(scratch), ['F2A-Windows-x64']);
    const target = path.join(scratch, 'F2A-Windows-x64');
    const manifest = JSON.parse(await fs.readFile(path.join(target, 'package-manifest.json'), 'utf8'));
    assert.equal(manifest.bundledRuntimes, false);
    const release = JSON.parse(await fs.readFile(path.join(root, 'dist/latest.json'), 'utf8'));
    assert.deepEqual(release, {version: manifest.version, file: path.basename(archive), sha256: actualHash});
    const packaged = [];
    async function walk(directory) {
      for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file); else packaged.push(path.relative(target, file).replaceAll('\\', '/'));
      }
    }
    await walk(target);
    assert.deepEqual(packaged.sort(), [...manifest.files.map(entry => entry.path), 'package-manifest.json'].sort());
    assert.ok(packaged.includes('licenses/cursor-talk-to-figma-mcp.txt'));
    assert.ok(packaged.includes('licenses/figwright.txt'));
    assert.ok(packaged.includes('mcp/vendor/surehand/LICENSE'));
    assert.equal(manifest.files.find(file => file.path === 'mcp/vendor/surehand/surehand-ae.mjs')?.sha256, surehand.sha256);
    for (const file of packaged) {
      assert.doesNotMatch(file, /(?:^|\/)(?:\.git|\.agents|\.venv[^/]*|node_modules|runtime|artifacts|tests|docs)(?:\/|$)|\.(?:exe|dll|pyc|pyo|log|map)$|(?:^|\/)\.env(?:\.|$)/i);
      const data = await fs.readFile(path.join(target, file));
      assert.deepEqual(privacyIssues(data, [path.basename(os.homedir()), os.hostname()]), [], file);
      const entry = manifest.files.find(entry => entry.path === file);
      if (entry) assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256, file);
    }
    // Check Windows PowerShell 5.1 syntax without changing this device's installation or registry.
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:F2A_INSTALL_SCRIPT, [ref]$null, [ref]$e); if ($e) { $e; exit 1 }'],
    {windowsHide: true, env: {...process.env, F2A_INSTALL_SCRIPT: path.join(target, 'scripts/install-f2a.ps1')}});
    console.log('PASS: ZIP inventory, hashes, licenses, privacy scan, no runtimes/local data, installer syntax');

    // Prepare dependencies exactly where the recipient installer places them. No developer venv.
    const env = {...process.env, PYTHONUTF8: '1', NODE_PATH: ''};
    delete env.F2A_PYTHON; delete env.PYTHONHOME; delete env.PYTHONPATH;
    await run('python', ['-m', 'venv', path.join(target, '.venv-aep')], {windowsHide: true, env, timeout: 60000});
    const python = path.join(target, '.venv-aep/Scripts/python.exe');
    await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', path.join(target, 'scripts/aep/requirements.txt')],
      {windowsHide: true, env, timeout: 180000, maxBuffer: 2 * 1024 * 1024});
    await run(python, ['-c', 'import py_aep,tkinter,uharfbuzz; r=tkinter.Tk(); r.withdraw(); r.destroy()'], {windowsHide: true, env});
    const manifestPath = path.join(target, 'package-manifest.json');
    const installedPanel = path.join(target, 'client/index.html');
    const marker = path.join(target, 'user-setting.txt');
    const oldPanel = '<!-- old installed panel -->';
    const oldManifest = {...manifest, version: '1.0.0'};
    await fs.writeFile(manifestPath, JSON.stringify(oldManifest));
    await fs.writeFile(installedPanel, oldPanel);
    await fs.writeFile(marker, 'preserve');
    const broken = path.join(scratch, 'broken-update');
    for (const relative of ['scripts/install-f2a.ps1', 'scripts/aep/requirements.txt', 'client/index.html']) {
      const to = path.join(broken, relative);
      await fs.mkdir(path.dirname(to), {recursive: true});
      await fs.copyFile(path.join(target, relative), to);
    }
    await fs.writeFile(path.join(broken, 'client/index.html'), '<!-- new panel -->');
    await fs.writeFile(path.join(broken, 'package-manifest.json'), JSON.stringify({
      ...manifest, files: [{path: 'client/index.html'}, {path: 'client/missing.js'}]
    }));
    await assert.rejects(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(broken, 'scripts/install-f2a.ps1'), '-InstallDirectory', target, '-Update'], {windowsHide: true, env}));
    assert.deepEqual(JSON.parse(await fs.readFile(manifestPath, 'utf8')), oldManifest);
    assert.equal(await fs.readFile(installedPanel, 'utf8'), oldPanel, 'Failed update restores a file already replaced');
    const updateArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(target, 'scripts/update-f2a.ps1'), '-Archive', archive, '-Sha256', actualHash,
      '-Version', manifest.version, '-InstallDirectory', target];
    await run('powershell.exe', updateArgs, {windowsHide: true, env, timeout: 30000});
    assert.equal(JSON.parse(await fs.readFile(manifestPath, 'utf8')).version, manifest.version);
    assert.equal(await fs.readFile(marker, 'utf8'), 'preserve');
    assert.match(await fs.readFile(installedPanel, 'utf8'), /mk-update/);
    console.log('PASS: Windows updater applies the verified ZIP in place and preserves user files');
    let pickerEntered, releasePicker;
    const picker = new Promise(resolve => { pickerEntered = resolve; });
    const proceed = new Promise(resolve => { releasePicker = resolve; });
    const updateSignal = path.join(target, '.f2a-update-aep');
    const service = require(path.join(target, 'scripts/aep-server.cjs')).start({port: 0, quiet: true, updateSignal,
      tempRoot: scratch, chooseDestination: async () => {
        pickerEntered();
        await proceed;
        return path.join(scratch, '导出 工程');
      }});
    try {
      await once(service, 'listening');
      const base = 'http://127.0.0.1:' + service.address().port;
      const health = await (await fetch(base + '/health')).json();
      assert.equal(health.service, 'f2a-aep'); assert.equal(health.version, 3);
      const exporting = fetch(base + '/export', {method: 'POST', body: JSON.stringify({packet: await fixture()})});
      const earlyResponse = await Promise.race([picker.then(() => null), exporting]);
      assert.equal(earlyResponse, null, earlyResponse && await earlyResponse.text());
      const closed = once(service, 'close');
      await fs.writeFile(updateSignal, 'test');
      for (let attempt = 0; attempt < 30 && service.listening; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(service.listening, false, 'Update stops accepting requests while the active export completes');
      releasePicker();
      const response = await exporting;
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      assert.equal((await fs.readFile(result.project)).toString('ascii', 0, 4), 'RIFX');
      assert.equal(result.counts.texts, 1); assert.equal(result.counts.images, 2);
      assert.deepEqual(result.warnings, []);
      assert.deepEqual((await fs.readdir(result.directory)).sort(), ['Assets', 'report.json', '导出 工程.aep']);
      await closed;
    } finally {
      releasePicker();
      if (service.listening) await new Promise(resolve => service.close(resolve));
    }
    console.log('PASS: extracted Chinese/space path, fresh Python venv, Tk, real AEP export drains on update');
    const tools = await checkMcp(target);
    console.log('PASS: extracted MCP server + relay, no node_modules, initialized and listed ' + tools + ' tools');
  } finally {
    await fs.rm(scratch, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  }
}

check().catch(error => {console.error(error); process.exitCode = 1;});
