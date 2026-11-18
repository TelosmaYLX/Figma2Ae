'use strict';

// Build the combined F2A + layer-tidy skill bundle. Node/Python and local state are never copied.
// The inner F2A/ tree is the same explicit allowlist used by scripts/package-dist.cjs.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {createHash} = require('node:crypto');
const {files: f2aFiles, privacyIssues} = require('./package-dist.cjs');
const {version} = require('../version.json');
const run = promisify(execFile);
const root = path.resolve(__dirname, '..');
const bundle = 'F2A-Bundle-v' + version;
const f2a = 'F2A';
const skill = 'f2a-figma-layer-tidy';
const extra = ['README.txt', 'install.cmd'];
const licenseFiles = [
  ['mcp/vendor/cursor-talk-to-figma-mcp/LICENSE', 'licenses/cursor-talk-to-figma-mcp.txt'],
  ['mcp/vendor/figwright/LICENSE', 'licenses/figwright.txt'],
];
// Explicit: reference documents and the pixel gate are the only skill runtime files.
const skillFiles = [
  'SKILL.md',
  'references/f2a-aep-compatibility.md',
  'references/mcp-tool-playbook.md',
  'scripts/compare_pixels.py',
];
const output = path.join(root, 'dist', bundle + '.zip');

async function copy(from, to) {
  await fs.mkdir(path.dirname(to), {recursive: true});
  await fs.copyFile(from, to);
}

async function writeFile(to, data) {
  await fs.mkdir(path.dirname(to), {recursive: true});
  await fs.writeFile(to, data);
}

async function walk(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(full));
    else result.push(full);
  }
  return result.sort();
}

async function stage(target) {
  const f2aRoot = path.join(target, f2a);
  // 1. F2A payload: same allowlist as the standalone package.
  for (const file of f2aFiles) await copy(path.join(root, file), path.join(f2aRoot, file));
  await copy(path.join(root, 'scripts/distribution/README.txt'), path.join(f2aRoot, 'README.txt'));
  await copy(path.join(root, 'scripts/distribution/install.cmd'), path.join(f2aRoot, 'install.cmd'));
  for (const [from, to] of licenseFiles) await copy(path.join(root, from), path.join(f2aRoot, to));

  // 2. F2A manifest: paths stay relative to F2A/, so install-f2a.ps1 keeps working after the move.
  const entries = [...f2aFiles, ...extra, ...licenseFiles.map(([, to]) => to)].sort();
  const manifest = [];
  for (const file of entries) {
    const data = await fs.readFile(path.join(f2aRoot, file));
    manifest.push({path: file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex')});
  }
  await writeFile(path.join(f2aRoot, 'package-manifest.json'), JSON.stringify({
    name: 'F2A-Windows-x64', version, platform: 'win32', arch: 'x64', bundledRuntimes: false,
    requires: {node: '>=20', python: '>=3.11', pythonTkinter: true}, files: manifest,
  }, null, 2) + '\n');

  // 3. Skill and the shared install guide.
  for (const file of skillFiles) {
    await copy(path.join(root, '.agents/skills', skill, file), path.join(target, 'skills', skill, file));
  }
  await copy(path.join(root, 'scripts/distribution/INSTALL.md'), path.join(target, 'INSTALL.md'));
}

async function build() {
  if (process.platform !== 'win32') throw new Error('Build this ZIP on Windows.');
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'f2a-bundle-'));
  if (path.dirname(staging) !== os.tmpdir()) throw new Error('Unexpected staging directory.');
  const target = path.join(staging, bundle);
  const identifiers = [path.basename(os.homedir()), os.hostname()];
  try {
    await fs.mkdir(target);
    await stage(target);
    // Every shipped byte is scanned before an archive exists.
    const staged = await walk(target);
    for (const file of staged) {
      const relative = path.relative(target, file).split(path.sep).join('/');
      const issues = privacyIssues(await fs.readFile(file), identifiers);
      if (issues.length) throw new Error('Privacy check failed in ' + relative + ': ' + issues.join(', '));
    }
    const archive = path.join(staging, bundle + '.zip');
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
      '[IO.Compression.ZipFile]::CreateFromDirectory($env:F2A_ZIP_SOURCE, $env:F2A_ZIP_TARGET, [IO.Compression.CompressionLevel]::Optimal, $true)'],
    {windowsHide: true, env: {...process.env, F2A_ZIP_SOURCE: target, F2A_ZIP_TARGET: archive}});
    await fs.mkdir(path.dirname(output), {recursive: true});
    await fs.copyFile(archive, output);
    const bytes = await fs.readFile(output);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await fs.writeFile(output + '.sha256', sha256 + '  ' + path.basename(output) + '\n');
    console.log(JSON.stringify({file: output, files: staged.length, bytes: bytes.length, sha256}));
  } finally {
    await fs.rm(staging, {recursive: true, force: true});
  }
}

if (require.main === module) build().catch(error => {console.error(error.message); process.exitCode = 1;});
module.exports = {bundle, skill, skillFiles};
