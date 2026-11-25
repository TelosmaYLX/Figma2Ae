'use strict';

// The installer copies every packaged native AE effect (Figma 调色 + Figma 背景模糊) into
// each AE CC 2019+ install while installing or pulling an update, so the effects are there
// after a restart without waiting for the first export.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const helper = path.join(root, 'scripts/install-ae-plugins.ps1');
const grade = path.join(root, 'ae-plugin/FigmaImageGradePlugin/FigmaImageGrade.aex');
const blur = path.join(root, 'ae-plugin/FigmaBackgroundBlurPlugin/FigmaBackgroundBlur.aex');

function run(script, args, env) {
  return spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    {encoding: 'utf8', windowsHide: true, env: {...process.env, ...env}});
}

function check() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f2a-install-ae-plugins-'));
  const plugins = path.join(base, 'Adobe After Effects 2026', 'Support Files', 'Plug-ins');
  fs.mkdirSync(plugins, {recursive: true});
  try {
    // The packaged layout: <package>\scripts\install-ae-plugins.ps1 + <package>\ae-plugins\*.aex.
    // Running it without -AexPath installs every bundled plug-in, so install and update
    // ship both effects without the caller naming them.
    const pkg = path.join(base, 'package');
    fs.mkdirSync(path.join(pkg, 'scripts'), {recursive: true});
    fs.mkdirSync(path.join(pkg, 'ae-plugins'), {recursive: true});
    fs.copyFileSync(helper, path.join(pkg, 'scripts/install-ae-plugins.ps1'));
    fs.copyFileSync(grade, path.join(pkg, 'ae-plugins/FigmaImageGrade.aex'));
    fs.copyFileSync(blur, path.join(pkg, 'ae-plugins/FigmaBackgroundBlur.aex'));
    const packaged = path.join(pkg, 'scripts/install-ae-plugins.ps1');
    // The Chinese messages need a UTF-8 BOM for Windows PowerShell 5.1 to read the script.
    assert.deepEqual(fs.readFileSync(packaged).subarray(0, 3), Buffer.from([0xEF, 0xBB, 0xBF]));

    const first = run(packaged, [], {F2A_AE_PLUGINS: plugins});
    assert.equal(first.status, 0);
    const copiedGrade = path.join(plugins, 'F2A', 'FigmaImageGrade.aex');
    const copiedBlur = path.join(plugins, 'F2A', 'FigmaBackgroundBlur.aex');
    assert.ok(fs.existsSync(copiedGrade), first.stdout + first.stderr);
    assert.ok(fs.existsSync(copiedBlur), first.stdout + first.stderr);
    assert.deepEqual(fs.readFileSync(copiedGrade), fs.readFileSync(grade));
    assert.deepEqual(fs.readFileSync(copiedBlur), fs.readFileSync(blur));
    assert.match(first.stdout, /已复制到 1 个/, first.stdout);

    const second = run(packaged, [], {F2A_AE_PLUGINS: plugins});
    assert.equal(second.status, 0);
    assert.match(second.stdout, /已是最新/, second.stdout);

    // A single -AexPath string still works (tests and custom installs pass one file).
    const single = path.join(base, 'single');
    fs.mkdirSync(single, {recursive: true});
    const one = run(helper, ['-AexPath', grade], {F2A_AE_PLUGINS: single});
    assert.equal(one.status, 0);
    assert.ok(fs.existsSync(path.join(single, 'F2A/FigmaImageGrade.aex')), one.stdout + one.stderr);
    assert.ok(!fs.existsSync(path.join(single, 'F2A/FigmaBackgroundBlur.aex')));

    // A directory that cannot be created only warns: the install itself must not fail.
    const blocker = path.join(base, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const blocked = run(packaged, [], {F2A_AE_PLUGINS: path.join(blocker, 'Plug-ins')});
    assert.equal(blocked.status, 0);
    assert.match(blocked.stdout + blocked.stderr, /复制失败/, blocked.stdout + blocked.stderr);

    // A missing package file is reported and still leaves the installer usable.
    const missing = run(packaged, ['-AexPath', path.join(base, 'missing.aex')], {F2A_AE_PLUGINS: plugins});
    assert.equal(missing.status, 0);
    assert.match(missing.stdout + missing.stderr, /安装失败/, missing.stdout + missing.stderr);

    console.log('PASS: installer copies both Figma AE plug-ins into AE Plug-ins, skips identical files and survives failures');
  } finally { fs.rmSync(base, {recursive: true, force: true}); }
}

if (require.main === module) {
  try { check(); } catch (error) { console.error(error); process.exitCode = 1; }
}
module.exports = {check};
