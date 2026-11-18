'use strict';

// Build a runtime-only Windows package. Node/Python and local state are never copied.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {createHash} = require('node:crypto');
const {version} = require('../version.json');
const run = promisify(execFile);
const root = path.resolve(__dirname, '..');
const name = 'F2A-Windows-x64';
const output = path.join(root, 'dist', name + '.zip');

// Keep this explicit: new captures, configuration or development files must not enter a release.
const files = [
  'version.json',
  'CSXS/manifest.xml',
  ...['aepLauncher.js', 'ffxGradient.js', 'figmaBridge.js', 'figmaRasterEffects.js',
    'index.html', 'main.js', 'mcpBridge.js', 'mkBridgeServer.js', 'style.css', 'updatePanel.js', 'updateRelease.js'].map(f => 'client/' + f),
  ...['code.js', 'manifest.json', 'ui.html'].map(f => 'figma-plugin/' + f),
  ...['aeShapeBuilder.jsx', 'figmaRunner.jsx', 'svgParser.js', 'grad-template.ffx',
    'gradoverlay-template.ffx', 'gradstroke-template.ffx', 'innershadow-overlay-template.ffx',
    'innershadow-template.ffx', 'stroke-template.ffx'].map(f => 'host/figma/' + f),
  ...['server.cjs', 'relay.cjs', 'launcher.cjs', 'THIRD_PARTY_LICENSES.txt'].map(f => 'mcp/' + f),
  ...['aep-server.cjs', 'export-aep.cjs', 'open-aep-directory.ps1', 'start-aep-export.ps1',
    'install-aep-launcher.ps1', 'install-mcp.ps1', 'install-mcp-dsh.cjs',
    'install-f2a.ps1', 'update-f2a.ps1'].map(f => 'scripts/' + f),
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

async function build() {
  if (process.platform !== 'win32') throw new Error('Build this ZIP on Windows.');
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'f2a-dist-'));
  if (path.dirname(stage) !== os.tmpdir()) throw new Error('Unexpected staging directory.');
  const target = path.join(stage, name);
  const identifiers = [path.basename(os.homedir()), os.hostname()];
  try {
    await fs.mkdir(target);
    for (const file of files) {
      const destination = path.join(target, file);
      await fs.mkdir(path.dirname(destination), {recursive: true});
      await fs.copyFile(path.join(root, file), destination);
    }
    await fs.copyFile(path.join(root, 'scripts/distribution/README.txt'), path.join(target, 'README.txt'));
    await fs.copyFile(path.join(root, 'scripts/distribution/install.cmd'), path.join(target, 'install.cmd'));
    for (const vendor of ['cursor-talk-to-figma-mcp', 'figwright']) {
      await fs.mkdir(path.join(target, 'licenses'), {recursive: true});
      await fs.copyFile(path.join(root, 'mcp/vendor', vendor, 'LICENSE'), path.join(target, 'licenses', vendor + '.txt'));
    }
    const packaged = [...files, 'README.txt', 'install.cmd',
      'licenses/cursor-talk-to-figma-mcp.txt', 'licenses/figwright.txt'].sort();
    const manifest = [];
    for (const file of packaged) {
      const data = await fs.readFile(path.join(target, file));
      const issues = privacyIssues(data, identifiers);
      if (issues.length) throw new Error('Privacy check failed in ' + file + ': ' + issues.join(', '));
      manifest.push({path: file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex')});
    }
    await fs.writeFile(path.join(target, 'package-manifest.json'), JSON.stringify({
      name, version, platform: 'win32', arch: 'x64', bundledRuntimes: false,
      requires: {node: '>=20', python: '>=3.11', pythonTkinter: true}, files: manifest,
    }, null, 2) + '\n');
    // Use .NET so the archive includes exactly the staged tree, with one top-level folder.
    const stagedZip = path.join(stage, name + '.zip');
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
      '[IO.Compression.ZipFile]::CreateFromDirectory($env:F2A_ZIP_SOURCE, $env:F2A_ZIP_TARGET, [IO.Compression.CompressionLevel]::Optimal, $true)'],
    {windowsHide: true, env: {...process.env, F2A_ZIP_SOURCE: target, F2A_ZIP_TARGET: stagedZip}});
    await fs.mkdir(path.dirname(output), {recursive: true});
    await fs.copyFile(stagedZip, output);
    const archive = await fs.readFile(output);
    const sha256 = createHash('sha256').update(archive).digest('hex');
    await fs.writeFile(output + '.sha256', sha256 + '  ' + path.basename(output) + '\n');
    await fs.writeFile(path.join(path.dirname(output), 'latest.json'),
      JSON.stringify({version, file: path.basename(output), sha256}, null, 2) + '\n');
    console.log(JSON.stringify({file: output, files: packaged.length + 1, bytes: archive.length, sha256}));
  } finally {
    await fs.rm(stage, {recursive: true, force: true});
  }
}

if (require.main === module) build().catch(error => {console.error(error.message); process.exitCode = 1;});
module.exports = {files, privacyIssues};
