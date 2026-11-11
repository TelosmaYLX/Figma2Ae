import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';

const root = path.resolve('.'), dir = path.join(root, 'artifacts/direct-aep');
const smoke = JSON.parse(await fs.readFile(path.join(dir, 'test-report.json'), 'utf8'));
const target = await fs.mkdtemp(path.join(dir, 'portable-'));
const sourceAssets = path.join(smoke.directory, 'Assets'), hiddenAssets = sourceAssets + '-verification';
if (!sourceAssets.startsWith(dir + path.sep) || !hiddenAssets.startsWith(dir + path.sep)) throw new Error('Unexpected asset path');
const python = process.env.F2A_PYTHON || path.join(root, '.venv-aep/Scripts/python.exe');
await promisify(execFile)(python, ['-m', 'zipfile', '-e', smoke.archive, target], {windowsHide: true});
const cases = [{name: 'portable', project: path.join(target, 'project.aep'), main: 'Direct AEP smoke',
  width: 640, height: 360, texts: 1, images: 2, portable: target.replaceAll('\\', '/') + '/'}];
try {
  const full = path.resolve(process.argv[2] || path.join(dir, 'full'));
  await fs.access(path.join(full, 'project.aep'));
  cases.push({name: 'full', project: path.join(full, 'project.aep'), main: 'pinball_game_container',
    width: 832, height: 1068, texts: 43, images: 62});
} catch {}
await fs.writeFile(path.join(dir, 'ae-cases.json'), JSON.stringify(cases));
await fs.rm(path.join(dir, 'ae-report.json'), {force: true});
await fs.rename(sourceAssets, hiddenAssets);
try {
  const ae = process.env.F2A_AFTERFX || 'D:/Software/Adobe/Adobe After Effects 2026/Support Files/AfterFX.exe';
  const child = spawn(ae, ['-r', path.join(root, 'tests/ae-direct-aep.jsx')], {windowsHide: true, stdio: 'ignore'});
  let launchError;
  child.on('error', error => { launchError = error; });
  const until = Date.now() + 180000;
  let report;
  while (Date.now() < until) {
    if (launchError) throw launchError;
    try { report = JSON.parse(await fs.readFile(path.join(dir, 'ae-report.json'), 'utf8')); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!report) throw new Error('AE verification timed out');
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally { await fs.rename(hiddenAssets, sourceAssets); }
