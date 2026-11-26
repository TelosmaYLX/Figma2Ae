'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createClient } = require('./client.cjs');
const { createRunner } = require('./runner.cjs');
const {
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  windowTitleForPort,
  isTopmostSupported,
  setWindowTopmost,
  focusWindow,
  openAppWindow,
  ensureWindowIcon,
  stopWindowIcon,
} = require('./window.cjs');
const { decodeFrames, encodeText, acceptKey } = require('../client/mkBridgeServer.js');

const DEFAULT_PORT = 7369;
const AEP_PART_SIZE = 1024 * 1024;
const UI_HTML_PATH = path.resolve(__dirname, '../figma-plugin/ui.html');
const HOST_HTML_PATH = path.resolve(__dirname, './host.html');
const ICON_SVG_PATH = path.resolve(__dirname, './icon.svg');
const ICON_PNG_PATH = path.resolve(__dirname, './icon-256.png');
const ICON_ICO_PATH = path.resolve(__dirname, './favicon.ico');

function encodeClose() {
  return Buffer.from([0x88, 0x00]);
}

function encodePong(payload) {
  const buf = payload || Buffer.alloc(0);
  if (buf.length < 126) return Buffer.concat([Buffer.from([0x8a, buf.length]), buf]);
  const head = Buffer.alloc(4);
  head[0] = 0x8a;
  head[1] = 126;
  head.writeUInt16BE(buf.length, 2);
  return Buffer.concat([head, buf]);
}

function encodeClientText(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
    header.writeUInt32BE(len % 0x100000000, 6);
  }
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

function defaultSettingsPath() {
  if (process.env.F2A_OPENPENCIL_SETTINGS_PATH) {
    return process.env.F2A_OPENPENCIL_SETTINGS_PATH;
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'F2A', 'openpencil-settings.json');
  }
  return path.join(os.homedir(), '.config', 'f2a', 'openpencil-settings.json');
}

function loadSettings(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function saveSettings(filePath, settings) {
  if (!settings || typeof settings !== 'object') return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  } catch {}
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderHostHtml(options = {}) {
  const host = fs.readFileSync(HOST_HTML_PATH, 'utf8');
  const uiRaw = fs.readFileSync(UI_HTML_PATH, 'utf8');
  const ui = uiRaw + '\n<style>.wrap { padding-top: 10px; } .wrap > .status { display: none; } .send-settings { margin-top: 0 !important; }</style>';
  const title = options.title || windowTitleForPort(options.port || DEFAULT_PORT, DEFAULT_PORT);
  const safeJson = JSON.stringify(ui).replace(/</g, '\\u003c');
  return host
    .replace('__F2A_WINDOW_TITLE__', escapeHtml(title))
    .replace('__F2A_UI_HTML__', safeJson);
}

function probeLocalHttp(port, reqPath, timeoutMs = 1000) {
  return new Promise(resolve => {
    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method: 'GET' }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(null); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve(null); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function connectRawWebSocket(url, handlers) {
  const parsed = new URL(url);
  const port = Number(parsed.port) || 80;
  const host = parsed.hostname || '127.0.0.1';
  const reqPath = parsed.pathname + parsed.search;
  const key = crypto.randomBytes(16).toString('base64');
  const socket = net.createConnection({ host, port });
  let handshakeDone = false;
  let headBuf = Buffer.alloc(0);
  const frameState = { partial: null, frags: [] };
  let closed = false;

  const api = {
    readyState: 0,
    send(text) {
      if (api.readyState !== 1 || socket.destroyed) return;
      socket.write(encodeClientText(text));
    },
    close() {
      if (closed) return;
      closed = true;
      api.readyState = 3;
      try { socket.write(encodeClose()); } catch {}
      socket.end();
    },
  };

  socket.on('connect', () => {
    socket.write(
      'GET ' + reqPath + ' HTTP/1.1\r\n' +
      'Host: ' + host + ':' + port + '\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + key + '\r\n' +
      'Sec-WebSocket-Version: 13\r\n\r\n'
    );
  });

  function processFrames(buf) {
    const msgs = decodeFrames(buf, frameState);
    for (const m of msgs) {
      if (m.opcode === 0x8) { api.close(); return; }
      if (m.opcode === 0x9) { socket.write(encodePong(m.payload)); continue; }
      if (m.opcode === 0xa) continue;
      if (m.opcode === 0x1 || m.opcode === 0x2) frameState.frags = [m.payload];
      else if (m.opcode === 0x0) frameState.frags.push(m.payload);
      else continue;
      if (m.fin) {
        const text = Buffer.concat(frameState.frags).toString('utf8');
        frameState.frags = [];
        if (handlers.onMessage) handlers.onMessage(text);
      }
    }
  }

  socket.on('data', chunk => {
    if (!handshakeDone) {
      headBuf = Buffer.concat([headBuf, chunk]);
      const sep = headBuf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const head = headBuf.subarray(0, sep).toString('utf8');
      const rest = headBuf.subarray(sep + 4);
      headBuf = Buffer.alloc(0);
      if (!/^HTTP\/1\.1 101\b/i.test(head)) {
        socket.destroy();
        return;
      }
      handshakeDone = true;
      api.readyState = 1;
      if (handlers.onOpen) handlers.onOpen();
      if (rest.length) processFrames(rest);
      return;
    }
    processFrames(chunk);
  });

  socket.on('error', () => {});
  socket.on('close', () => {
    const wasOpen = api.readyState === 1;
    api.readyState = 3;
    if (!closed) {
      closed = true;
      if (handlers.onClose) handlers.onClose(wasOpen);
    }
  });

  return api;
}

function startBridge(options = {}) {
  const port = options.port == null ? DEFAULT_PORT : Number(options.port);
  const workspacePlugin = !!options.workspace;
  const settingsPath = options.settingsPath || defaultSettingsPath();
  const pollIntervalMs = options.pollIntervalMs || 1200;
  const client = options.client || createClient(options.clientOptions || {});
  const runner = options.runner || createRunner(client, { workspacePlugin });
  const mcpPort = Number(options.mcpPort || process.env.F2A_MCP_PORT || 7367);
  const enableHeadlessMcp = !!options.mcp;
  const autoStartAep = options.autoStartAep !== false;
  const autoExit = !!options.autoExit;
  const autoExitGraceMs = options.autoExitGraceMs == null ? 4000 : Number(options.autoExitGraceMs);
  const onAutoExit = typeof options.onAutoExit === 'function' ? options.onAutoExit : null;
  const setTopmostImpl = options.setWindowTopmost || setWindowTopmost;
  const focusWindowImpl = options.focusWindow || focusWindow;
  const openAppWindowImpl = options.openAppWindow || openAppWindow;
  const ensureWindowIconImpl = options.ensureWindowIcon || (options.setWindowTopmost ? () => ({ ok: true, skipped: true }) : ensureWindowIcon);
  const stopWindowIconImpl = options.stopWindowIcon || (options.setWindowTopmost ? () => {} : stopWindowIcon);
  const topmostSupported = options.topmostSupported != null ? !!options.topmostSupported : isTopmostSupported();

  const panelSockets = new Set();
  let windowTitle = options.windowTitle || windowTitleForPort(port || DEFAULT_PORT, DEFAULT_PORT);
  let topmostEnabled = topmostSupported && !!options.topmost;
  let initialTopmostApplied = false;
  let hadPanelConnection = false;
  let autoExitTimer = null;
  let pinnedDocumentId = options.documentId || null;
  let selectedDocumentId = pinnedDocumentId;
  let busy = false;
  let closed = false;
  let pollTimer = null;
  let embeddedAepServer = null;
  let headlessMcpWs = null;
  let headlessMcpRetry = null;
  let headlessMcpAepParts = true;
  let queue = Promise.resolve();

  let state = {
    connected: false,
    version: '',
    scope: 'document',
    selectionOnly: false,
    error: null,
    documents: [],
    selectedDocumentId: null,
    documentName: '',
    pageId: null,
    pageName: '',
    selectionCount: 0,
    frameSelected: false,
    selection: [],
  };

  function enqueue(fn) {
    const job = queue.then(fn);
    queue = job.catch(() => {});
    return job;
  }

  function broadcast(payload) {
    const encoded = encodeText(JSON.stringify(payload));
    for (const sock of panelSockets) {
      if (!sock.destroyed) {
        try { sock.write(encoded); } catch {}
      }
    }
  }

  function sendPluginMessage(pluginMessage, targetSocket) {
    const payload = { type: 'plugin-message', pluginMessage };
    if (targetSocket) {
      if (!targetSocket.destroyed) {
        try { targetSocket.write(encodeText(JSON.stringify(payload))); } catch {}
      }
      return;
    }
    broadcast(payload);
  }

  function selectionMessageFromState() {
    return {
      type: 'selection',
      count: state.connected && !state.selectionOnly ? state.selectionCount : 0,
      workspacePlugin,
      frameSelected: state.connected && !state.selectionOnly ? state.frameSelected : false,
    };
  }

  function mcpInfoMessageFromState() {
    return {
      type: 'mcp-info',
      name: state.documentName ? 'OpenPencil: ' + state.documentName : 'OpenPencil',
      fileKey: state.selectedDocumentId ? 'openpencil:' + state.selectedDocumentId : null,
      pageId: state.pageId || null,
      pageName: state.pageName || null,
    };
  }

  function currentTarget() {
    const target = {};
    if (state.selectedDocumentId) target.documentId = state.selectedDocumentId;
    if (state.pageId) target.pageId = state.pageId;
    return target;
  }

  async function refreshState(forcePush = false) {
    if (busy || closed) return state;
    const prevSig = JSON.stringify({
      c: state.connected, s: state.selectionOnly, d: state.selectedDocumentId,
      p: state.pageId, n: state.selectionCount, f: state.frameSelected,
      docs: state.documents.map(d => d.id + ':' + d.current_page_id),
    });
    const prevDocPage = state.selectedDocumentId + ':' + state.pageId;

    const health = await client.health();
    if (!health.connected) {
      state = {
        ...state,
        connected: false,
        version: '',
        scope: 'document',
        selectionOnly: false,
        error: health.error,
        documents: [],
        selectionCount: 0,
        frameSelected: false,
        selection: [],
      };
    } else {
      let documents = [];
      try {
        documents = await client.listDocuments();
      } catch {
        documents = [];
      }
      // Always follow the active foreground document in OpenPencil unless explicitly pinned via CLI --document.
      const doc = pinnedDocumentId
        ? (documents.find(d => d.id === pinnedDocumentId) || null)
        : (documents.find(d => d.active) || null);
      selectedDocumentId = doc ? doc.id : null;
      let selItems = [];
      let pageId = doc ? doc.current_page_id : null;
      let pageName = doc ? doc.current_page_name : '';
      if (doc) {
        try {
          const selRes = await client.getSelection({ documentId: doc.id });
          selItems = Array.isArray(selRes.result) ? selRes.result : [];
          if (selRes.target) {
            pageId = selRes.target.pageId || pageId;
            pageName = selRes.target.pageName || pageName;
          }
        } catch {}
      }
      state = {
        connected: true,
        version: health.version || '',
        scope: health.scope || 'document',
        selectionOnly: !!health.selectionOnly,
        error: health.error || null,
        documents,
        selectedDocumentId,
        documentName: doc ? doc.name : '',
        pageId,
        pageName,
        selectionCount: selItems.length,
        frameSelected: selItems.some(item => item.type === 'FRAME'),
        selection: selItems,
      };
    }

    const nextSig = JSON.stringify({
      c: state.connected, s: state.selectionOnly, d: state.selectedDocumentId,
      p: state.pageId, n: state.selectionCount, f: state.frameSelected,
      docs: state.documents.map(d => d.id + ':' + d.current_page_id),
    });

    if (forcePush || nextSig !== prevSig) {
      broadcast({ type: 'openpencil-status', state });
      sendPluginMessage(selectionMessageFromState());
      const nextDocPage = state.selectedDocumentId + ':' + state.pageId;
      if (nextDocPage !== prevDocPage) {
        sendPluginMessage(mcpInfoMessageFromState());
        if (headlessMcpWs && headlessMcpWs.readyState === 1) {
          const info = mcpInfoMessageFromState();
          headlessMcpWs.send(JSON.stringify({
            type: 'hello', name: info.name, fileKey: info.fileKey, pageId: info.pageId, pageName: info.pageName,
          }));
        }
      }
    }
    return state;
  }

  function schedulePoll() {
    if (closed) return;
    if (pollTimer) clearTimeout(pollTimer);
    const delay = state.connected ? pollIntervalMs : Math.max(pollIntervalMs, 2500);
    pollTimer = setTimeout(() => {
      pollTimer = null;
      if (panelSockets.size > 0 || enableHeadlessMcp) {
        refreshState(false).catch(() => {}).finally(schedulePoll);
      } else {
        schedulePoll();
      }
    }, delay);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  async function ensureLocalAepServer() {
    if (!autoStartAep) return null;
    const targetPort = workspacePlugin ? 17366 : 7366;
    const existing = await probeLocalHttp(targetPort, '/health');
    if (existing && existing.service === 'f2a-aep') return targetPort;
    if (!workspacePlugin) {
      const alt = await probeLocalHttp(7366, '/health');
      if (alt && alt.service === 'f2a-aep') return 7366;
    }
    if (embeddedAepServer) return targetPort;
    try {
      const { start: startAep } = require('../scripts/aep-server.cjs');
      embeddedAepServer = startAep({ port: targetPort, quiet: !!options.quiet });
      embeddedAepServer.on('error', () => { embeddedAepServer = null; });
      return targetPort;
    } catch {
      return null;
    }
  }

  async function handlePluginMessage(msg, socket) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'load-settings') {
      sendPluginMessage({ type: 'settings-loaded', settings: loadSettings(settingsPath) }, socket);
      return;
    }
    if (msg.type === 'save-settings') {
      saveSettings(settingsPath, msg.settings);
      return;
    }
    if (msg.type === 'mcp-info') {
      await refreshState(false);
      sendPluginMessage(mcpInfoMessageFromState(), socket);
      return;
    }
    if (msg.type === 'locate-layer') {
      await enqueue(async () => {
        const res = await runner.locateLayer(msg.nodeId, currentTarget());
        sendPluginMessage(res, socket);
      });
      return;
    }
    if (msg.type === 'mark-raster' || msg.type === 'unmark-raster') {
      await enqueue(async () => {
        busy = true;
        try {
          const out = await runner.markRaster(msg.type === 'mark-raster', currentTarget());
          for (const m of out) sendPluginMessage(m, socket);
        } catch (error) {
          sendPluginMessage({ type: 'error', message: error.message || String(error) }, socket);
        } finally {
          busy = false;
          await refreshState(true);
        }
      });
      return;
    }
    if (msg.type === 'mark-root' || msg.type === 'unmark-root') {
      await enqueue(async () => {
        busy = true;
        try {
          const out = await runner.markRoot(msg.type === 'mark-root', currentTarget());
          for (const m of out) sendPluginMessage(m, socket);
        } catch (error) {
          sendPluginMessage({ type: 'error', message: error.message || String(error) }, socket);
        } finally {
          busy = false;
          await refreshState(true);
        }
      });
      return;
    }
    if (msg.type === 'layer-tool') {
      await enqueue(async () => {
        busy = true;
        try {
          const out = await runner.runLayerTool(msg.action, currentTarget());
          for (const m of out) sendPluginMessage(m, socket);
        } catch (error) {
          sendPluginMessage({ type: 'error', message: error.message || String(error) }, socket);
        } finally {
          busy = false;
          await refreshState(true);
        }
      });
      return;
    }
    if (msg.type === 'ship-selection') {
      await enqueue(async () => {
        busy = true;
        try {
          await runner.exportSelection(msg, currentTarget(), {
            onMessage: m => sendPluginMessage(m, socket),
          });
        } finally {
          busy = false;
          await refreshState(false);
        }
      });
      return;
    }
    if (msg.type === 'mcp-command') {
      await enqueue(async () => {
        busy = true;
        sendPluginMessage({ type: 'mcp-busy', busy: true }, socket);
        try {
          if (msg.command === 'f2a_export_aep') {
            await runner.executeMcpCommand(msg.command, msg.params || {}, currentTarget(), {
              commandId: msg.id,
              onMessage: m => sendPluginMessage(m, socket),
            });
            return;
          }
          const result = await runner.executeMcpCommand(msg.command, msg.params || {}, currentTarget(), {
            commandId: msg.id,
          });
          sendPluginMessage({ type: 'mcp-result', id: msg.id, result }, socket);
        } catch (error) {
          sendPluginMessage({
            type: 'mcp-result',
            id: msg.id,
            error: error && error.message ? error.message : String(error),
            nodeId: error && error.nodeId ? error.nodeId : null,
          }, socket);
        } finally {
          busy = false;
          sendPluginMessage({ type: 'mcp-busy', busy: false }, socket);
          await refreshState(false);
        }
      });
    }
  }

  function stopHeadlessMcp() {
    if (headlessMcpRetry) { clearTimeout(headlessMcpRetry); headlessMcpRetry = null; }
    if (headlessMcpWs) {
      const ws = headlessMcpWs;
      headlessMcpWs = null;
      ws.close();
    }
  }

  function startHeadlessMcp() {
    if (!enableHeadlessMcp || closed || panelSockets.size > 0 || headlessMcpWs) return;
    const url = 'ws://127.0.0.1:' + mcpPort + '/plugin';
    const ws = connectRawWebSocket(url, {
      onOpen() {
        refreshState(false).catch(() => {}).finally(() => {
          if (headlessMcpWs !== ws || ws.readyState !== 1) return;
          const info = mcpInfoMessageFromState();
          ws.send(JSON.stringify({
            type: 'hello', name: info.name, fileKey: info.fileKey, pageId: info.pageId, pageName: info.pageName,
          }));
        });
      },
      onMessage(text) {
        let message;
        try { message = JSON.parse(text); } catch { return; }
        if (message.type === 'ready') {
          headlessMcpAepParts = !!message.aepParts;
          return;
        }
        if (message.type !== 'command') return;
        enqueue(async () => {
          busy = true;
          try {
            await refreshState(false);
            if (message.command === 'f2a_export_aep') {
              const params = message.params || {};
              const settings = {
                target: 'aep',
                useNodes: true,
                organize: params.organize !== false,
                precompLayers: params.precompLayers !== false,
                ignoreHidden: params.ignoreHidden !== false,
                convertMasks: true,
                nativeImageMasks: params.nativeImageMasks !== false,
                preserveImageFilters: !!params.preserveImageFilters,
                preserveBackgroundBlur: !!params.preserveBackgroundBlur,
                rasterScale: params.rasterScale == null ? 1 : Number(params.rasterScale),
                outlineTexts: params.textMode === 'vector' || params.outlineTexts === true,
                rasterTexts: params.textMode === 'png' || params.rasterTexts === true,
                rasterize: params.rasterize || { effects: true, paints: true, imageCrops: true, masks: true, booleans: true },
                ...params,
              };
              const exported = await runner.exportSelection(settings, currentTarget(), {
                commandId: message.id,
                resolveHeadlessShadows: true,
                throwOnError: true,
                onMessage(m) {
                  if (m.type === 'command_progress' && ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: 'progress', id: message.id }));
                  }
                },
              });
              const packet = exported.packet;
              packet.aeVersion = params.aeVersion || '26.0';
              packet.duration = params.duration != null ? Number(params.duration) : 10;
              packet.frameRate = params.frameRate != null ? Number(params.frameRate) : 30;
              if (headlessMcpAepParts) {
                const json = JSON.stringify(packet);
                for (let offset = 0; offset < json.length; offset += AEP_PART_SIZE) {
                  ws.send(JSON.stringify({ type: 'aep-part', id: message.id, data: json.slice(offset, offset + AEP_PART_SIZE) }));
                }
                ws.send(JSON.stringify({ type: 'result', id: message.id, aepParts: true }));
              } else {
                ws.send(JSON.stringify({ type: 'result', id: message.id, result: packet }));
              }
              return;
            }
            const result = await runner.executeMcpCommand(message.command, message.params || {}, currentTarget(), {
              commandId: message.id,
            });
            ws.send(JSON.stringify({ type: 'result', id: message.id, result }));
          } catch (error) {
            ws.send(JSON.stringify({
              type: 'result',
              id: message.id,
              error: error && error.message ? error.message : String(error),
              nodeId: error && error.nodeId ? error.nodeId : null,
            }));
          } finally {
            busy = false;
          }
        });
      },
      onClose() {
        if (headlessMcpWs === ws) headlessMcpWs = null;
        if (enableHeadlessMcp && !closed && panelSockets.size === 0 && !headlessMcpRetry) {
          headlessMcpRetry = setTimeout(() => { headlessMcpRetry = null; startHeadlessMcp(); }, 1500);
          if (typeof headlessMcpRetry.unref === 'function') headlessMcpRetry.unref();
        }
      },
    });
    headlessMcpWs = ws;
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const reqUrl = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && (reqUrl === '/' || reqUrl === '/index.html')) {
      try {
        const html = renderHostHtml({ title: windowTitle, port });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Failed to render F2A OpenPencil panel: ' + error.message);
      }
      return;
    }
    if (req.method === 'GET' && (reqUrl === '/icon.svg' || reqUrl === '/icon-256.png' || reqUrl === '/favicon.ico')) {
      const target = reqUrl === '/icon.svg'
        ? { file: ICON_SVG_PATH, type: 'image/svg+xml; charset=utf-8' }
        : reqUrl === '/icon-256.png'
          ? { file: ICON_PNG_PATH, type: 'image/png' }
          : { file: ICON_ICO_PATH, type: 'image/x-icon' };
      try {
        const data = fs.readFileSync(target.file);
        res.writeHead(200, { 'Content-Type': target.type, 'Cache-Control': 'public, max-age=86400' });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end();
      }
      return;
    }
    if (req.method === 'GET' && reqUrl === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        service: 'f2a-openpencil',
        version: 1,
        workspace: workspacePlugin,
        windowTitle,
        topmost: topmostEnabled,
        connected: state.connected,
        openpencilVersion: state.version || null,
        scope: state.scope,
        panels: panelSockets.size,
      }));
      return;
    }
    if (req.method === 'GET' && reqUrl === '/status') {
      await refreshState(false);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(state));
      return;
    }
    if (req.method === 'POST' && reqUrl === '/window/topmost') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      const want = body.topmost !== false;
      const waitMs = Number(body.waitMs) || 0;
      let result = { ok: false, supported: topmostSupported, topmost: false };
      if (topmostSupported) {
        ensureWindowIconImpl(windowTitle, { waitMs: Math.max(waitMs, 4000) });
        result = await setTopmostImpl(windowTitle, want, { waitMs });
        if (result && result.ok) topmostEnabled = want;
      }
      broadcast({ type: 'window-state', topmost: topmostEnabled, supported: topmostSupported, title: windowTitle });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ...result, topmost: topmostEnabled, supported: topmostSupported }));
      return;
    }
    if (req.method === 'POST' && reqUrl === '/window/popout') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      const addr = server.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : port;
      const url = 'http://127.0.0.1:' + actualPort;
      const wantTopmost = body.topmost !== false && topmostSupported;
      const width = Number(body.width) || DEFAULT_WIDTH;
      const height = Number(body.height) || DEFAULT_HEIGHT;
      // Respond immediately so callers (such as AE CEP) finish their UI click cleanly,
      // then focus or open the standalone window from this external Node process.
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, url, windowTitle }));
      setTimeout(async () => {
        try {
          const focused = topmostSupported
            ? await focusWindowImpl(windowTitle, { topmost: wantTopmost || topmostEnabled })
            : { found: false };
          if (!focused || !focused.found) {
            const launched = openAppWindowImpl(url, { width, height });
            if (launched && launched.mode === 'app') {
              ensureWindowIconImpl(windowTitle, { waitMs: 10000, force: true });
              if (wantTopmost) {
                const applied = await setTopmostImpl(windowTitle, true, { waitMs: 4000 });
                if (applied && applied.ok) topmostEnabled = true;
                broadcast({ type: 'window-state', topmost: topmostEnabled, supported: topmostSupported, title: windowTitle });
              }
            }
          } else {
            ensureWindowIconImpl(windowTitle, { waitMs: 2000 });
            if (wantTopmost && !topmostEnabled) {
              topmostEnabled = true;
              broadcast({ type: 'window-state', topmost: topmostEnabled, supported: topmostSupported, title: windowTitle });
            }
          }
        } catch {}
      }, 80);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
    );
    panelSockets.add(socket);
    hadPanelConnection = true;
    if (autoExitTimer) { clearTimeout(autoExitTimer); autoExitTimer = null; }
    // Browser panel's ui.html connects directly to F2A MCP relay; yield headless relay to avoid duplicate sessions.
    stopHeadlessMcp();

    const frameState = { partial: null, frags: [] };
    if (!socket.destroyed) {
      socket.write(encodeText(JSON.stringify({
        type: 'window-state', topmost: topmostEnabled, supported: topmostSupported, title: windowTitle,
      })));
    }
    const isEmbeddedSocket = /[?&]embed=ae(?:&|$)/.test(String(req.url || ''));
    if (!isEmbeddedSocket && topmostSupported) {
      ensureWindowIconImpl(windowTitle, { waitMs: 6000 });
    }
    if (topmostEnabled && topmostSupported && !initialTopmostApplied) {
      initialTopmostApplied = true;
      setTopmostImpl(windowTitle, true, { waitMs: 2500 }).catch(() => {});
    }
    refreshState(false).then(() => {
      if (socket.destroyed) return;
      socket.write(encodeText(JSON.stringify({ type: 'openpencil-status', state })));
      sendPluginMessage(selectionMessageFromState(), socket);
    }).catch(() => {});

    socket.on('data', chunk => {
      const msgs = decodeFrames(chunk, frameState);
      for (const m of msgs) {
        if (m.opcode === 0x8) {
          try { socket.write(encodeClose()); } catch {}
          socket.end();
          return;
        }
        if (m.opcode === 0x9) { socket.write(encodePong(m.payload)); continue; }
        if (m.opcode === 0xa) continue;
        if (m.opcode === 0x1 || m.opcode === 0x2) frameState.frags = [m.payload];
        else if (m.opcode === 0x0) frameState.frags.push(m.payload);
        else continue;
        if (m.fin) {
          const text = Buffer.concat(frameState.frags).toString('utf8');
          frameState.frags = [];
          let parsed;
          try { parsed = JSON.parse(text); } catch { continue; }
          if (parsed.type === 'plugin-message') {
            handlePluginMessage(parsed.pluginMessage, socket).catch(() => {});
          } else if (parsed.type === 'select-document' && typeof parsed.documentId === 'string') {
            pinnedDocumentId = parsed.documentId || null;
            selectedDocumentId = pinnedDocumentId;
            refreshState(true).catch(() => {});
          } else if (parsed.type === 'set-topmost') {
            const want = !!parsed.topmost;
            if (!topmostSupported) {
              broadcast({ type: 'window-state', topmost: false, supported: false, title: windowTitle });
            } else {
              setTopmostImpl(windowTitle, want, { waitMs: 500 }).then(result => {
                if (result && result.ok && result.found) topmostEnabled = want;
                else if (result && result.ok) topmostEnabled = want;
                broadcast({ type: 'window-state', topmost: topmostEnabled, supported: topmostSupported, title: windowTitle });
              }).catch(() => {
                broadcast({ type: 'window-state', topmost: topmostEnabled, supported: topmostSupported, title: windowTitle });
              });
            }
          } else if (parsed.type === 'refresh') {
            refreshState(true).catch(() => {});
          }
        }
      }
    });

    socket.on('error', () => {});
    socket.on('close', () => {
      panelSockets.delete(socket);
      if (panelSockets.size === 0 && !closed) {
        if (autoExit && hadPanelConnection) {
          if (autoExitTimer) clearTimeout(autoExitTimer);
          autoExitTimer = setTimeout(() => {
            autoExitTimer = null;
            if (panelSockets.size === 0 && !closed) {
              close().finally(() => { if (onAutoExit) onAutoExit(); });
            }
          }, autoExitGraceMs);
          if (typeof autoExitTimer.unref === 'function') autoExitTimer.unref();
        } else if (enableHeadlessMcp) {
          startHeadlessMcp();
        }
      }
    });
  });

  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    if (!options.windowTitle) windowTitle = windowTitleForPort(addr.port, DEFAULT_PORT);
    const url = 'http://127.0.0.1:' + addr.port;
    if (!options.quiet) {
      console.log('F2A OpenPencil Panel: ' + url);
    }
    ensureLocalAepServer().catch(() => {});
    refreshState(false).catch(() => {}).finally(() => {
      schedulePoll();
      if (enableHeadlessMcp) startHeadlessMcp();
    });
  });

  async function close() {
    closed = true;
    stopWindowIconImpl(windowTitle);
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (autoExitTimer) { clearTimeout(autoExitTimer); autoExitTimer = null; }
    stopHeadlessMcp();
    for (const sock of panelSockets) {
      try { sock.destroy(); } catch {}
    }
    panelSockets.clear();
    if (embeddedAepServer) {
      await new Promise(resolve => embeddedAepServer.close(resolve));
      embeddedAepServer = null;
    }
    await new Promise(resolve => server.close(resolve));
  }

  return {
    server,
    client,
    runner,
    refreshState,
    ensureLocalAepServer,
    getState: () => state,
    close,
  };
}

module.exports = {
  DEFAULT_PORT,
  defaultSettingsPath,
  renderHostHtml,
  connectRawWebSocket,
  startBridge,
};
