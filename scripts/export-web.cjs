'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const aeFilename = require('../host/figma/aeFilename.js');
const {writeWebBundle} = require('./web/writer.cjs');
const run = promisify(execFile);

function outputName(name) {
  return aeFilename(name, 'Figma', 100);
}

async function createOutputDirectory(parent, name) {
  const base = outputName(name);
  for (let index = 1; ; index++) {
    const directory = path.join(parent, base + (index === 1 ? '' : ' (' + index + ')'));
    try { await fs.mkdir(directory); return directory; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

async function chooseWebDestination(options = {}) {
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const {stdout} = await run(powershell, [
    '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'web/choose-web-destination.ps1'),
  ], {
    windowsHide: true,
    env: {...process.env, F2A_WEB_INITIAL_NAME: options.name || 'Figma'},
  });
  return JSON.parse(stdout.trim()).directory;
}

async function openWebPreview(entryFile) {
  const target = path.resolve(entryFile);
  await fs.access(target);
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  await run(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-Command', 'Start-Process -FilePath $env:F2A_WEB_ENTRY',
  ], {windowsHide: true, timeout: 15000, env: {...process.env, F2A_WEB_ENTRY: target}});
}

async function exportWeb(packet, directory, options = {}) {
  try {
    await fs.access(path.join(directory, 'index.html'));
    throw new Error('输出文件夹已有 index.html，请选择新的文件夹');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return writeWebBundle(packet, directory, options);
}

async function publishWeb(packet, destinationFor, options = {}) {
  const temporary = await fs.mkdtemp(path.join(path.resolve(options.tempRoot || os.tmpdir()), 'f2a-web-'));
  try {
    const prepared = await exportWeb(packet, temporary, options);
    if (prepared.warnings.length) {
      const issue = prepared.warnings[0];
      throw new Error('图层「' + (issue.layer || '未知') + '」：' + (issue.detail || issue.code || '存在未导出的属性'));
    }
    const destination = await destinationFor(outputName(packet.name));
    if (!destination) return {cancelled: true};
    options.signal?.throwIfAborted();
    const target = path.resolve(destination);
    const parent = path.dirname(target);
    await fs.mkdir(parent, {recursive: true});
    const directory = await createOutputDirectory(parent, path.basename(target).replace(/\.html?$/i, ''));
    try {
      await fs.cp(temporary, directory, {recursive: true});
      options.signal?.throwIfAborted();
      return {...prepared, directory, entry: path.join(directory, 'index.html')};
    } catch (error) {
      await fs.rm(directory, {recursive: true, force: true});
      throw error;
    }
  } finally {
    await fs.rm(temporary, {recursive: true, force: true});
  }
}

if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('Usage: node scripts/export-web.cjs packet.json output-directory');
    process.exitCode = 1;
  } else {
    fs.readFile(path.resolve(input), 'utf8')
      .then(source => exportWeb(JSON.parse(source), path.resolve(output)))
      .then(result => console.log(JSON.stringify(result, null, 2)))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}

module.exports = {exportWeb, publishWeb, chooseWebDestination, openWebPreview};
