'use strict';

/*
 * Builds the portable F2A package for Windows x64 into dist/.
 *
 *   node scripts/package-dist.cjs [--no-aep] [--no-verify]
 *
 * The package carries only what has to be present for F2A to run on another
 * machine: the CEP panel, the MCP server and relay, the Figma plugin and the AEP
 * export service. Node.js and Python are taken from the recipient machine, so no
 * runtime is bundled and the zip stays a few megabytes; install.cmd checks both
 * and prepares the AEP Python environment. Development scripts, documentation,
 * tests, artifacts and licence copies are not part of the package.
 *
 * Two guards keep the build honest:
 *   - every file is scanned for this machine's paths, user and host name, and
 *     the build fails if one survives;
 *   - the finished zip is extracted to a new folder with a space and a non-ASCII
 *     name, its services are started from that copy and a real AEP project is
 *     exported through it, so "unzip and use" is checked rather than assumed.
 */

const fs = require('node:fs/promises');
const {existsSync} = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {promisify} = require('node:util');
const {createHash} = require('node:crypto');
const {once} = require('node:events');
const {execFile} = require('node:child_process');
const run = promisify(execFile);

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist');
const folder = 'F2A-Windows-x64';
const target = path.join(out, folder);
const zipFile = path.join(out, folder + '.zip');

const options = new Set(process.argv.slice(2));
const withAep = !options.has('--no-aep');
const withVerify = !options.has('--no-verify');

// Machine identifiers that must never reach a package handed to someone else.
// They are derived from this machine, not hard-coded, so the check keeps working
// on any build box. Generic placeholders such as `C:/Users/<user>` inside
// third-party docstrings are not identities and stay untouched.
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pathPattern = value => value.split(/[\\/]+/).filter(Boolean).map(escape).join('[\\\\/]+');
const userProfile = process.env.USERPROFILE || os.homedir();
const userName = path.basename(userProfile);
const shortUserName = (process.env.TEMP || '').split(/[\\/]+/).find(part => /^[^\\/~]{1,8}~\d$/.test(part));

const IDENTIFIERS = [
  ['build machine path', new RegExp(pathPattern(root), 'i')],
  ['user profile', new RegExp(pathPattern(userProfile), 'i')],
  ['user name', new RegExp('\\b' + escape(userName) + '\\b', 'i')],
  ...(shortUserName ? [['short user name', new RegExp(escape(shortUserName), 'i')]] : []),
  ['host name', new RegExp(escape(os.hostname()), 'i')],
  ['local Node install', new RegExp(pathPattern(path.dirname(process.execPath)), 'i')],
];

const SKIP_NAMES = new Set(['__pycache__', 'node_modules', '.git', '.DS_Store', 'Thumbs.db']);
const isLicence = name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name) || /^license\.terms$/i.test(name);
const skipFile = name => /\.(pyc|pyo|log|map)$/i.test(name) || isLicence(name);

async function walk(directory, onFile) {
  for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, onFile);
    else await onFile(full);
  }
}

async function copyTree(source, destination) {
  await fs.mkdir(destination, {recursive: true});
  for (const entry of await fs.readdir(source, {withFileTypes: true})) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (!skipFile(entry.name)) await fs.copyFile(from, to);
  }
}

const manifestVersion = xml => (/ExtensionBundleVersion="([^"]+)"/.exec(xml) || [])[1] || '0.0.0';
const sha256 = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');

// --- assembly -------------------------------------------------------------

const SCRIPT_FILES = [
  'aep-server.cjs',
  'export-aep.cjs',
  'open-aep-directory.ps1',
  'start-aep-export.ps1',
  'install-mcp.ps1',
  'install-mcp-dsh.cjs',
  'install-f2a.ps1',
  'uninstall-f2a.ps1',
];
const AEP_FILES = ['packet.cjs', 'writer.py', 'choose-destination.py', 'requirements.txt'];
const AEP_SERVICE_FILES = ['aep-server.cjs', 'export-aep.cjs', 'start-aep-export.ps1', 'open-aep-directory.ps1'];
const MCP_FILES = ['server.cjs', 'relay.cjs', 'launcher.cjs'];
const PLUGIN_FILES = ['manifest.json', 'code.js', 'ui.html'];

const readme = [
  'F2A（Windows x64）',
  '',
  '1. 解压后双击 install.cmd。',
  '   默认安装到 %APPDATA%\\Adobe\\CEP\\extensions\\F2A，并注册 AEP 导出服务与 MCP 服务。',
  '   下文用 <F2A_HOME> 表示这个目录。',
  '2. 重启 After Effects，打开 窗口 → 扩展 → F2A。',
  '3. Figma 桌面版 → Plugins → Development → Import plugin from manifest…',
  '   选择 <F2A_HOME>\\figma-plugin\\manifest.json',
  '',
  '用法：AE 里打开工程并保持 F2A 面板 → Figma 里选中图层运行 F2A →',
  '“导入到 AE”，或“导出 AEP（实验）”（24.x / 25.x / 26.x）。',
  '',
  '环境：Node.js 20 及以上（必需，install.cmd 会检查）；',
  'Python 3.10 及以上 64 位（导出 AEP 需要，首次安装会把两个依赖装进 <F2A_HOME>\\.venv-aep）。',
  '',
  'agent 接入（可选）：MCP 服务为 <F2A_HOME>\\mcp\\server.cjs；',
  'install.cmd 会自动检测 Codex / DSH Desktop。服务名用 f2a，不要覆盖已有的 figma。',
  '',
  '端口 7365 / 7366 / 7367 只监听 127.0.0.1。',
  '卸载：双击 uninstall.cmd。',
].join('\r\n');

const installCmd = [
  '@echo off',
  'setlocal',
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\install-f2a.ps1" %*',
  'if errorlevel 1 (echo. & echo Installation failed. See the message above. & pause & exit /b 1)',
  'echo.',
  'echo Done. Restart After Effects, then open Window ^> Extensions ^> F2A.',
  'pause',
].join('\n');

const uninstallCmd = [
  '@echo off',
  'setlocal',
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\uninstall-f2a.ps1" %*',
  'if errorlevel 1 (echo. & echo Uninstall failed. See the message above. & pause & exit /b 1)',
  'pause',
].join('\n');

async function assemble() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build the package on Windows x64.');
  await fs.rm(target, {recursive: true, force: true});
  await fs.rm(zipFile, {force: true});
  await fs.mkdir(target, {recursive: true});

  for (const part of ['CSXS', 'client', 'host']) await copyTree(path.join(root, part), path.join(target, part));

  await fs.mkdir(path.join(target, 'mcp'), {recursive: true});
  for (const file of MCP_FILES) await fs.copyFile(path.join(root, 'mcp', file), path.join(target, 'mcp', file));

  await fs.mkdir(path.join(target, 'figma-plugin'), {recursive: true});
  for (const file of PLUGIN_FILES)
    await fs.copyFile(path.join(root, 'figma-plugin', file), path.join(target, 'figma-plugin', file));

  await fs.mkdir(path.join(target, 'scripts/aep'), {recursive: true});
  for (const file of SCRIPT_FILES) await fs.copyFile(path.join(root, 'scripts', file), path.join(target, 'scripts', file));
  if (withAep) {
    for (const file of AEP_FILES) await fs.copyFile(path.join(root, 'scripts/aep', file), path.join(target, 'scripts/aep', file));
  } else {
    await fs.rm(path.join(target, 'scripts/aep'), {recursive: true, force: true});
    for (const file of AEP_SERVICE_FILES) await fs.rm(path.join(target, 'scripts', file), {force: true});
  }

  await fs.writeFile(path.join(target, 'README.txt'), '\ufeff' + readme, 'utf8');
  await fs.writeFile(path.join(target, 'install.cmd'), installCmd.replace(/\n/g, '\r\n'), 'ascii');
  await fs.writeFile(path.join(target, 'uninstall.cmd'), uninstallCmd.replace(/\n/g, '\r\n'), 'ascii');

  const metadata = {
    name: 'F2A',
    version: manifestVersion(await fs.readFile(path.join(root, 'CSXS/manifest.xml'), 'utf8')),
    platform: 'win32',
    arch: 'x64',
    builtAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    requires: {node: '>=20', python: withAep ? '>=3.10 (64-bit, tkinter)' : null},
    aepExport: withAep,
    ports: {bridge: 7365, aep: 7366, mcp: 7367},
    entries: {
      panel: 'client/index.html',
      mcp: 'mcp/server.cjs',
      figmaPlugin: 'figma-plugin/manifest.json',
      aepService: withAep ? 'scripts/aep-server.cjs' : null,
    },
  };
  await fs.writeFile(path.join(target, 'VERSION.json'), JSON.stringify(metadata, null, 2) + '\n', 'utf8');
  return metadata;
}

// --- checks ---------------------------------------------------------------

async function scanIdentifiers(directory) {
  const hits = [];
  await walk(directory, async file => {
    const stats = await fs.stat(file);
    if (stats.size > 64 * 1024 * 1024) return;
    const text = (await fs.readFile(file)).toString('utf8');
    for (const [label, pattern] of IDENTIFIERS) {
      const match = pattern.exec(text);
      if (match) hits.push({label, file: path.relative(directory, file), sample: match[0]});
    }
  });
  return hits;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const {port} = probe.address();
      probe.close(() => resolve(true) && resolve(port));
    });
  });
}

function childEnv() {
  const env = {...process.env};
  delete env.F2A_PYTHON;
  delete env.F2A_MCP_PORT;
  return env;
}

async function checkAepService(directory, env) {
  if (!withAep) return 'skipped';
  const node = process.execPath;
  const service = path.join(directory, 'scripts/aep-server.cjs');
  const script = "const s=require(process.argv[1]).start({port:0,quiet:true});s.on('listening',()=>process.stdout.write('PORT:'+s.address().port+'\\n'));";
  const child = spawn(node, ['-e', script, service], {env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '', error = '';
  child.stdout.on('data', part => { output += part; });
  child.stderr.on('data', part => { error += part; });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('AEP service did not start: ' + (error || output))), 20000);
      child.stdout.on('data', () => {
        const match = /PORT:(\d+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      child.once('error', failure => { clearTimeout(timer); reject(failure); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('AEP service exited: ' + code + ' ' + error)); });
    });
    const health = await (await fetch('http://127.0.0.1:' + port + '/health')).json();
    if (health.service !== 'f2a-aep') throw new Error('AEP service health is wrong: ' + JSON.stringify(health));
    if (!health.aeVersions?.length) throw new Error('AEP service reported no target AE versions.');
    return 'f2a-aep v' + health.version + ' (AE ' + health.aeVersions.join('/') + ')';
  } finally {
    const exited = once(child, 'exit');
    child.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  }
}

async function checkAepExport(directory) {
  if (!withAep) return 'skipped';
  let fixture;
  try { ({fixture} = require(path.join(root, 'tests/direct-aep.cjs'))); }
  catch (error) { return 'skipped (fixture unavailable: ' + error.message + ')'; }
  const python = process.env.F2A_PYTHON || path.join(root, '.venv-aep', 'Scripts/python.exe');
  if (!existsSync(python)) return 'skipped (no local Python environment to export with)';

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'F2A export check '));
  try {
    const packetFile = path.join(work, 'packet.json');
    await fs.writeFile(packetFile, JSON.stringify(await fixture()));
    const output = path.join(work, 'out');
    const script = "const {exportAep}=require(process.argv[1]);const fs=require('node:fs');" +
      "exportAep(JSON.parse(fs.readFileSync(process.argv[2],'utf8')),process.argv[3])" +
      ".then(r=>process.stdout.write(JSON.stringify({counts:r.counts,project:r.project})))" +
      ".catch(e=>{console.error(e.message);process.exit(1);});";
    const {stdout} = await run(process.execPath,
      ['-e', script, path.join(directory, 'scripts/export-aep.cjs'), packetFile, output],
      {env: {...process.env, F2A_PYTHON: python}, windowsHide: true, maxBuffer: 16 * 1024 * 1024});
    const result = JSON.parse(stdout);
    const header = (await fs.readFile(result.project)).toString('ascii', 0, 4);
    if (header !== 'RIFX') throw new Error('The exported project is not a RIFX AEP file.');
    const contents = (await fs.readdir(output)).sort();
    if (!contents.includes('Assets') || !contents.includes('report.json'))
      throw new Error('Export folder is incomplete: ' + contents.join(', '));
    return 'real .aep ' + JSON.stringify(result.counts) + ' -> ' + header;
  } finally {
    await fs.rm(work, {recursive: true, force: true, maxRetries: 10, retryDelay: 200}).catch(() => {});
  }
}

async function checkMcpServer(directory, env) {
  const node = process.execPath;
  const port = await freePort();
  const child = execFile(node, [path.join(directory, 'mcp/server.cjs')], {
    env: {...env, F2A_MCP_PORT: String(port)}, windowsHide: true,
  });
  const pending = new Map();
  let nextId = 0, buffer = '', stderr = '';
  child.stderr.on('data', part => { stderr += part; });
  child.stdout.on('data', part => {
    buffer += part;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n'), line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let response;
      try { response = JSON.parse(line); } catch { continue; }
      const job = pending.get(response.id);
      if (!job) continue;
      pending.delete(response.id);
      clearTimeout(job.timer);
      response.error ? job.reject(new Error(JSON.stringify(response.error))) : job.resolve(response.result);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout: ' + method + ' ' + stderr)); }, 30000);
    pending.set(id, {resolve, reject, timer});
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
  });
  try {
    await call('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'F2A package check', version: '1'}});
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
    const tools = await call('tools/list');
    if (!tools.tools?.length) throw new Error('MCP server listed no tools.');
    if (!tools.tools.some(tool => tool.name === 'get_f2a_status')) throw new Error('MCP server is missing get_f2a_status.');
    return tools.tools.length + ' tools';
  } finally {
    const healthy = await fetch('http://127.0.0.1:' + port + '/health').then(response => response.json()).catch(() => null);
    const exited = once(child, 'exit');
    child.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    // The relay is detached on purpose; stop the one this check started.
    if (healthy?.pid) { try { process.kill(healthy.pid); } catch {} }
  }
}

async function verify(directory) {
  const hits = await scanIdentifiers(directory);
  if (hits.length) {
    const list = hits.slice(0, 20).map(hit => `  ${hit.label}: ${hit.file} -> ${hit.sample}`).join('\n');
    throw new Error('The package still names the build machine:\n' + list);
  }
  const env = childEnv();
  return {
    aepService: await checkAepService(directory, env),
    aepExport: await checkAepExport(directory),
    mcp: await checkMcpServer(directory, env),
  };
}

// --- zip ------------------------------------------------------------------

async function zip(destination, source, includeBase) {
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
    "[IO.Compression.ZipFile]::CreateFromDirectory('" + source.replace(/'/g, "''") + "','" +
    destination.replace(/'/g, "''") + "',[IO.Compression.CompressionLevel]::Optimal," + (includeBase ? '$true' : '$false') + ")";
  await run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {windowsHide: true});
}

async function unzip(archive, destination) {
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
    "[IO.Compression.ZipFile]::ExtractToDirectory('" + archive.replace(/'/g, "''") + "','" + destination.replace(/'/g, "''") + "')";
  await run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {windowsHide: true});
}

async function sizeOf(directory) {
  let bytes = 0, files = 0;
  await walk(directory, async file => { bytes += (await fs.stat(file)).size; files++; });
  return {bytes, files};
}

// --- entry ----------------------------------------------------------------

async function build() {
  console.log('building ' + folder + (withAep ? '' : ' (no AEP export)'));
  const metadata = await assemble();
  const built = await sizeOf(target);
  console.log('  staged ' + built.files + ' files, ' + (built.bytes / 1024).toFixed(0) + ' KB');
  console.log('  no local paths, user or host name in the package');

  await zip(zipFile, target, true);
  console.log('  ' + path.relative(root, zipFile) + '  ' + ((await fs.stat(zipFile)).size / 1024).toFixed(0) +
    ' KB  sha256 ' + (await sha256(zipFile)).slice(0, 16));

  if (!withVerify) {
    console.log('verification skipped (--no-verify)');
    return metadata;
  }

  const unpacked = await fs.mkdtemp(path.join(os.tmpdir(), 'F2A unzip check '));
  try {
    const extracted = path.join(unpacked, '解压 目录');
    await unzip(zipFile, extracted);
    const report = await verify(path.join(extracted, folder));
    console.log('  verified from the extracted zip:');
    console.log('    aep service ' + report.aepService);
    console.log('    aep export  ' + report.aepExport);
    console.log('    mcp         ' + report.mcp);
  } finally {
    // A detached relay or a just-killed service can hold a file for a moment.
    await fs.rm(unpacked, {recursive: true, force: true, maxRetries: 20, retryDelay: 250})
      .catch(error => console.warn('warning: could not remove ' + unpacked + ' (' + error.code + ')'));
  }
  console.log('done');
  return metadata;
}

if (require.main === module) {
  build().catch(error => { console.error(error.message || error); process.exitCode = 1; });
}

module.exports = {build, scanIdentifiers, IDENTIFIERS};
