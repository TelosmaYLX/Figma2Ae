/* ===== f2a — OpenPencil workspace tab inside AE CEP panel =====
 * Auto-starts the local OpenPencil bridge via openpencil/launcher.cjs (same pattern as
 * mcpBridge.js), embeds http://127.0.0.1:7369/?embed=ae directly inside the AE panel,
 * and exposes a one-click pop-out button for the standalone pinned mini window.
 */
(function () {
  'use strict';

  var PORT = 7369;
  var TAB_STORAGE_KEY = 'f2a.activeWorkspace';
  var CEP = (typeof window.__adobe_cep__ !== 'undefined');

  var tabMotion = document.getElementById('f2o-tab-motion');
  var tabOpenPencil = document.getElementById('f2o-tab-openpencil');
  var dotEl = document.getElementById('f2o-dot');
  var popoutBtn = document.getElementById('f2o-popout');
  var motionShell = document.querySelector('.f2m-shell');
  var opShell = document.getElementById('f2o-shell');
  var opFrame = document.getElementById('f2o-frame');
  var opNotice = document.getElementById('f2o-notice');
  var opNoticeText = document.getElementById('f2o-notice-text');
  var opRetryBtn = document.getElementById('f2o-retry');

  if (!tabMotion || !tabOpenPencil || !opShell) return;

  var activeTab = 'motion';
  var serverReady = false;
  var frameLoaded = false;
  var popoutBusy = false;
  var starting = false;
  var lastConnected = null;
  var pollTimer = null;

  function log(text, tone) {
    if (window.MKLog) window.MKLog(text, tone);
  }

  function extensionRoot() {
    if (!CEP) return '';
    return decodeURIComponent(window.__adobe_cep__.getSystemPath('extension')).replace(/^file:\/\/\/?/, '');
  }

  function loadLauncher() {
    if (!CEP) return null;
    try {
      return require(extensionRoot() + '/openpencil/launcher.cjs');
    } catch (error) {
      log('OpenPencil 启动器加载失败：' + error.message, 'err');
      return null;
    }
  }

  function embedUrl() {
    return 'http://127.0.0.1:' + PORT + '/?embed=ae';
  }

  function setDot(state) {
    if (!dotEl) return;
    dotEl.className = 'f2o-dot' + (state ? ' ' + state : '');
  }

  function showNotice(text, showRetry, retryLabel) {
    if (!opNotice || !opNoticeText) return;
    if (!text) {
      opNotice.hidden = true;
      return;
    }
    opNotice.hidden = false;
    opNoticeText.textContent = text;
    if (opRetryBtn) {
      opRetryBtn.hidden = !showRetry;
      opRetryBtn.textContent = retryLabel || '重试';
    }
  }

  function mountFrameIfNeeded() {
    if (!opFrame || !serverReady || activeTab !== 'openpencil') return;
    showNotice('', false);
    if (!frameLoaded) {
      frameLoaded = true;
      opFrame.src = embedUrl();
    }
  }

  function setTab(next, persist) {
    activeTab = (next === 'openpencil') ? 'openpencil' : 'motion';
    var isOp = activeTab === 'openpencil';
    tabMotion.classList.toggle('active', !isOp);
    tabOpenPencil.classList.toggle('active', isOp);
    tabMotion.setAttribute('aria-selected', isOp ? 'false' : 'true');
    tabOpenPencil.setAttribute('aria-selected', isOp ? 'true' : 'false');
    if (motionShell) motionShell.hidden = isOp;
    opShell.hidden = !isOp;
    if (persist) {
      try { if (typeof localStorage !== 'undefined') localStorage.setItem(TAB_STORAGE_KEY, activeTab); } catch (e) {}
    }
    if (isOp) {
      if (serverReady) mountFrameIfNeeded();
      else ensureBridge(true);
    }
  }

  function applyHealth(info) {
    if (!info) return;
    serverReady = true;
    var connected = !!info.connected;
    if (connected) {
      setDot(info.scope === 'selection' ? 'warn' : 'on');
    } else {
      setDot('idle');
    }
    if (lastConnected !== connected) {
      lastConnected = connected;
      if (connected) {
        log('OpenPencil 已连接' + (info.openpencilVersion ? '（v' + info.openpencilVersion + '）' : ''), 'ok');
      }
    }
    mountFrameIfNeeded();
  }

  function probeHealth(cb) {
    var launcher = loadLauncher();
    if (launcher) {
      launcher.health(cb, PORT);
      return;
    }
    if (typeof fetch !== 'function') { cb(new Error('预览模式')); return; }
    fetch('http://127.0.0.1:' + PORT + '/health').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (info) {
      if (info && info.service === 'f2a-openpencil') cb(null, info);
      else cb(new Error('服务不匹配'));
    }).catch(cb);
  }

  function ensureBridge(interactive) {
    if (starting) return;
    var launcher = loadLauncher();
    if (!launcher) {
      // Browser preview fallback: check if bridge is already running manually on 7369.
      probeHealth(function (err, info) {
        if (!err && info) applyHealth(info);
        else {
          setDot('off');
          if (interactive) showNotice('未检测到 OpenPencil 桥接服务（端口 ' + PORT + '）。请先运行 openpencil-panel.cjs，或在 AE 中打开本面板自动启动。', true);
        }
      });
      return;
    }
    starting = true;
    if (interactive && !serverReady) showNotice('正在启动 OpenPencil 桥接服务…', false);
    launcher.ensurePanelServer(function (error, info) {
      starting = false;
      if (error) {
        serverReady = false;
        setDot('off');
        log(error.message, 'err');
        showNotice(error.message, true);
        return;
      }
      applyHealth(info);
      if (interactive) log('OpenPencil 面板服务已就绪 · 端口 ' + PORT, 'ok');
    }, { port: PORT });
  }

  function pollStatus() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(function () {
      pollTimer = null;
      probeHealth(function (err, info) {
        if (!err && info) {
          applyHealth(info);
        } else if (serverReady) {
          serverReady = false;
          frameLoaded = false;
          setDot('off');
          if (activeTab === 'openpencil') {
            showNotice('OpenPencil 桥接服务已停止，点击重试重新启动。', true);
          }
        }
        pollStatus();
      });
    }, 3000);
  }

  tabMotion.onclick = function () { setTab('motion', true); };
  tabOpenPencil.onclick = function () { setTab('openpencil', true); };
  tabOpenPencil.onkeydown = function (ev) {
    if (ev && (ev.key === 'Enter' || ev.key === ' ')) {
      if (ev.preventDefault) ev.preventDefault();
      setTab('openpencil', true);
    }
  };

  if (opRetryBtn) {
    opRetryBtn.onclick = function () {
      frameLoaded = false;
      ensureBridge(true);
    };
  }

  if (popoutBtn) {
    popoutBtn.onclick = function (ev) {
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      if (popoutBusy) return;
      popoutBusy = true;
      popoutBtn.disabled = true;
      function done(error) {
        popoutBusy = false;
        popoutBtn.disabled = false;
        if (error) {
          log(error.message, 'err');
          return;
        }
        log('已弹出 OpenPencil 独立小窗', 'ok');
      }
      var launcher = loadLauncher();
      if (launcher) {
        launcher.openFloatingWindow(done, { port: PORT });
        return;
      }
      if (typeof fetch === 'function') {
        fetch('http://127.0.0.1:' + PORT + '/window/popout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topmost: true })
        }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          done(null);
        }).catch(function (err) {
          done(new Error('无法弹出 OpenPencil 小窗：' + (err && err.message ? err.message : err)));
        });
        return;
      }
      done(new Error('无法弹出 OpenPencil 小窗：请先启动本地服务。'));
    };
  }

  var saved = 'motion';
  try {
    if (typeof localStorage !== 'undefined') saved = localStorage.getItem(TAB_STORAGE_KEY) || 'motion';
  } catch (e) {}
  setTab(saved, false);
  ensureBridge(saved === 'openpencil');
  pollStatus();
})();
