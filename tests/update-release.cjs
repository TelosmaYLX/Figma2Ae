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
        return {check: async (_, options) => {
          checks.push(options.interactive);
          if (checkError) throw checkError;
          return release;
        }, install: async (_, pending) => { assert.equal(pending, release); installations++; }};
      }
    });
    assert.equal(button.hidden, false, 'The update entry is visible in both package and source panels');
    assert.equal(version.textContent, 'v1.1.0');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(checks, [false], 'Startup checks once in both installation modes');
    assert.equal(notice.hidden, !update);
    assert.equal(notice.open, false);
    if (update) {
      assert.equal(title.textContent, '有可用更新 · v1.2.0');
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
      assert.deepEqual(checks, [false, true]);
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
        assert.equal(options.hostname, 'api.github.com');
        assert.match(options.path, /\/releases\/latest$/);
        assert.equal(options.headers.Accept, 'application/vnd.github.text+json');
        const request = new EventEmitter();
        request.setTimeout = () => {};
        process.nextTick(() => {
          const response = new EventEmitter();
          response.statusCode = 200;
          listener(response);
          response.emit('data', Buffer.from('{"tag_name":"v1.1.0"}'));
          response.emit('end');
        });
        return request;
      }};
    }
  });
  assert.equal(await module.exports.check('1.1.0', {credentialFor: async () => null}), null);
}

async function verify() {
  const file = 'F2A-Windows-x64-v1.10.0.zip';
  const bytes = Buffer.from('Windows ZIP fixture');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const release = {tag_name: 'v1.10.0', body: '## Changes', body_text: '  Changes\nFix paths\n',
    assets: [{name: file, id: 42}, {name: 'latest.json', id: 43}]};
  const replies = new Map([
    ['/releases/latest', release],
    ['/releases/assets/43', {version: '1.10.0', file, sha256: digest}]
  ]);
  const api = 'https://api.github.com/repos/TelosmaYLX/Figma2Ae';
  const credentialFor = async interactive => { assert.equal(interactive, true); return 'test-token'; };
  const requested = [];
  const get = async (url, credential) => {
    assert.equal(credential, 'test-token');
    requested.push(url.slice(api.length));
    const reply = replies.get(url.slice(api.length));
    if (!reply) throw Object.assign(new Error('Not found'), {status: 404});
    return Buffer.from(JSON.stringify(reply));
  };
  const options = {interactive: true, credentialFor, get};
  assert.equal(await check('1.11.0', options), null);
  requested.length = 0;
  assert.equal(await check('1.10.0', options), null);
  assert.deepEqual(requested, ['/releases/latest'], 'An up-to-date install needs no update assets or release notice');
  const update = await check('1.9.0', options);
  assert.equal(update.version, '1.10.0');
  assert.equal(update.notes, 'Changes\nFix paths');
  assert.equal(update.url, api + '/releases/assets/42');
  const legacy = 'F2A-Windows-x64.zip';
  release.assets[0].name = replies.get('/releases/assets/43').file = legacy;
  delete release.body_text;
  const legacyUpdate = await check('1.9.0', options);
  assert.equal(legacyUpdate.url, update.url);
  assert.equal(legacyUpdate.notes, release.body);
  replies.get('/releases/assets/43').file = 'F2A-Windows-x64-v1.9.0.zip';
  await assert.rejects(check('1.9.0', options), /清单无效/);
  replies.get('/releases/assets/43').file = legacy;
  replies.get('/releases/assets/43').version = '1.12.0';
  await assert.rejects(check('1.9.0', options), /清单无效/);
  replies.delete('/releases/latest');
  replies.set('', {private: true});
  assert.equal(await check('1.9.0', options), null);
  replies.delete('');
  await assert.rejects(check('1.9.0', options), /仓库读取权限/);

  const extension = path.resolve('F2A test install');
  let archive;
  const apply = {get: async () => bytes, execute: async (program, args) => {
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
  console.log('PASS: private GitHub Release lookup, notes only for an available update, hiding after install, archive validation and cleanup');
}

verify().catch(error => {console.error(error); process.exitCode = 1;});
