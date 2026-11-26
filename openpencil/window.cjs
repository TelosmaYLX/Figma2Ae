'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 840;
const DEFAULT_TITLE = 'F2A · OpenPencil';
const DEFAULT_ICON_PATH = path.join(__dirname, 'favicon.ico');
const iconKeepers = new Map();

function windowTitleForPort(port, defaultPort = 7369) {
  return (!port || Number(port) === Number(defaultPort))
    ? DEFAULT_TITLE
    : DEFAULT_TITLE + ' (:' + port + ')';
}

function defaultProfileDir() {
  if (process.env.F2A_OPENPENCIL_PROFILE_DIR) {
    return process.env.F2A_OPENPENCIL_PROFILE_DIR;
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'F2A', 'openpencil-window-profile');
  }
  return path.join(os.homedir(), '.config', 'f2a', 'openpencil-window-profile');
}

function browserCandidates() {
  const list = [];
  if (process.env.F2A_OPENPENCIL_BROWSER) {
    list.push(process.env.F2A_OPENPENCIL_BROWSER);
  }
  if (process.platform === 'win32') {
    const pf86 = process.env['ProgramFiles(x86)'] || '';
    const pf = process.env.ProgramFiles || '';
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    // Prefer Edge first on Windows so it stays isolated from Chrome/default browser sessions.
    for (const root of [pf86, pf, local]) {
      if (root) list.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
    for (const root of [pf, pf86, local]) {
      if (root) list.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    for (const root of [pf, pf86, local]) {
      if (root) list.push(path.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
    }
    return list;
  }
  if (process.platform === 'darwin') {
    list.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    list.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
    return list;
  }
  return ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser'];
}

function findAppBrowser(override) {
  if (override && fs.existsSync(override)) return override;
  const candidates = browserCandidates();
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
    } else {
      const pathDirs = String(process.env.PATH || '').split(path.delimiter);
      for (const dir of pathDirs) {
        const full = path.join(dir, candidate);
        if (fs.existsSync(full)) return full;
      }
    }
  }
  return null;
}

function buildAppArgs(url, options = {}) {
  const width = Math.max(320, Number(options.width) || DEFAULT_WIDTH);
  const height = Math.max(520, Number(options.height) || DEFAULT_HEIGHT);
  const profileDir = options.profileDir || defaultProfileDir();
  return [
    '--app=' + url,
    '--window-size=' + Math.round(width) + ',' + Math.round(height),
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
  ];
}

function openDefaultBrowser(url) {
  try {
    if (process.platform === 'win32') {
      const child = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return { mode: 'browser', binary: 'cmd.exe', child };
    }
    if (process.platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
      child.unref();
      return { mode: 'browser', binary: 'open', child };
    }
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return { mode: 'browser', binary: 'xdg-open', child };
  } catch (error) {
    return { mode: 'none', error: error.message };
  }
}

function openAppWindow(url, options = {}) {
  if (options.useDefaultBrowser) {
    return openDefaultBrowser(url);
  }
  const binary = findAppBrowser(options.browserPath);
  if (!binary) {
    return openDefaultBrowser(url);
  }
  const profileDir = options.profileDir || defaultProfileDir();
  try {
    fs.mkdirSync(profileDir, { recursive: true });
  } catch {}
  const args = buildAppArgs(url, { ...options, profileDir });
  const child = spawn(binary, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return { mode: 'app', binary, args, profileDir, child };
}

function isTopmostSupported() {
  return process.platform === 'win32';
}

async function runTopmostScript(titlePrefix, { topmost = true, waitMs = 0, bringToFront = false } = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, supported: false, found: false, topmost: false };
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const scriptPath = path.join(__dirname, 'set-topmost.ps1');
  try {
    const { stdout } = await run(powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', scriptPath,
      '-TitlePrefix', titlePrefix,
      '-Topmost', topmost ? '1' : '0',
      '-WaitMs', String(Math.max(0, Math.round(waitMs))),
      '-BringToFront', bringToFront ? '1' : '0',
    ], { windowsHide: true, timeout: Math.max(8000, waitMs + 5000) });
    const parsed = JSON.parse(String(stdout || '').trim());
    return { supported: true, ...parsed };
  } catch (error) {
    return { ok: false, supported: true, found: false, topmost: !!topmost, error: error.message };
  }
}

async function setWindowTopmost(titlePrefix, topmost, options = {}) {
  return runTopmostScript(titlePrefix, { topmost: !!topmost, waitMs: options.waitMs || 0, bringToFront: false });
}

async function focusWindow(titlePrefix, options = {}) {
  return runTopmostScript(titlePrefix, { topmost: !!options.topmost, waitMs: 0, bringToFront: true });
}

function ensureWindowIcon(titlePrefix, options = {}) {
  if (process.platform !== 'win32' || !titlePrefix) {
    return { ok: false, supported: false };
  }
  const iconPath = options.iconPath || DEFAULT_ICON_PATH;
  if (!fs.existsSync(iconPath)) {
    return { ok: false, supported: true, reason: 'missing-icon' };
  }
  const existing = iconKeepers.get(titlePrefix);
  if (!options.force && existing && existing.exitCode === null && !existing.killed) {
    return { ok: true, supported: true, reused: true, pid: existing.pid };
  }
  if (existing) stopWindowIcon(titlePrefix);
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const scriptPath = path.join(__dirname, 'window-icon.ps1');
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, supported: true, reason: 'missing-script' };
  }
  const waitMs = Math.max(0, Math.round(Number(options.waitMs) || 10000));
  try {
    const child = spawn(powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', scriptPath,
      '-TitlePrefix', titlePrefix,
      '-IconPath', iconPath,
      '-WaitMs', String(waitMs),
      '-ParentPid', String(process.pid),
    ], { stdio: 'ignore', windowsHide: true });
    child.unref();
    iconKeepers.set(titlePrefix, child);
    child.once('exit', () => {
      if (iconKeepers.get(titlePrefix) === child) iconKeepers.delete(titlePrefix);
    });
    return { ok: true, supported: true, reused: false, pid: child.pid };
  } catch (error) {
    return { ok: false, supported: true, error: error.message };
  }
}

function stopWindowIcon(titlePrefix) {
  if (titlePrefix) {
    const child = iconKeepers.get(titlePrefix);
    iconKeepers.delete(titlePrefix);
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill(); } catch {}
    }
    return;
  }
  for (const [key, child] of iconKeepers.entries()) {
    iconKeepers.delete(key);
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill(); } catch {}
    }
  }
}

module.exports = {
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  DEFAULT_TITLE,
  DEFAULT_ICON_PATH,
  windowTitleForPort,
  defaultProfileDir,
  findAppBrowser,
  buildAppArgs,
  openAppWindow,
  openDefaultBrowser,
  isTopmostSupported,
  setWindowTopmost,
  focusWindow,
  ensureWindowIcon,
  stopWindowIcon,
};
