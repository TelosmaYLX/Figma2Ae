'use strict';

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {URL} = require('url');
const {execFile} = require('child_process');
const {promisify} = require('util');
const run = promisify(execFile);
const repository = 'TelosmaYLX/Figma2Ae';
const releasePath = '/' + repository + '/releases/';
const downloads = 'https://github.com' + releasePath;
const api = 'https://api.github.com/repos' + releasePath;
const archiveBase = 'F2A-Windows-x64';
const archiveName = archiveBase + '.zip';
const manifestName = 'latest.json';

function updateError(message) {
  return Object.assign(new Error(message), {userMessage: message});
}

function versionParts(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw updateError('版本号无效。');
  return version.split('.').map(Number);
}

function isNewer(version, installed) {
  const next = versionParts(version), current = versionParts(installed);
  for (let i = 0; i < next.length; i++) {
    if (next[i] !== current[i]) return next[i] > current[i];
  }
  return false;
}

function request(url, accept, limit, redirects = 4) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const githubRelease = target.host === 'github.com' && target.pathname.startsWith(releasePath);
    const releaseApi = target.host === 'api.github.com' && target.pathname.startsWith('/repos' + releasePath);
    if (target.protocol !== 'https:' || (!githubRelease && !releaseApi && !target.host.endsWith('.githubusercontent.com'))) {
      reject(updateError('GitHub 下载地址无效。')); return;
    }
    const headers = {'User-Agent': 'F2A updater', Accept: accept};
    // CEP has a browser URL constructor in the panel realm. Use the options overload.
    const connectionError = error => reject(error.userMessage ? error : updateError('无法连接 GitHub，请检查网络后重试。'));
    const req = https.get({hostname: target.hostname, port: target.port, path: target.pathname + target.search, headers}, response => {
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location && redirects > 0) {
        response.resume();
        resolve(request(new URL(response.headers.location, target).href, accept, limit, redirects - 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        const error = updateError('GitHub 请求失败（状态码 ' + status + '）。');
        error.status = status;
        reject(error); return;
      }
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > limit) { req.destroy(updateError('更新文件超出大小限制。')); return; }
        chunks.push(chunk);
      });
      response.on('error', connectionError);
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(30000, () => req.destroy(updateError('连接 GitHub 超时。')));
    req.on('error', connectionError);
  });
}

async function check(installed, {get = request} = {}) {
  let manifest;
  try {
    const body = await get(downloads + 'latest/download/' + manifestName, 'application/octet-stream', 64 * 1024);
    manifest = JSON.parse(body.toString('utf8'));
  }
  catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
  const version = String(manifest.version || '');
  if (!isNewer(version, installed)) return null;
  const releaseArchive = archiveBase + '-v' + version + '.zip';
  if (![releaseArchive, archiveName].includes(manifest.file) || !/^[a-f0-9]{64}$/.test(manifest.sha256))
    throw updateError('GitHub 上的更新清单无效。');
  let notes = typeof manifest.notes === 'string' ? manifest.notes.trim() : '';
  if (!notes) {
    try {
      const body = await get(api + 'tags/v' + version, 'application/vnd.github.text+json', 1024 * 1024);
      const release = JSON.parse(body.toString('utf8'));
      notes = (typeof release.body_text === 'string' ? release.body_text : release.body || '').trim();
    } catch {} // Older manifests use Release notes when the public API is available.
  }
  return {version, notes, sha256: manifest.sha256, url: downloads + 'download/v' + version + '/' + manifest.file};
}

async function install(extension, update, {get = request, execute = run} = {}) {
  const buffer = await get(update.url, 'application/octet-stream', 128 * 1024 * 1024);
  if (crypto.createHash('sha256').update(buffer).digest('hex') !== update.sha256) throw updateError('安装包校验失败。');
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
      const detail = String(error.stderr || '');
      if (detail.includes('Finish the AEP export')) throw updateError('请完成当前 AEP 导出后再更新。');
      if (detail.includes('administrator installer')) throw updateError('管理员安装失败，请重试。');
      throw updateError('安装失败，请重试。');
    }
  } finally {
    await fs.promises.unlink(path.join(temporary, archiveName)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    await fs.promises.rmdir(temporary);
  }
}

module.exports = {check, install};
