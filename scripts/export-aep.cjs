'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {normalize} = require('./aep/packet.cjs');
const root = path.resolve(__dirname, '..');
const run = promisify(execFile);

function pythonPath(options = {}) {
  return options.python || process.env.F2A_PYTHON || path.join(root, '.venv-aep',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}

async function chooseDirectory(options = {}) {
  const {stdout} = await run(pythonPath(options), [path.join(__dirname, 'aep/choose-directory.py')],
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
    if (error.code === 'ENOENT') throw new Error('请先运行 scripts/start-aep-export.ps1');
    const detail = (error.stderr || error.message).trim();
    const message = detail.split(/\r?\n/).at(-1).replace(/^\w*Error: /, '');
    throw new Error(message, {cause: error});
  }
  const result = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8'));
  result.totalMs = Math.round(performance.now() - started);
  // Packet may contain large base64 images. Keep only the deliverable and diagnostics.
  await fs.unlink(input);
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
module.exports = {exportAep, chooseDirectory};
