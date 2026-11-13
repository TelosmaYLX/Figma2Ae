'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {createHash} = require('node:crypto');
const run = promisify(execFile);
const root = path.resolve(__dirname, '..');

async function copyCepExtension(output) {
  const extension = path.join(output, 'cep-extension');
  await fs.mkdir(extension, {recursive:true});
  for (const part of ['client','host','CSXS','.debug']) await fs.cp(path.join(root,part),path.join(extension,part),{recursive:true});
}

async function build(output) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64.');
  const python = process.env.F2A_PYTHON || path.join(root, '.venv-aep/Scripts/python.exe');
  const {stdout} = await run(python, ['-c', 'import json,sys,platform; print(json.dumps({"prefix":sys.base_prefix,"version":platform.python_version(),"major":sys.version_info.major,"minor":sys.version_info.minor,"arch":platform.machine()}))'], {windowsHide:true});
  const info = JSON.parse(stdout);
  if (info.arch !== 'AMD64') throw new Error('A Windows x64 Python runtime is required.');
  await fs.mkdir(output); // Never merge a build with an older distribution.
  const runtime = path.join(output, 'runtime'), bundledPython = path.join(runtime, 'python');
  await fs.mkdir(bundledPython, {recursive:true});
  for (const entry of await fs.readdir(info.prefix)) {
    if (/^(python.*\.(exe|dll)|vcruntime.*\.dll|LICENSE\.txt)$/i.test(entry))
      await fs.copyFile(path.join(info.prefix, entry), path.join(bundledPython, entry));
  }
  const filter = source => !['__pycache__', 'site-packages', 'test', 'tests', 'ensurepip', 'idlelib', 'turtledemo'].includes(path.basename(source)) && !/^_test/.test(path.basename(source));
  for (const part of ['Lib', 'DLLs', 'tcl']) await fs.cp(path.join(info.prefix, part), path.join(bundledPython, part), {recursive:true, filter});
  const siteSource = path.join(path.dirname(path.dirname(python)), 'Lib/site-packages');
  const siteTarget = path.join(bundledPython, 'Lib/site-packages');
  await fs.mkdir(siteTarget, {recursive:true});
  for (const entry of await fs.readdir(siteSource)) {
    if (/^(pip(?:-|$)|__pycache__)/.test(entry)) continue;
    await fs.cp(path.join(siteSource, entry), path.join(siteTarget, entry), {recursive:true, filter: source => !['__pycache__','tests','test'].includes(path.basename(source))});
  }
  // Isolated search paths make the copied runtime independent of Python/PYTHONPATH on the recipient PC.
  await fs.writeFile(path.join(bundledPython, `python${info.major}${info.minor}._pth`), '.\nLib\nDLLs\nLib/site-packages\nimport site\n');
  const bundledNode = path.join(runtime, 'node');
  await fs.mkdir(bundledNode);
  await fs.copyFile(process.execPath, path.join(bundledNode, 'node.exe'));
  const nodeLicense = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`);
  if (!nodeLicense.ok) throw new Error('Cannot retrieve the license for the bundled Node version.');
  await fs.writeFile(path.join(bundledNode, 'LICENSE.txt'), await nodeLicense.text());
  const scripts = ['start-aep-export.ps1', 'install-aep-launcher.ps1', 'install-aep-component.ps1', 'aep-server.cjs', 'export-aep.cjs'];
  await fs.mkdir(path.join(output, 'scripts'));
  for (const file of scripts) await fs.copyFile(path.join(root, 'scripts', file), path.join(output, 'scripts', file));
  await fs.cp(path.join(root, 'scripts/aep'), path.join(output, 'scripts/aep'), {recursive:true, filter: source => path.basename(source) !== '__pycache__'});
  await fs.mkdir(path.join(output, 'host/figma'), {recursive:true});
  await fs.copyFile(path.join(root, 'host/figma/svgParser.js'), path.join(output, 'host/figma/svgParser.js'));
  await fs.cp(path.join(root, 'figma-plugin'), path.join(output, 'figma-plugin'), {recursive:true});
  await copyCepExtension(output);
  await fs.writeFile(path.join(output, 'install.cmd'), '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\install-aep-component.ps1"\r\nif errorlevel 1 (echo Installation failed. & pause & exit /b 1)\r\necho Installation complete.\r\npause\r\n');
  await fs.writeFile(path.join(output, 'README.txt'), instructions);
  const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
  await fs.writeFile(path.join(output, 'runtime-manifest.json'), JSON.stringify({platform:'win32',arch:'x64',node:process.version,python:info.version,
    nodeSha256:await hash(path.join(bundledNode,'node.exe')),pythonSha256:await hash(path.join(bundledPython,'python.exe')),
    requirements:(await fs.readFile(path.join(root,'scripts/aep/requirements.txt'),'utf8')).trim().split(/\r?\n/),offlineInstall:true},null,2));
  console.log(output);
}

if (require.main === module) {
  const output = path.resolve(process.argv[2] || path.join(root, 'artifacts/F2A-AEP-Windows-x64'));
  build(output).catch(error => {console.error(error);process.exitCode=1;});
}
const instructions='\ufeffF2A AEP 导出组件（Windows x64）\r\n\r\n1. 双击 install.cmd，安装到当前用户目录。无需安装 Node、Python 或联网下载依赖。\r\n2. 用 cep-extension 内的文件更新 AE 中已有的 F2A 扩展，重新打开 F2A 面板。\r\n3. 在 Figma 中导入安装后目录下的 figma-plugin/manifest.json。安装程序会显示该路径。\r\n4. 选中内容，点击“导出 AEP（实验）”。AE 面板会在需要时启动本地组件。\r\n\r\n本组件不添加开机启动项。首次冷启动需要打开 AE 的 F2A 面板；工程仍直接写入，不在 AE 中逐层搭建。\r\n保存窗口可改名，生成同名文件夹与 AEP，另含 Assets 和 report.json。\r\n目标 AE 2026；字体需目标设备具备。\r\n';
module.exports = {build,copyCepExtension,instructions};
