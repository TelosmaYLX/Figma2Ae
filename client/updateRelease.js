'use strict';

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {execFile} = require('child_process');
const {promisify} = require('util');
const run = promisify(execFile);
const repository = 'TelosmaYLX/Figma2Ae';
const api = 'https://api.github.com/repos/' + repository;
const archiveBase = 'F2A-Windows-x64';
const archiveName = archiveBase + '.zip';
const manifestName = 'latest.json';

function versionParts(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('无效的版本号');
  return version.split('.').map(Number);
}

function isNewer(version, installed) {
  const next = versionParts(version), current = versionParts(installed);
  for (let i = 0; i < next.length; i++) {
    if (next[i] !== current[i]) return next[i] > current[i];
  }
  return false;
}

function githubCredential(interactive) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-c', 'credential.interactive=' + (interactive ? 'true' : 'false'), 'credential', 'fill'], {
      windowsHide: true, timeout: 120000,
      env: {...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: interactive ? 'true' : 'false'}
    }, (error, stdout) => {
      if (error) {
        if (error.code === 'ENOENT' && interactive) { reject(new Error('请安装 Git for Windows 后检查更新。')); return; }
        resolve(null); return;
      }
      const entry = /^password=([^\r\n]+)/m.exec(stdout);
      resolve(entry ? entry[1] : null);
    });
    child.stdin.on('error', () => {});
    child.stdin.end('protocol=https\nhost=github.com\npath=' + repository + '.git\n\n');
  });
}

function request(url, credential, accept, limit, redirects = 4) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const apiHost = target.host === 'api.github.com';
    if (target.protocol !== 'https:' || (!apiHost && !target.host.endsWith('.githubusercontent.com'))) {
      reject(new Error('GitHub 下载地址无效。')); return;
    }
    const headers = {'User-Agent': 'F2A updater', Accept: accept};
    if (apiHost && credential) headers.Authorization = 'Bearer ' + credential;
    const req = https.get(target, {headers}, response => {
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location && redirects > 0) {
        response.resume();
        resolve(request(new URL(response.headers.location, target).href, null, accept, limit, redirects - 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        const error = new Error('GitHub 请求失败（' + status + '）。');
        error.status = status;
        reject(error); return;
      }
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > limit) { req.destroy(new Error('更新文件超出大小限制。')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(30000, () => req.destroy(new Error('连接 GitHub 超时。')));
    req.on('error', reject);
  });
}

function assetUrl(release, name) {
  const asset = (release.assets || []).find(item => item.name === name);
  if (!asset || !Number.isSafeInteger(asset.id) || asset.id < 1) throw new Error('GitHub Release 缺少 ' + name + '。');
  return api + '/releases/assets/' + asset.id;
}

async function check(installed, {interactive = false, credentialFor = githubCredential, get = request} = {}) {
  const credential = await credentialFor(interactive);
  const fetchRelease = suffix => get(api + suffix, credential, 'application/vnd.github+json', 1024 * 1024);
  let release;
  try { release = JSON.parse((await fetchRelease('/releases/latest')).toString('utf8')); }
  catch (error) {
    if (error.status === 404) {
      try { await fetchRelease(''); }
      catch (repoError) {
        if (repoError.status !== 404) throw repoError;
        throw new Error('请用 Git Credential Manager 登录有仓库读取权限的 GitHub 账号。');
      }
      return null;
    }
    if (!credential && error.status === 403) throw new Error('请用 Git Credential Manager 登录 GitHub 后重试。');
    if (credential && error.status === 401) throw new Error('GitHub 登录已失效，请重新登录。');
    throw error;
  }
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!isNewer(version, installed)) return null;
  const buffer = await get(assetUrl(release, manifestName), credential, 'application/octet-stream', 16 * 1024);
  const manifest = JSON.parse(buffer.toString('utf8'));
  const releaseArchive = archiveBase + '-v' + version + '.zip';
  if (manifest.version !== version || ![releaseArchive, archiveName].includes(manifest.file) || !/^[a-f0-9]{64}$/.test(manifest.sha256))
    throw new Error('GitHub Release 的更新清单无效。');
  return {version, sha256: manifest.sha256, url: assetUrl(release, manifest.file), credential};
}

async function install(extension, update, {get = request, execute = run} = {}) {
  const buffer = await get(update.url, update.credential, 'application/octet-stream', 128 * 1024 * 1024);
  if (crypto.createHash('sha256').update(buffer).digest('hex') !== update.sha256) throw new Error('安装包校验失败。');
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'f2a-update-'));
  try {
    const archive = path.join(temporary, archiveName);
    await fs.promises.writeFile(archive, buffer);
    const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    try {
      await execute(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(extension, 'scripts/update-f2a.ps1'), '-Archive', archive,
        '-Sha256', update.sha256, '-Version', update.version, '-InstallDirectory', extension], {windowsHide: true});
    } catch (error) {
      const detail = String(error.stderr || error.stdout || '').trim().split(/\r?\n/)[0];
      throw new Error(detail || '安装失败，请重试。');
    }
  } finally {
    await fs.promises.unlink(path.join(temporary, archiveName)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    await fs.promises.rmdir(temporary);
  }
}

module.exports = {check, install};
