#!/usr/bin/env node
'use strict';

const http = require('node:http');
const { DEFAULT_PORT, startBridge } = require('../openpencil/bridge.cjs');
const {
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  windowTitleForPort,
  openAppWindow,
  isTopmostSupported,
  setWindowTopmost,
  focusWindow,
  ensureWindowIcon,
} = require('../openpencil/window.cjs');

function printHelp() {
  console.log([
    'F2A for OpenPencil — 独立浮窗面板与桥接服务',
    '',
    '用法:',
    '  node scripts/openpencil-panel.cjs [选项]',
    '',
    '选项:',
    '  --port <n>         面板服务端口（默认 7369，或环境变量 F2A_OPENPENCIL_PORT）',
    '  --workspace        使用开发工作区模式（优先连接 17366 端口的导出服务）',
    '  --width <px>       独立小窗宽度（默认 360）',
    '  --height <px>      独立小窗高度（默认 840）',
    '  --no-topmost       独立小窗默认不置顶（默认在 Windows 下自动置顶，面板顶部可随时切换）',
    '  --browser          改用系统默认浏览器标签页打开，而非独立应用小窗',
    '  --auto-exit        关闭小窗后自动结束后台服务（适合双击启动器）',
    '  --mcp              无面板打开时自动连接 F2A MCP 中继（ws://127.0.0.1:7367/plugin）',
    '  --mcp-port <n>     F2A MCP 中继端口（默认 7367）',
    '  --headless         无头 MCP 模式（等价于 --mcp --no-open）',
    '  --no-open          启动后不自动弹出窗口',
    '  --no-auto-aep      不自动在后台拉起本地 AEP/HTML 导出服务',
    '  --document <id>    指定默认连接的 OpenPencil 文档 ID',
    '  -h, --help         显示帮助信息',
  ].join('\n'));
}

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.F2A_OPENPENCIL_PORT || DEFAULT_PORT),
    workspace: false,
    open: true,
    useDefaultBrowser: false,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    topmost: true,
    autoExit: false,
    mcp: false,
    mcpPort: Number(process.env.F2A_MCP_PORT || 7367),
    autoStartAep: true,
    documentId: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--workspace') opts.workspace = true;
    else if (arg === '--no-open') opts.open = false;
    else if (arg === '--browser') { opts.useDefaultBrowser = true; opts.topmost = false; }
    else if (arg === '--no-topmost') opts.topmost = false;
    else if (arg === '--topmost') opts.topmost = true;
    else if (arg === '--auto-exit') opts.autoExit = true;
    else if (arg === '--mcp') opts.mcp = true;
    else if (arg === '--headless') { opts.mcp = true; opts.open = false; opts.topmost = false; }
    else if (arg === '--no-auto-aep') opts.autoStartAep = false;
    else if (arg === '--port' && argv[i + 1]) opts.port = Number(argv[++i]);
    else if (arg === '--width' && argv[i + 1]) opts.width = Number(argv[++i]);
    else if (arg === '--height' && argv[i + 1]) opts.height = Number(argv[++i]);
    else if (arg === '--mcp-port' && argv[i + 1]) opts.mcpPort = Number(argv[++i]);
    else if (arg === '--document' && argv[i + 1]) opts.documentId = argv[++i];
    else throw new Error('未知参数：' + arg);
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new Error('无效端口号：' + opts.port);
  }
  return opts;
}

function probeExistingPanel(port) {
  if (!(port > 0)) return Promise.resolve(null);
  return new Promise(resolve => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/health', method: 'GET' }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(null); return; }
        try {
          const info = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(info && info.service === 'f2a-openpencil' ? info : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.setTimeout(600, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function notifyServerTopmost(port, topmost, waitMs) {
  return new Promise(resolve => {
    const raw = JSON.stringify({ topmost: !!topmost, waitMs: waitMs || 0 });
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/window/topmost',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) },
    }, res => {
      res.resume();
      res.on('end', () => resolve(true));
    });
    req.setTimeout(Math.max(5000, (waitMs || 0) + 3000), () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.write(raw);
    req.end();
  });
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp();
    return null;
  }

  // If the panel bridge is already running on this port, focus its mini window (or open a new one) instead of failing with EADDRINUSE.
  const existing = await probeExistingPanel(opts.port);
  if (existing) {
    const url = 'http://127.0.0.1:' + opts.port;
    const title = existing.windowTitle || windowTitleForPort(opts.port, DEFAULT_PORT);
    if (opts.open) {
      const focused = !opts.useDefaultBrowser && isTopmostSupported()
        ? await focusWindow(title, { topmost: existing.topmost })
        : { found: false };
      if (!focused.found) {
        const launched = openAppWindow(url, {
          width: opts.width,
          height: opts.height,
          useDefaultBrowser: opts.useDefaultBrowser,
        });
        if (launched.mode === 'app' && opts.topmost && isTopmostSupported()) {
          await notifyServerTopmost(opts.port, true, 4000);
        }
      }
    }
    return { reused: true, url };
  }

  const windowTitle = windowTitleForPort(opts.port, DEFAULT_PORT);
  const wantTopmost = opts.open && !opts.useDefaultBrowser && opts.topmost && isTopmostSupported();

  const bridge = startBridge({
    port: opts.port,
    workspace: opts.workspace,
    windowTitle,
    topmost: wantTopmost,
    autoExit: opts.autoExit,
    onAutoExit() { process.exit(0); },
    mcp: opts.mcp,
    mcpPort: opts.mcpPort,
    autoStartAep: opts.autoStartAep,
    documentId: opts.documentId,
  });

  bridge.server.once('listening', () => {
    const addr = bridge.server.address();
    const url = 'http://127.0.0.1:' + addr.port;
    const effectiveTitle = windowTitleForPort(addr.port, DEFAULT_PORT);
    if (opts.mcp) {
      console.log('F2A OpenPencil MCP Bridge: ws://127.0.0.1:' + opts.mcpPort + '/plugin');
    }
    if (opts.open) {
      const launched = openAppWindow(url, {
        width: opts.width,
        height: opts.height,
        useDefaultBrowser: opts.useDefaultBrowser,
      });
      if (launched.mode === 'app') {
        console.log('F2A OpenPencil Mini Window (' + opts.width + 'x' + opts.height + '): ' + launched.binary);
        ensureWindowIcon(effectiveTitle, { waitMs: 10000, force: true });
        if (wantTopmost) {
          setWindowTopmost(effectiveTitle, true, { waitMs: 4000 }).catch(() => {});
        }
      }
    }
  });

  bridge.server.on('error', error => {
    console.error('无法启动 F2A OpenPencil 面板服务：' + error.message);
    process.exitCode = 1;
  });

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    bridge.close().finally(() => process.exit(0));
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return bridge;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, probeExistingPanel, main };
