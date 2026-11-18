'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {check, install} = require('../client/updateRelease.js');

async function verify() {
  const file = 'F2A-Windows-x64.zip';
  const bytes = Buffer.from('Windows ZIP fixture');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const release = {tag_name: 'v1.10.0', assets: [{name: file, id: 42}, {name: 'latest.json', id: 43}]};
  const replies = new Map([
    ['/releases/latest', release],
    ['/releases/assets/43', {version: '1.10.0', file, sha256: digest}]
  ]);
  const api = 'https://api.github.com/repos/TelosmaYLX/Figma2Ae';
  const credentialFor = async interactive => { assert.equal(interactive, true); return 'test-token'; };
  const get = async (url, credential) => {
    assert.equal(credential, 'test-token');
    const reply = replies.get(url.slice(api.length));
    if (!reply) throw Object.assign(new Error('Not found'), {status: 404});
    return Buffer.from(JSON.stringify(reply));
  };
  const options = {interactive: true, credentialFor, get};
  assert.equal(await check('1.11.0', options), null);
  const update = await check('1.9.0', options);
  assert.equal(update.version, '1.10.0');
  assert.equal(update.url, api + '/releases/assets/42');
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
  console.log('PASS: private GitHub Release lookup, version comparison, manifest and archive validation, installer arguments and cleanup');
}

verify().catch(error => {console.error(error); process.exitCode = 1;});
