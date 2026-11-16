'use strict';

// Also loaded by CEP's older Node runtime; keep this file free of modern syntax.
var http = require('http');
var fs = require('fs');
var path = require('path');
var spawn = require('child_process').spawn;
var PORT = Number(process.env.F2A_MCP_PORT || 7869);

function health(callback) {
  var done = false;
  function finish(error, result) { if (!done) { done = true; callback(error, result); } }
  var request = http.get('http://127.0.0.1:' + PORT + '/health', function (response) {
    var body = '';
    response.on('data', function (part) { body += part; });
    response.on('end', function () {
      try {
        var info = JSON.parse(body);
        if (info.service !== 'f2a-mcp' || info.version !== 1) throw new Error('MCP 端口已被其他服务占用');
        finish(null, info);
      } catch (error) { finish(error); }
    });
    response.on('error', finish);
  });
  request.setTimeout(1000, function () { request.destroy(new Error('MCP 连接超时')); });
  request.on('error', finish);
}

function nodePath() {
  var bundled = path.join(__dirname, '../runtime/node/node.exe');
  if (fs.existsSync(bundled)) return bundled;
  // A distributed CEP extension lives next to its component's runtime directory.
  bundled = path.join(__dirname, '../../runtime/node/node.exe');
  if (fs.existsSync(bundled)) return bundled;
  if (/node(?:\.exe)?$/i.test(process.execPath)) return process.execPath;
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

function ensureRelay(callback, options) {
  options = options || {};
  health(function (error, info) {
    if (!error) { callback(null, info); return; }
    if (error.code !== 'ECONNREFUSED') { callback(error); return; }
    var finished = false, attempts = 0;
    function finish(failure, result) { if (!finished) { finished = true; callback(failure, result); } }
    var child = spawn(options.nodePath || nodePath(), [path.join(__dirname, 'relay.cjs')], {
      cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true
    });
    child.on('error', function (failure) { finish(new Error('MCP 启动失败：' + failure.message)); });
    child.unref();
    function check() {
      if (finished) return;
      health(function (failure, result) {
        if (!failure) { finish(null, result); return; }
        if (++attempts === 30 || failure.code !== 'ECONNREFUSED') { finish(failure); return; }
        setTimeout(check, 100);
      });
    }
    check();
  });
}

module.exports = {ensureRelay: ensureRelay, health: health, nodePath: nodePath, PORT: PORT};
