(function () {
  'use strict';
  var cep = window.__adobe_cep__;
  if (!cep || process.platform !== 'win32') return;
  var path = require('path'), fs = require('fs');
  var extension = decodeURIComponent(cep.getSystemPath('extension')).replace(/^file:\/\/\/?/, '');
  var versionLabel = document.getElementById('mk-version');
  var manifest = path.join(extension, 'package-manifest.json');
  var versionFile = fs.existsSync(manifest) ? manifest : path.join(extension, 'version.json');
  if (!fs.existsSync(versionFile)) return;
  var installed = JSON.parse(fs.readFileSync(versionFile, 'utf8')).version;
  versionLabel.textContent = 'v' + installed;
  if (versionFile !== manifest || fs.existsSync(path.join(extension, '.git'))) return;

  var button = document.getElementById('mk-update');
  var updater = require(path.join(extension, 'client/updateRelease.js'));
  var pending = null;
  function report(message, failed) { window.MKReport(message, failed); }
  async function check(interactive) {
    button.disabled = true;
    button.textContent = '检查中…';
    try {
      pending = await updater.check(installed, {interactive: interactive});
      if (interactive && !pending) report('已是最新版本。');
    } catch (error) {
      if (interactive) report(error.message, true);
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
      report('已更新到 ' + pending.version + '，请重新打开 AE 和 Figma 的 F2A 面板。');
    } catch (error) {
      button.textContent = '更新到 ' + pending.version;
      button.disabled = false;
      report(error.message, true);
    }
  };
  check(false);
})();
