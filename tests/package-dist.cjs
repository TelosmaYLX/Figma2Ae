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
const {gradePacket, inspectEffect} = require('./editable-image-grade.cjs');
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
    assert.ok(result.tools.some(tool => tool.name === 'export_aep'));
    assert.ok(result.tools.some(tool => tool.name === 'ae_animate'));
    assert.ok(result.tools.some(tool => tool.name === 'ae_render_mp4'));
    assert.ok(result.tools.some(tool => tool.name === 'ae_motion_apply'));
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
    const plugin = JSON.parse(await fs.readFile(path.join(target, 'figma-plugin/manifest.json'), 'utf8'));
    const workspacePlugin = require('../figma-plugin/manifest.json');
    assert.equal(plugin.id, 'f2a-ship-to-ae');
    assert.notEqual(plugin.id, workspacePlugin.id);
    assert.notEqual(plugin.name, workspacePlugin.name);
    const manifest = JSON.parse(await fs.readFile(path.join(target, 'package-manifest.json'), 'utf8'));
    assert.equal(manifest.bundledRuntimes, false);
    const {notes, ...release} = JSON.parse(await fs.readFile(path.join(root, 'dist/latest.json'), 'utf8'));
    assert.deepEqual(release, {version: manifest.version, file: path.basename(archive), sha256: actualHash});
    if (notes !== undefined) assert.ok(typeof notes === 'string' && notes.trim());
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
    // The native Figma 调色 effect and the serializer that lets the direct writer add it.
    assert.ok(packaged.includes('ae-plugins/FigmaImageGrade.aex'));
    assert.ok(packaged.includes('scripts/aep/figma_grade.py'));
    assert.ok(packaged.includes('scripts/aep/figma-image-grade-effect.bin'));
    assert.ok(packaged.includes('client/figmaImageGradeEffect.js'));
    assert.ok(packaged.includes('scripts/install-ae-plugins.ps1'));
    assert.ok(packaged.includes('scripts/install-f2a.ps1'));
    assert.ok(packaged.includes('scripts/update-f2a.ps1'));
    assert.ok(packaged.includes('mcp/vendor/surehand/LICENSE'));
    assert.ok(packaged.includes('skills/f2a-figma-layer-tidy/SKILL.md'));
    assert.equal(manifest.files.find(file => file.path === 'mcp/vendor/surehand/surehand-ae.mjs')?.sha256, surehand.sha256);
    for (const file of packaged) {
      assert.doesNotMatch(file, /(?:^|\/)(?:\.git|\.agents|\.venv[^/]*|node_modules|runtime|artifacts|tests|docs)(?:\/|$)|\.(?:exe|dll|pyc|pyo|log|map)$|(?:^|\/)\.env(?:\.|$)/i);
      const data = await fs.readFile(path.join(target, file));
      assert.deepEqual(privacyIssues(data, [path.basename(os.homedir()), os.hostname()]), [], file);
      const entry = manifest.files.find(entry => entry.path === file);
      if (entry) assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256, file);
    }
    // Check Windows PowerShell 5.1 syntax without changing this device's installation or registry.
    for (const script of ['install-f2a.ps1', 'install-ae-plugins.ps1']) {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:F2A_INSTALL_SCRIPT, [ref]$null, [ref]$e); if ($e) { $e; exit 1 }'],
      {windowsHide: true, env: {...process.env, F2A_INSTALL_SCRIPT: path.join(target, 'scripts/' + script)}});
    }
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
    const profile = path.join(scratch, 'Agent 用户');
    const sharedSkills = path.join(profile, '.agents/skills');
    const dshSkills = path.join(profile, '.dsh/skills');
    const customSkills = path.join(scratch, '自定义 Skill');
    const skill = 'f2a-figma-layer-tidy';
    const retiredSkillFile = 'retired-skill/SKILL.md';
    const retiredReference = skill + '/references/retired.md';
    const removed = ['client/retired.js', 'skills/' + retiredSkillFile, 'skills/' + retiredReference];
    const added = 'client/updateRelease.js';
    const writeFixture = async (file, text) => {
      await fs.mkdir(path.dirname(file), {recursive:true});
      await fs.writeFile(file, text);
    };
    // The updater installs the Figma 调色 plug-in; redirect that copy so the test never
    // touches this machine's real After Effects installation.
    const fakePlugins = path.join(scratch, 'fake-ae-plugins');
    const installEnv = {...env, USERPROFILE:profile, CODEX_HOME:'', DSH_HOME:'', CLAUDE_CONFIG_DIR:'',
      F2A_AE_PLUGINS: fakePlugins};
    const otherPackage = path.join(scratch, 'another-package');
    const otherFile = path.join(otherPackage, 'owned.txt');
    await writeFixture(path.join(otherPackage, 'package-manifest.json'), JSON.stringify({name:'another-package', files:[{path:'owned.txt'}]}));
    await fs.writeFile(otherFile, 'keep another package');
    await assert.rejects(run(process.execPath, [path.join(target, 'scripts/install-files.cjs'), otherPackage],
      {windowsHide:true, env:installEnv}), /belongs to another package/);
    assert.equal(await fs.readFile(otherFile, 'utf8'), 'keep another package');
    await fs.mkdir(path.join(profile, '.codex'), {recursive:true});
    const oldManifest = {...manifest, version: '1.0.0', skillDirectories:[sharedSkills, customSkills],
      files:[...manifest.files.filter(file => file.path !== added), ...removed.map(file => ({path:file}))]};
    for (const file of removed) await writeFixture(path.join(target, file), 'old package file');
    for (const directory of oldManifest.skillDirectories) {
      await writeFixture(path.join(directory, retiredSkillFile), 'old skill');
      await writeFixture(path.join(directory, retiredReference), 'old reference');
      await writeFixture(path.join(directory, skill, 'SKILL.md'), 'old entry');
      await writeFixture(path.join(directory, skill, 'user-notes.md'), 'keep my notes');
    }
    await writeFixture(path.join(sharedSkills, 'user-skill/SKILL.md'), 'keep my skill');
    await fs.unlink(path.join(target, added));
    await fs.writeFile(manifestPath, JSON.stringify(oldManifest));
    await fs.writeFile(installedPanel, oldPanel);
    await fs.writeFile(marker, 'preserve');
    const broken = path.join(scratch, 'broken-update');
    for (const relative of ['scripts/install-f2a.ps1', 'scripts/install-files.cjs', 'scripts/aep/requirements.txt', 'client/index.html']) {
      const to = path.join(broken, relative);
      await fs.mkdir(path.dirname(to), {recursive: true});
      await fs.copyFile(path.join(target, relative), to);
    }
    await fs.writeFile(path.join(broken, 'client/index.html'), '<!-- new panel -->');
    await fs.writeFile(path.join(broken, 'package-manifest.json'), JSON.stringify({
      ...manifest, files: [{path: 'client/index.html'}, {path: 'client/missing.js'}]
    }));
    await assert.rejects(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(broken, 'scripts/install-f2a.ps1'), '-InstallDirectory', target, '-Update'], {windowsHide: true, env: installEnv}));
    assert.deepEqual(JSON.parse(await fs.readFile(manifestPath, 'utf8')), oldManifest);
    assert.equal(await fs.readFile(installedPanel, 'utf8'), oldPanel, 'Missing package file prevents any changes');
    const updateArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(target, 'scripts/update-f2a.ps1'), '-Archive', archive, '-Sha256', actualHash,
      '-Version', manifest.version, '-InstallDirectory', target];
    const update = () => run('powershell.exe', updateArgs, {windowsHide:true, env:installEnv, timeout:30000});
    const block = path.join(dshSkills, skill, 'SKILL.md');
    await writeFixture(path.join(block, 'local.txt'), 'directory created by user');
    await assert.rejects(update(), /Expected a file at/);
    assert.deepEqual(JSON.parse(await fs.readFile(manifestPath, 'utf8')), oldManifest);
    assert.equal(await fs.readFile(installedPanel, 'utf8'), oldPanel);
    assert.equal(await fs.readFile(path.join(target, removed[0]), 'utf8'), 'old package file');
    assert.equal(await fs.readFile(path.join(sharedSkills, retiredSkillFile), 'utf8'), 'old skill');
    assert.equal(await fs.readFile(path.join(sharedSkills, skill, 'SKILL.md'), 'utf8'), 'old entry');
    await assert.rejects(fs.access(path.join(target, added)), {code:'ENOENT'});
    assert.equal(await fs.readFile(path.join(block, 'local.txt'), 'utf8'), 'directory created by user');
    await fs.unlink(path.join(block, 'local.txt'));
    await fs.rmdir(block);
    await update();
    const installed = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    assert.equal(installed.version, manifest.version);
    assert.deepEqual(installed.skillDirectories.sort(), [sharedSkills, customSkills, dshSkills].sort());
    assert.equal(await fs.readFile(marker, 'utf8'), 'preserve');
    assert.match(await fs.readFile(installedPanel, 'utf8'), /mk-update/);
    // Pulling the update installs the Figma 调色 plug-in for AE CC 2019+ (redirected here).
    assert.ok((await fs.stat(path.join(fakePlugins, 'F2A/FigmaImageGrade.aex'))).isFile(),
      'the update copies FigmaImageGrade.aex into the AE Plug-ins folder');
    assert.ok((await fs.stat(path.join(fakePlugins, 'F2A/FigmaBackgroundBlur.aex'))).isFile(),
      'the update copies FigmaBackgroundBlur.aex into the AE Plug-ins folder');
    assert.ok((await fs.stat(path.join(target, added))).isFile());
    for (const file of removed) await assert.rejects(fs.access(path.join(target, file)), {code:'ENOENT'});
    const skillEntry = await fs.readFile(path.join(target, 'skills', skill, 'SKILL.md'), 'utf8');
    for (const directory of installed.skillDirectories) {
      assert.equal(await fs.readFile(path.join(directory, skill, 'SKILL.md'), 'utf8'), skillEntry);
      assert.ok((await fs.stat(path.join(directory, skill, 'scripts/compare_pixels.py'))).isFile());
      await assert.rejects(fs.access(path.join(directory, retiredSkillFile)), {code:'ENOENT'});
      await assert.rejects(fs.access(path.join(directory, retiredReference)), {code:'ENOENT'});
    }
    assert.equal(await fs.readFile(path.join(sharedSkills, skill, 'user-notes.md'), 'utf8'), 'keep my notes');
    assert.equal(await fs.readFile(path.join(customSkills, skill, 'user-notes.md'), 'utf8'), 'keep my notes');
    assert.equal(await fs.readFile(path.join(sharedSkills, 'user-skill/SKILL.md'), 'utf8'), 'keep my skill');
    console.log('PASS: Windows updater synchronizes added and retired CEP and Skill files, rolls back a conflict and preserves user files');
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
    // The packaged writer can add the native Figma 调色 effect without After Effects: the
    // effect definition and slider values are serialized into the AEP.
    const gradedPacket = gradePacket();
    const gradedResult = await require(path.join(target, 'scripts/export-aep.cjs'))
      .exportAep(gradedPacket, path.join(scratch, '导出 调色'), {imageGradeMode: 'effect'});
    assert.equal(gradedResult.imageGrade, 'effect');
    await run(python, ['-c', inspectEffect, gradedResult.project, 'flat', gradedPacket.name], {env, windowsHide: true});
    console.log('PASS: packaged native Figma 调色 effect carries the seven Figma values');
    const tools = await checkMcp(target);
    console.log('PASS: extracted MCP server + relay, no node_modules, initialized and listed ' + tools + ' tools');
  } finally {
    await fs.rm(scratch, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  }
}

check().catch(error => {console.error(error); process.exitCode = 1;});
