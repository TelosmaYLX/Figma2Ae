'use strict';

const fs = require('node:fs/promises');
const {existsSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const aeFilename = require('../host/figma/aeFilename.js');
const {normalize, AE_VERSIONS} = require('./aep/packet.cjs');
const imageGradeEffect = require('../client/figmaImageGradeEffect.js');
const root = path.resolve(__dirname, '..');
const run = promisify(execFile);

function pythonPath(options = {}) {
  const bundled = path.join(root, 'runtime/python/python.exe');
  return options.python || process.env.F2A_PYTHON || (existsSync(bundled) ? bundled : path.join(root, '.venv-aep',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
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
  let gradeTables, gradeMode = null;
  try {
    if (model.images.some(image => image.imageFilters)) {
      // Prefer the native Figma 调色 effect; the LUT graph is the fallback for machines
      // where the plug-in cannot be installed and for AEP targets older than AE 2026.
      // The writer only reads gradeTables in LUT mode.
      const grade = imageGradeEffect.resolve(root, {mode: options.imageGradeMode, aeVersion: model.aeVersion});
      gradeMode = grade.mode;
      if (grade.mode === 'effect') {
        model.imageGradeEffect = true;
      } else {
        gradeTables = await fs.mkdtemp(path.join(os.tmpdir(), 'f2a-grade-'));
        model.gradeTables = gradeTables;
        require('../client/figmaImageGrade.js').writeTables(gradeTables, model.images);
      }
    }
    await fs.writeFile(input, JSON.stringify(model));
    await run(pythonPath(options), [path.join(__dirname, 'aep/writer.py'), input, directory],
      {windowsHide: true, maxBuffer: 8 * 1024 * 1024, signal: options.signal, env: {...process.env, PYTHONUTF8: '1'}});
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
    await fs.rm(input, {force: true});
    if (gradeTables) await fs.rm(gradeTables, {recursive:true, force:true});
  }
  const result = JSON.parse(await fs.readFile(path.join(directory, 'report.json'), 'utf8'));
  result.imageGrade = gradeMode;
  result.totalMs = Math.round(performance.now() - started);
  // Packet may contain large base64 images. Keep only the deliverable and diagnostics.
  return {...result, directory, project: path.join(directory, 'project.aep')};
}

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

async function publishAep(packet, destinationFor, options = {}) {
  const temporary = await fs.mkdtemp(path.join(path.resolve(options.tempRoot || os.tmpdir()), 'f2a-aep-'));
  try {
    const prepared = await exportAep(packet, temporary, options);
    if (prepared.warnings.length) {
      const issue = prepared.warnings[0];
      throw new Error('图层「' + (issue.layer || '未知') + '」：' + (issue.detail || issue.code || '存在未导出的属性'));
    }
    const destination = await destinationFor(outputName(packet.name));
    if (!destination) return {cancelled:true};
    options.signal?.throwIfAborted();
    const target = path.resolve(destination);
    const parent = path.dirname(target);
    await fs.mkdir(parent, {recursive:true});
    const directory = await createOutputDirectory(parent, path.basename(target).replace(/\.aep$/i, ''));
    const project = path.join(directory, path.basename(directory) + '.aep');
    try {
      await fs.cp(temporary, directory, {recursive:true});
      await fs.rename(path.join(directory, 'project.aep'), project);
      options.signal?.throwIfAborted();
      return {...prepared, directory, project};
    } catch (error) {
      await fs.rm(directory, {recursive:true, force:true});
      throw error;
    }
  } finally {
    await fs.rm(temporary, {recursive:true, force:true});
  }
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
module.exports = {exportAep, publishAep, chooseDestination, AE_VERSIONS};
