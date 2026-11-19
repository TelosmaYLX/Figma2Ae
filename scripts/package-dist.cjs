'use strict';

// Build a runtime-only Windows package. Node/Python and local state are never copied.
const fs = require('node:fs/promises');
const {existsSync, readdirSync} = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {createHash} = require('node:crypto');
const {version} = require('../version.json');
const run = promisify(execFile);
const root = path.resolve(__dirname, '..');
const name = 'F2A-Windows-x64';
const zipName = name + '-v' + version + '.zip';
const output = path.join(root, 'dist', zipName);

function runtimeFiles(directory) {
  return readdirSync(path.join(root, directory), {withFileTypes: true}).flatMap(entry => {
    if (entry.name.startsWith('.') || /^(?:__pycache__|node_modules|artifacts|runtime|tests|docs)$/i.test(entry.name)) return [];
    const file = directory + '/' + entry.name;
    if (entry.isDirectory()) return runtimeFiles(file);
    return entry.isFile() && !/\.(?:exe|dll|pyc|pyo|log|map)$/i.test(entry.name) ? [file] : [];
  });
}

const skillsRoot = path.join(root, 'skills');
const skillFiles = existsSync(skillsRoot) ? readdirSync(skillsRoot, {withFileTypes: true})
  .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && existsSync(path.join(skillsRoot, entry.name, 'SKILL.md')))
  .flatMap(entry => runtimeFiles('skills/' + entry.name)) : [];

// Ship the runtime trees. Mixed source and tooling directories use explicit file lists.
const files = [
  'version.json',
  'CSXS/manifest.xml',
  ...['client', 'figma-plugin', 'host/figma'].flatMap(runtimeFiles),
  ...skillFiles,
  ...['server.cjs', 'relay.cjs', 'launcher.cjs', 'THIRD_PARTY_LICENSES.txt'].map(f => 'mcp/' + f),
  ...['surehand-ae.mjs', 'LICENSE', 'THIRD_PARTY_LICENSES.txt'].map(f => 'mcp/vendor/surehand/' + f),
  ...['aep-server.cjs', 'export-aep.cjs', 'open-aep-directory.ps1', 'start-aep-export.ps1',
    'install-aep-launcher.ps1', 'install-mcp.ps1', 'install-mcp-dsh.cjs',
    'install-f2a.ps1', 'install-files.cjs', 'update-f2a.ps1'].map(f => 'scripts/' + f),
  ...['choose-destination.py', 'packet.cjs', 'requirements.txt', 'writer.py'].map(f => 'scripts/aep/' + f),
];

function privacyIssues(buffer, identifiers) {
  const rules = [
    ['personal identifier', new RegExp(identifiers.filter(v => v.length >= 4)
      .map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i')],
    ['local absolute path', /\b[A-Z]:[\\/]+(?:Users|Tools|AAA Work)[\\/]+|\/(?:Users|home)\//i],
    ['credential', /\b(?:sk-[\w-]{20,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,})|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ];
  // AE presets may store strings as UTF-16 as well as UTF-8.
  const texts = [buffer.toString('utf8'), buffer.toString('utf16le'),
    Buffer.from(buffer.subarray(0, buffer.length - buffer.length % 2)).swap16().toString('utf16le')];
  return rules.filter(([, re]) => texts.some(text => re.test(text))).map(([label]) => label);
}

async function stagePackage(target) {
  const identifiers = [path.basename(os.homedir()), os.hostname()];
  const entries = files.map(file => [file, file]);
  for (const file of ['README.txt', 'INSTALL.md', 'install.cmd']) entries.push(['scripts/distribution/' + file, file]);
  for (const vendor of ['cursor-talk-to-figma-mcp', 'figwright']) {
    entries.push(['mcp/vendor/' + vendor + '/LICENSE', 'licenses/' + vendor + '.txt']);
  }
  const manifest = [];
  for (const [source, file] of entries.sort((a, b) => a[1].localeCompare(b[1]))) {
    const data = await fs.readFile(path.join(root, source));
    const issues = privacyIssues(data, identifiers);
    if (issues.length) throw new Error('Privacy check failed in ' + file + ': ' + issues.join(', '));
    const destination = path.join(target, file);
    await fs.mkdir(path.dirname(destination), {recursive: true});
    await fs.writeFile(destination, data);
    manifest.push({path: file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex')});
  }
  await fs.writeFile(path.join(target, 'package-manifest.json'), JSON.stringify({
    name, version, platform: 'win32', arch: 'x64', bundledRuntimes: false,
    requires: {node: '>=20', python: '>=3.11', pythonTkinter: true}, files: manifest,
  }, null, 2) + '\n');
  return manifest.length + 1;
}

async function build(notesFile) {
  if (process.platform !== 'win32') throw new Error('Build this ZIP on Windows.');
  const release = {version, file: zipName, sha256: '0'.repeat(64)};
  if (notesFile) {
    const notes = (await fs.readFile(notesFile, 'utf8')).trim();
    const issues = privacyIssues(Buffer.from(notes), [path.basename(os.homedir()), os.hostname()]);
    if (issues.length) throw new Error('Privacy check failed in release notes: ' + issues.join(', '));
    if (notes) release.notes = notes;
    if (Buffer.byteLength(JSON.stringify(release, null, 2) + '\n') > 64 * 1024) throw new Error('Release notes are too long.');
  }
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'f2a-dist-'));
  if (path.dirname(stage) !== os.tmpdir()) throw new Error('Unexpected staging directory.');
  const target = path.join(stage, name);
  try {
    const packaged = await stagePackage(target);
    // Use .NET so the archive includes exactly the staged tree, with one top-level folder.
    const stagedZip = path.join(stage, zipName);
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
      '[IO.Compression.ZipFile]::CreateFromDirectory($env:F2A_ZIP_SOURCE, $env:F2A_ZIP_TARGET, [IO.Compression.CompressionLevel]::Optimal, $true)'],
    {windowsHide: true, env: {...process.env, F2A_ZIP_SOURCE: target, F2A_ZIP_TARGET: stagedZip}});
    await fs.mkdir(path.dirname(output), {recursive: true});
    await fs.copyFile(stagedZip, output);
    const archive = await fs.readFile(output);
    const sha256 = createHash('sha256').update(archive).digest('hex');
    await fs.writeFile(output + '.sha256', sha256 + '  ' + path.basename(output) + '\n');
    release.sha256 = sha256;
    await fs.writeFile(path.join(path.dirname(output), 'latest.json'),
      JSON.stringify(release, null, 2) + '\n');
    console.log(JSON.stringify({file: output, files: packaged, bytes: archive.length, sha256}));
  } finally {
    await fs.rm(stage, {recursive: true, force: true});
  }
}

if (require.main === module) build(process.argv[2]).catch(error => {console.error(error.message); process.exitCode = 1;});
module.exports = {files, skillFiles, privacyIssues, stagePackage};
