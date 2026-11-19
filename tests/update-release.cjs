'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const {createHash} = require('node:crypto');
const {EventEmitter} = require('node:events');
const {check, install} = require('../client/updateRelease.js');

async function verifyPanel() {
  const source = await fs.readFile(path.join(__dirname, '../client/updatePanel.js'), 'utf8');
  const extension = path.resolve('F2A test install');
  const changelog = '修复图片名称 <蒙版>\n改进 AEP 导出';
  const available = {version: '1.2.0', url: 'fixture.zip', notes: changelog};
  for (const {installedPackage, release} of [
    {installedPackage: false, release: available},
    {installedPackage: true, release: available},
    {installedPackage: true, release: null},
    {installedPackage: true, release: {...available, notes: ''}},
  ]) {
    const update = !!release;
    const canInstall = installedPackage && update;
    const button = {hidden: true, textContent: '检查更新'}, notice = {hidden: true, open: false};
    const version = {}, title = {}, notes = {set innerHTML(_) { assert.fail('Release notes must be plain text'); }};
    const elements = {'mk-update': button, 'mk-update-notice': notice, 'mk-version': version,
      'mk-update-title': title, 'mk-update-notes': notes};
    const reports = [], checks = [];
    let installations = 0, checkError;
    vm.runInNewContext(source, {
      window: {__adobe_cep__: {getSystemPath: () => extension}, MKReport: message => reports.push(message)},
      process: {platform: 'win32'},
      document: {getElementById: id => elements[id]},
      require(name) {
        if (name === 'path') return path;
        if (name === 'fs') return {
          existsSync: file => path.basename(file) === (installedPackage ? 'package-manifest.json' : 'version.json')
            || (!installedPackage && path.basename(file) === '.git'),
          readFileSync: () => '{"version":"1.1.0"}'
        };
        return {check: async installed => {
          checks.push(installed);
          if (checkError) throw checkError;
          return release;
        }, install: async (_, pending) => { assert.equal(pending, release); installations++; }};
      }
    });
    assert.equal(button.hidden, false, 'The update entry is visible in both package and source panels');
    assert.equal(version.textContent, 'v1.1.0');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(checks, ['1.1.0'], 'Startup checks once in both installation modes');
    assert.equal(notice.hidden, !update);
    assert.equal(notice.open, false);
    if (update) {
      assert.equal(title.textContent, 'v1.2.0 · 有可用更新');
      assert.equal(notes.textContent, release.notes || '暂无发布说明。');
      assert.match(reports[0], /发现新版 v1\.2\.0/);
    } else {
      assert.equal(notes.textContent, undefined);
      assert.deepEqual(reports, []);
    }
    assert.equal(button.textContent, canInstall ? '更新到 1.2.0' : '检查更新');
    if (canInstall) notice.open = true;
    await button.onclick();
    assert.equal(installations, canInstall ? 1 : 0);
    if (canInstall) {
      assert.match(reports[1], /已更新到 1\.2\.0/);
      assert.equal(button.textContent, '已更新');
      assert.equal(notice.hidden, true);
      assert.equal(notice.open, false);
    } else {
      assert.deepEqual(checks, ['1.1.0', '1.1.0']);
      assert.equal(notice.hidden, !update);
      assert.equal(notice.open, update);
      if (!update) assert.equal(reports.at(-1), '暂无可用更新。');
      checkError = new TypeError('The listener argument must be of type function');
      await button.onclick();
      assert.equal(reports.at(-1), '检查更新失败，请重试。');
    }
  }
}

async function verifyCepTransport() {
  const source = await fs.readFile(path.join(__dirname, '../client/updateRelease.js'), 'utf8');
  const module = {exports: {}};
  vm.runInNewContext(source, {
    module, Buffer,
    URL: class {constructor() {throw new Error('Browser URL passed into Node transport');}},
    require(name) {
      if (name !== 'https') return require(name);
      return {get(options, listener) {
        assert.equal(typeof listener, 'function');
        assert.equal(options.hostname, 'github.com');
        assert.match(options.path, /\/releases\/latest\/download\/latest\.json$/);
        assert.equal(options.headers.Accept, 'application/octet-stream');
        assert.equal(options.headers.Authorization, undefined);
        const request = new EventEmitter();
        request.setTimeout = () => {};
        process.nextTick(() => {
          const response = new EventEmitter();
          response.statusCode = 200;
          listener(response);
          response.emit('data', Buffer.from('{"version":"1.1.0"}'));
          response.emit('end');
        });
        return request;
      }};
    }
  });
  assert.equal(await module.exports.check('1.1.0'), null);
}

async function verify() {
  const file = 'F2A-Windows-x64-v1.10.0.zip';
  const bytes = Buffer.from('Windows ZIP fixture');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const manifest = {version: '1.10.0', file, sha256: digest, notes: '  Changes\nFix paths\n'};
  const release = {body: '## Earlier release notes', body_text: '  Release notes\nLegacy path fix\n'};
  const downloads = 'https://github.com/TelosmaYLX/Figma2Ae/releases/';
  const latest = downloads + 'latest/download/latest.json';
  const notesUrl = 'https://api.github.com/repos/TelosmaYLX/Figma2Ae/releases/tags/v1.10.0';
  const replies = new Map([
    [latest, manifest],
    [notesUrl, release],
  ]);
  const requested = [];
  const get = async (url, accept) => {
    requested.push(url);
    assert.equal(accept, url === notesUrl ? 'application/vnd.github.text+json' : 'application/octet-stream');
    const reply = replies.get(url);
    if (reply instanceof Error) throw reply;
    if (!reply) throw Object.assign(new Error('Not found'), {status: 404});
    return Buffer.from(JSON.stringify(reply));
  };
  const options = {get};
  assert.equal(await check('1.11.0', options), null);
  requested.length = 0;
  assert.equal(await check('1.10.0', options), null);
  assert.deepEqual(requested, [latest], 'An up-to-date install only needs the public manifest');
  requested.length = 0;
  const update = await check('1.9.0', options);
  assert.equal(update.version, '1.10.0');
  assert.equal(update.notes, 'Changes\nFix paths');
  assert.equal(update.url, downloads + 'download/v1.10.0/' + file);
  assert.deepEqual(requested, [latest], 'A manifest that includes notes needs no GitHub API request');
  delete manifest.notes;
  manifest.file = 'F2A-Windows-x64.zip';
  assert.equal((await check('1.9.0', options)).notes, 'Release notes\nLegacy path fix');
  delete release.body_text;
  const legacyUpdate = await check('1.9.0', options);
  assert.equal(legacyUpdate.url, downloads + 'download/v1.10.0/F2A-Windows-x64.zip');
  assert.equal(legacyUpdate.notes, release.body);
  replies.set(notesUrl, Object.assign(new Error('API rate limit'), {status: 403}));
  const limited = await check('1.9.0', options);
  assert.equal(limited.url, legacyUpdate.url);
  assert.equal(limited.notes, '');
  manifest.file = 'F2A-Windows-x64-v1.9.0.zip';
  await assert.rejects(check('1.9.0', options), /清单无效/);
  manifest.file = file;
  manifest.sha256 = 'invalid';
  await assert.rejects(check('1.9.0', options), /清单无效/);
  replies.delete(latest);
  assert.equal(await check('1.9.0', options), null);

  const extension = path.resolve('F2A test install');
  let archive;
  const apply = {get: async (url, accept) => {
    assert.equal(url, update.url);
    assert.equal(accept, 'application/octet-stream');
    return bytes;
  }, execute: async (program, args) => {
    assert.match(program, /powershell\.exe$/i);
    assert.ok(args.includes(path.join(extension, 'scripts/update-f2a.ps1')));
    assert.equal(args[args.indexOf('-InstallDirectory') + 1], extension);
    archive = args[args.indexOf('-Archive') + 1];
    assert.deepEqual(await fs.readFile(archive), bytes);
  }};
  await assert.rejects(install(extension, {...update, sha256: 'invalid'}, apply), /校验失败/);
  assert.equal(archive, undefined);
  await install(extension, update, apply);
  await assert.rejects(fs.stat(path.dirname(archive)), {code: 'ENOENT'});
  await verifyPanel();
  await verifyCepTransport();
  console.log('PASS: anonymous GitHub manifest and download, notes through API limits, version checks, archive validation and cleanup');
}

verify().catch(error => {console.error(error); process.exitCode = 1;});
