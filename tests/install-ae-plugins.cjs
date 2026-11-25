'use strict';

// The installer copies the Figma 调色 plug-in into every AE CC 2019+ install while pulling an
// update, so the effect is there after a restart without waiting for the first export.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const helper = path.join(root, 'scripts/install-ae-plugins.ps1');
const aex = path.join(root, 'ae-plugin/FigmaImageGradePlugin/FigmaImageGrade.aex');

function run(env) {
  return spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-AexPath', aex],
    {encoding: 'utf8', windowsHide: true, env: {...process.env, ...env}});
}

function check() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f2a-install-ae-plugins-'));
  const plugins = path.join(base, 'Adobe After Effects 2026', 'Support Files', 'Plug-ins');
  fs.mkdirSync(plugins, {recursive: true});
  try {
    const first = run({F2A_AE_PLUGINS: plugins});
    assert.equal(first.status, 0);
    const copied = path.join(plugins, 'F2A', 'FigmaImageGrade.aex');
    assert.ok(fs.existsSync(copied), first.stdout + first.stderr);
    assert.deepEqual(fs.readFileSync(copied), fs.readFileSync(aex));
    assert.match(first.stdout, /已复制到 1 个/, first.stdout);

    const second = run({F2A_AE_PLUGINS: plugins});
    assert.equal(second.status, 0);
    assert.match(second.stdout, /已是最新/, second.stdout);

    // A directory that cannot be created only warns: the install itself must not fail.
    const blocker = path.join(base, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const blocked = run({F2A_AE_PLUGINS: path.join(blocker, 'Plug-ins')});
    assert.equal(blocked.status, 0);
    assert.match(blocked.stdout + blocked.stderr, /复制失败/, blocked.stdout + blocked.stderr);

    // A missing package file is reported and still leaves the installer usable.
    const missing = spawnSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
        '-AexPath', path.join(base, 'missing.aex')],
      {encoding: 'utf8', windowsHide: true, env: {...process.env, F2A_AE_PLUGINS: plugins}});
    assert.equal(missing.status, 0);
    assert.match(missing.stdout + missing.stderr, /安装失败/, missing.stdout + missing.stderr);

    console.log('PASS: installer copies Figma 调色 into AE Plug-ins, skips identical files and survives failures');
  } finally { fs.rmSync(base, {recursive: true, force: true}); }
}

if (require.main === module) {
  try { check(); } catch (error) { console.error(error); process.exitCode = 1; }
}
module.exports = {check};
