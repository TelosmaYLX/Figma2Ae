(function () {
  'use strict';
  var cep = window.__adobe_cep__;
  if (!cep || process.platform !== 'win32') return;
  var path = require('path'), fs = require('fs');
  var extension = decodeURIComponent(cep.getSystemPath('extension')).replace(/^file:\/\/\/?/, '');
  var versionLabel = document.getElementById('mk-version');
  var manifest = path.join(extension, 'package-manifest.json');
  var canInstall = fs.existsSync(manifest) && !fs.existsSync(path.join(extension, '.git'));
  var versionFile = canInstall ? manifest : path.join(extension, 'version.json');
  if (!fs.existsSync(versionFile)) return;
  var installed = JSON.parse(fs.readFileSync(versionFile, 'utf8')).version;
  versionLabel.textContent = 'v' + installed;

  var button = document.getElementById('mk-update');
  var notice = document.getElementById('mk-update-notice');
  var noticeTitle = document.getElementById('mk-update-title');
  var notes = document.getElementById('mk-update-notes');
  var updater = require(path.join(extension, 'client/updateRelease.js'));
  var pending = null;
  function report(message, failed) { window.MKReport(message, failed); }
  function showRelease(release, title) {
    noticeTitle.textContent = title;
    notes.textContent = release.notes || '暂无更新日志。';
    notice.hidden = false;
  }
  async function check(interactive) {
    button.disabled = true;
    button.textContent = '检查中…';
    try {
      var release = await updater.check(installed, {interactive: interactive});
      var update = release && release.url ? release : null;
      pending = canInstall ? update : null;
      if (release) {
        var title = (update ? '发现新版 v' : 'v') + release.version;
        showRelease(release, title);
        if (update) {
          if (interactive) notice.open = true;
          report(title + (canInstall ? '。' : '，源码版请通过 Git 更新。'));
        }
      } else notice.hidden = true;
      if (!update && interactive) report('暂无可用更新。');
    } catch (error) {
      if (interactive) report(error.userMessage || '检查更新失败，请重试。', true);
    } finally {
      button.textContent = pending ? '更新到 ' + pending.version : '检查更新';
      button.disabled = false;
    }
  }
  button.hidden = false;
  button.onclick = async function () {
    if (!pending) { await check(true); return; }
    button.disabled = true;
    button.textContent = '更新中…';
    try {
      await updater.install(extension, pending);
      button.textContent = '已更新';
      showRelease(pending, 'v' + pending.version);
      notice.open = true;
      report('已更新到 ' + pending.version + '，请重新打开 AE 和 Figma 的 F2A 面板。');
    } catch (error) {
      button.textContent = '更新到 ' + pending.version;
      button.disabled = false;
      report(error.userMessage || '安装失败，请重试。', true);
    }
  };
  check(false);
})();
