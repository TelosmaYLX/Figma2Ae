'use strict';

// Also loaded by AE CEP's older embedded Node runtime; keep this file free of modern syntax.
var http = require('http');
var fs = require('fs');
var path = require('path');
var spawn = require('child_process').spawn;
var PORT = Number(process.env.F2A_OPENPENCIL_PORT || 7369);

function health(callback, port) {
  var targetPort = port || PORT;
  var done = false;
  function finish(error, result) { if (!done) { done = true; callback(error, result); } }
  var request = http.get('http://127.0.0.1:' + targetPort + '/health', function (response) {
    var body = '';
    response.on('data', function (part) { body += part; });
    response.on('end', function () {
      try {
        var info = JSON.parse(body);
        if (info.service !== 'f2a-openpencil' || info.version !== 1) {
          throw new Error('OpenPencil 桥接端口已被其他服务占用');
        }
        finish(null, info);
      } catch (error) { finish(error); }
    });
    response.on('error', finish);
  });
  request.setTimeout(1200, function () { request.destroy(new Error('OpenPencil 桥接连接超时')); });
  request.on('error', finish);
}

function nodePath() {
  var bundled = path.join(__dirname, '../runtime/node/node.exe');
  if (fs.existsSync(bundled)) return bundled;
  bundled = path.join(__dirname, '../../runtime/node/node.exe');
  if (fs.existsSync(bundled)) return bundled;
  if (/node(?:\.exe)?$/i.test(process.execPath)) return process.execPath;
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

function panelScriptPath() {
  return path.join(__dirname, '../scripts/openpencil-panel.cjs');
}

function ensurePanelServer(callback, options) {
  options = options || {};
  var targetPort = Number(options.port || PORT);
  health(function (error, info) {
    if (!error) { callback(null, info); return; }
    if (error.code !== 'ECONNREFUSED') { callback(error); return; }
    var finished = false;
    var attempts = 0;
    function finish(failure, result) { if (!finished) { finished = true; callback(failure, result); } }
    var args = [panelScriptPath(), '--no-open', '--mcp', '--port', String(targetPort)];
    if (options.workspace) args.push('--workspace');
    var child = spawn(options.nodePath || nodePath(), args, {
      cwd: path.join(__dirname, '..'),
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.on('error', function (failure) {
      finish(new Error('OpenPencil 桥接启动失败：' + failure.message));
    });
    child.unref();
    function check() {
      if (finished) return;
      health(function (failure, result) {
        if (!failure) { finish(null, result); return; }
        if (++attempts === 35 || (failure.code && failure.code !== 'ECONNREFUSED')) {
          finish(failure);
          return;
        }
        setTimeout(check, 150);
      }, targetPort);
    }
    setTimeout(check, 150);
  }, targetPort);
}

function postPopout(port, callback) {
  var body = JSON.stringify({ topmost: true });
  var done = false;
  function finish(error, result) { if (!done) { done = true; if (callback) callback(error || null, result || null); } }
  var req = http.request({
    hostname: '127.0.0.1',
    port: port,
    path: '/window/popout',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, function (response) {
    var chunks = '';
    response.on('data', function (part) { chunks += part; });
    response.on('end', function () {
      if (response.statusCode >= 400) {
        finish(new Error('无法弹出 OpenPencil 小窗（HTTP ' + response.statusCode + '）'));
        return;
      }
      try { finish(null, JSON.parse(chunks)); }
      catch (e) { finish(null, { ok: true }); }
    });
    response.on('error', finish);
  });
  req.setTimeout(3000, function () { req.destroy(new Error('弹出 OpenPencil 小窗超时')); });
  req.on('error', finish);
  req.write(body);
  req.end();
}

function openFloatingWindow(callback, options) {
  options = options || {};
  var targetPort = Number(options.port || PORT);
  // Always delegate window launch to the external bridge process via HTTP instead of
  // spawning a browser/node child from AE CEP's mixed-context renderer click handler.
  ensurePanelServer(function (error) {
    if (error) {
      if (callback) callback(error);
      return;
    }
    postPopout(targetPort, callback);
  }, options);
}

module.exports = {
  PORT: PORT,
  health: health,
  nodePath: nodePath,
  panelScriptPath: panelScriptPath,
  ensurePanelServer: ensurePanelServer,
  openFloatingWindow: openFloatingWindow
};
