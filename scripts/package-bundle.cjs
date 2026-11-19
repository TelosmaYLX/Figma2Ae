'use strict';

// Build the Windows package with the expanded install guide and separate skill folders.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {createHash} = require('node:crypto');
const {skillFiles, stagePackage, privacyIssues} = require('./package-dist.cjs');
const {version} = require('../version.json');
const run = promisify(execFile);
const root = path.resolve(__dirname, '..');
const bundle = 'F2A-Bundle-v' + version;
const output = path.join(root, 'dist', bundle + '.zip');

async function copy(from, to) {
  await fs.mkdir(path.dirname(to), {recursive: true});
  await fs.copyFile(from, to);
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
  await stagePackage(path.join(target, 'F2A'));
  for (const file of skillFiles) {
    await copy(path.join(root, file), path.join(target, file));
  }
  await fs.writeFile(path.join(target, 'install.cmd'), '@echo off\r\ncall "%~dp0F2A\\install.cmd" %*\r\nexit /b %errorlevel%\r\n');
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
module.exports = {bundle};
