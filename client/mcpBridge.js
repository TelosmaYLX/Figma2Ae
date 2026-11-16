/* Starts the shared MCP relay when the AE panel opens. Its Node process also serves
 * Figma-only workflows when started directly by an agent's MCP configuration. */
(function () {
  'use strict';
  var label = document.getElementById('mk-mcp-label');
  var dot = document.getElementById('mk-mcp-dot');
  var lastStatus = '';
  function status(ready, text) {
    if (label) label.textContent = text;
    if (dot) dot.className = 'mk-fig-dot ' + (ready ? 'on' : 'off');
    // Log transitions only: retries would otherwise repeat the same line on every tick.
    if (text !== lastStatus) {
      lastStatus = text;
      if (window.MKLog) window.MKLog(text, ready ? 'ok' : (text === 'MCP 预览' ? '' : 'err'));
    }
  }
  if (!window.__adobe_cep__) { status(false, 'MCP 预览'); return; }
  var extension = decodeURIComponent(window.__adobe_cep__.getSystemPath('extension')).replace(/^file:\/\/\/?/, '');
  try {
    require(extension + '/mcp/launcher.cjs').ensureRelay(function (error) {
      status(!error, error ? error.message : 'MCP 已就绪');
    });
  } catch (error) { status(false, 'MCP 启动失败：' + error.message); }
})();
