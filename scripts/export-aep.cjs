'use strict';

const fs = require('node:fs/promises');
const {existsSync} = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {normalize, AE_VERSIONS} = require('./aep/packet.cjs');
const root = path.resolve(__dirname, '..');
const run = promisify(execFile);

function pythonPath(options = {}) {
  // An explicit choice wins, then the bundled runtime, then the environment the
  // installer created, then whatever Python the PATH offers. The last fallback
  // keeps a package without runtimes usable when the recipient installed the AEP
  // dependencies into their own Python.
  const overridden = options.python || process.env.F2A_PYTHON;
  if (overridden) return overridden;
  const bundled = path.join(root, 'runtime/python/python.exe');
  if (existsSync(bundled)) return bundled;
  const environment = path.join(root, '.venv-aep', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (existsSync(environment)) return environment;
  return process.platform === 'win32' ? 'python.exe' : 'python';
}

async function chooseDestination(options = {}) {
  const {stdout} = await run(pythonPath(options), [path.join(__dirname, 'aep/choose-destination.py'), options.name],
    {windowsHide: true, env: {...process.env, PYTHONUTF8: '1'}});
  return JSON.parse(stdout).directory;
}

async function exportAep(packet, directory, options = {}) {
  const started = performance.now();
  const model = normalize(packet);
  try {
    await fs.access(path.join(directory, 'project.aep'));
    throw new Error('输出文件夹已有 project.aep，请选择新的文件夹');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(directory, {recursive: true});
  const input = path.join(directory, 'packet.json');
  await fs.writeFile(input, JSON.stringify(model));
  try {
    await run(pythonPath(options), [path.join(__dirname, 'aep/writer.py'), input, directory],
      {windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: {...process.env, PYTHONUTF8: '1'}});
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('AEP 导出组件缺少 Python，请重新安装');
    const detail = (error.stderr || error.message).trim();
    const last = detail.split(/\r?\n/).at(-1);
    let issue;
    try { issue = JSON.parse(last); } catch {}
    const failure = new Error(issue?.error || last.replace(/^\w*Error: /, ''), {cause: error});
    failure.nodeId = issue?.nodeId || null;
    throw failure;
  } finally {
    await fs.unlink(input);
  }
  const result = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8'));
  result.totalMs = Math.round(performance.now() - started);
  // Packet may contain large base64 images. Keep only the deliverable and diagnostics.
  return {...result, directory, project: path.join(directory, 'project.aep')};
}

if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('Usage: node scripts/export-aep.cjs packet.json output-directory');
    process.exitCode = 1;
  } else {
    fs.readFile(path.resolve(input), 'utf8')
      .then(source => exportAep(JSON.parse(source), path.resolve(output)))
      .then(result => console.log(JSON.stringify(result, null, 2)))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
module.exports = {exportAep, chooseDestination, AE_VERSIONS};
