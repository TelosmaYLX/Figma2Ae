/* Start the registered Windows component from CEP, where native process APIs are available. */
var childProcess = require('child_process');
var path = require('path');

function start(callback) {
  if (process.platform !== 'win32') { callback(new Error('AEP 自动启动仅支持 Windows x64')); return; }
  var powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  // Windows resolves the per-user installation, including custom paths. No request data is executed.
  var script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false",
    "if (-not (Test-Path -LiteralPath 'Registry::HKEY_CURRENT_USER\\Software\\Classes\\f2a-aep\\shell\\open\\command')) { [Console]::Error.WriteLine('F2A_COMPONENT_MISSING'); exit 2 }",
    "try { Start-Process -FilePath 'f2a-aep://start' -WindowStyle Hidden } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
  ].join('\r\n');
  childProcess.execFile(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script], {windowsHide:true, timeout:10000}, function (error, stdout, stderr) {
    if (!error) { callback(null); return; }
    if (String(stderr).indexOf('F2A_COMPONENT_MISSING') !== -1) callback(new Error('未找到 AEP 导出组件，请先安装 Windows x64 组件。'));
    else callback(new Error('AEP 组件启动失败：' + (String(stderr || '').trim().split(/\r?\n/)[0] || error.code || '未知错误')));
  });
}

module.exports = {start:start};
