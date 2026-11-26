'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 25000;

class OpenPencilError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'OpenPencilError';
    this.code = code;
  }
}

function defaultDiscoveryPath() {
  if (process.env.OPENPENCIL_MCP_DISCOVERY_PATH) {
    return process.env.OPENPENCIL_MCP_DISCOVERY_PATH;
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'OpenPencil', 'mcp.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'OpenPencil', 'mcp.json');
  }
  if (process.env.XDG_RUNTIME_DIR) {
    return path.join(process.env.XDG_RUNTIME_DIR, 'openpencil', 'mcp.json');
  }
  return path.join(os.homedir(), '.openpencil', 'mcp.json');
}

function isProcessAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function readDiscovery(options = {}) {
  if (options.endpoint && typeof options.endpoint === 'object') {
    return {
      pid: options.endpoint.pid ?? process.pid,
      httpPort: options.endpoint.httpPort ?? 0,
      socketPath: options.endpoint.socketPath ?? '',
      authRequired: !!options.endpoint.authRequired,
      authToken: options.endpoint.authToken ?? '',
      version: options.endpoint.version ?? '',
      scope: options.endpoint.scope ?? 'document',
    };
  }
  const filePath = options.discoveryPath || defaultDiscoveryPath();
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!options.skipPidCheck && parsed.pid && !isProcessAlive(parsed.pid)) {
    return null;
  }
  if (!parsed.httpPort && !parsed.socketPath) return null;
  return {
    pid: parsed.pid || 0,
    httpPort: Number(parsed.httpPort) || 0,
    socketPath: typeof parsed.socketPath === 'string' ? parsed.socketPath : '',
    authRequired: !!parsed.authRequired,
    authToken: typeof parsed.authToken === 'string' ? parsed.authToken : '',
    version: typeof parsed.version === 'string' ? parsed.version : '',
    scope: typeof parsed.scope === 'string' ? parsed.scope : 'document',
    discoveryPath: filePath,
  };
}

function platformHasUnixSockets() {
  return process.platform !== 'win32';
}

function isSocketConnectionError(error) {
  if (!error) return false;
  const code = String(error.code || '');
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOENT' ||
    code === 'EACCES' ||
    /ECONNREFUSED|ENOENT/i.test(String(error.message || ''))
  );
}

function selectionScopeError() {
  return new OpenPencilError(
    'selection_scope',
    'OpenPencil 当前启用了“仅共享选区（Share only the selection）”模式，禁止执行导出脚本。请在 OpenPencil 设置 → MCP → Local server 中关闭该选项后重试。'
  );
}

function noAppError() {
  return new OpenPencilError(
    'no_app',
    '未检测到正在运行的 OpenPencil，请先打开 OpenPencil 桌面端并启用本地服务。'
  );
}

function isSelectionScopeMessage(text) {
  return /only shares the selection|selection.{0,20}scope|share only the selection/i.test(String(text || ''));
}

function doHttpRequest(info, reqPath, method, body, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const forceTcp = !!opts.forceTcp;
  return new Promise((resolve, reject) => {
    const bodyJson = body === undefined ? undefined : JSON.stringify(body);
    const headers = {};
    if (bodyJson !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyJson);
    }
    if (info.authToken) {
      headers.Authorization = 'Bearer ' + info.authToken;
    }
    const useSocket = !forceTcp && platformHasUnixSockets() && info.socketPath;
    const reqOpts = useSocket
      ? { socketPath: info.socketPath, path: reqPath, method, headers }
      : { hostname: '127.0.0.1', port: info.httpPort, path: reqPath, method, headers };

    const req = http.request(reqOpts, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
        resolve({ status: res.statusCode || 500, data });
      });
      res.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const timer = setTimeout(() => {
      req.destroy(new OpenPencilError('timeout', 'OpenPencil RPC 请求超时（' + Math.round(timeoutMs / 1000) + 's）'));
    }, timeoutMs);

    req.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    if (bodyJson !== undefined) req.write(bodyJson);
    req.end();
  });
}

async function requestWithTransportFallback(info, reqPath, method, body, opts = {}) {
  try {
    return await doHttpRequest(info, reqPath, method, body, opts);
  } catch (error) {
    if (!platformHasUnixSockets() || !info.socketPath || !(info.httpPort > 0) || !isSocketConnectionError(error)) {
      throw error;
    }
    return doHttpRequest(info, reqPath, method, body, { ...opts, forceTcp: true });
  }
}

function targetArgs(target) {
  const out = {};
  if (!target || typeof target !== 'object') return out;
  const docId = target.documentId || target.document_id;
  const pageId = target.pageId || target.page_id;
  if (typeof docId === 'string' && docId) out.document_id = docId;
  if (typeof pageId === 'string' && pageId) out.page_id = pageId;
  return out;
}

function createClient(options = {}) {
  let cachedInfo = null;

  function discover(forceRefresh = false) {
    if (!forceRefresh && cachedInfo) return cachedInfo;
    cachedInfo = readDiscovery(options);
    return cachedInfo;
  }

  function clearCache() {
    cachedInfo = null;
  }

  async function health() {
    const info = discover(true);
    if (!info) {
      return {
        connected: false,
        ok: false,
        errorCode: 'no_app',
        error: noAppError().message,
      };
    }
    try {
      const { status, data } = await requestWithTransportFallback(info, '/health', 'GET', undefined, {
        timeoutMs: Math.min(options.timeoutMs || DEFAULT_TIMEOUT_MS, 5000),
      });
      if (status >= 400) {
        return {
          connected: false,
          ok: false,
          errorCode: status === 401 ? 'auth_failed' : 'rpc_error',
          error: (data && typeof data === 'object' && data.error) || ('HTTP ' + status),
        };
      }
      const scope = (data && typeof data === 'object' && data.scope) || info.scope || 'document';
      const version = (data && typeof data === 'object' && data.version) || info.version || '';
      return {
        connected: true,
        ok: true,
        version,
        scope,
        httpPort: info.httpPort,
        socketPath: info.socketPath || null,
        pid: info.pid || null,
        selectionOnly: scope === 'selection',
        errorCode: scope === 'selection' ? 'selection_scope' : null,
        error: scope === 'selection' ? selectionScopeError().message : null,
      };
    } catch (error) {
      clearCache();
      return {
        connected: false,
        ok: false,
        errorCode: 'no_app',
        error: noAppError().message,
        detail: error && error.message ? error.message : String(error),
      };
    }
  }

  async function rpcResponse(command, args = {}, opts = {}) {
    let info = discover(false);
    if (!info) info = discover(true);
    if (!info) throw noAppError();

    if (command === 'eval' && info.scope === 'selection') {
      throw selectionScopeError();
    }

    const attempt = async currentInfo => {
      let response;
      try {
        response = await requestWithTransportFallback(currentInfo, '/rpc', 'POST', { command, args }, {
          timeoutMs: opts.timeoutMs || options.timeoutMs || DEFAULT_TIMEOUT_MS,
        });
      } catch (error) {
        if (error instanceof OpenPencilError) throw error;
        clearCache();
        if (isSocketConnectionError(error)) throw noAppError();
        throw new OpenPencilError('rpc_error', 'OpenPencil 通信失败：' + (error.message || error), { cause: error });
      }
      const { status, data } = response;
      if (status === 401) {
        throw new OpenPencilError('auth_failed', 'OpenPencil 认证令牌已过期');
      }
      if (status >= 400) {
        const message = (data && typeof data === 'object' && data.error) || ('RPC failed: HTTP ' + status);
        if (isSelectionScopeMessage(message)) throw selectionScopeError();
        throw new OpenPencilError('rpc_error', message);
      }
      if (data && typeof data === 'object' && data.ok === false) {
        const message = data.error || 'RPC failed';
        if (isSelectionScopeMessage(message)) throw selectionScopeError();
        throw new OpenPencilError('rpc_error', message);
      }
      return {
        result: data && typeof data === 'object' ? data.result : data,
        target: data && typeof data === 'object' ? data.target : undefined,
      };
    };

    try {
      return await attempt(info);
    } catch (error) {
      if (error instanceof OpenPencilError && error.code === 'auth_failed') {
        const refreshed = discover(true);
        if (!refreshed) throw noAppError();
        return attempt(refreshed);
      }
      throw error;
    }
  }

  async function rpc(command, args = {}, opts = {}) {
    const response = await rpcResponse(command, args, opts);
    return response.result;
  }

  async function listDocuments() {
    const result = await rpc('list_documents', {});
    if (Array.isArray(result)) return result;
    if (result && Array.isArray(result.documents)) return result.documents;
    return [];
  }

  async function getSelection(target) {
    return rpcResponse('selection', targetArgs(target));
  }

  async function evalCode(code, target, opts = {}) {
    return rpcResponse('eval', { ...targetArgs(target), code }, opts);
  }

  async function callTool(name, args = {}, target, opts = {}) {
    return rpcResponse('tool', { ...targetArgs(target), name, args }, opts);
  }

  async function activateDocument(target) {
    return rpcResponse('activate_document', targetArgs(target));
  }

  return {
    discover,
    clearCache,
    health,
    rpc,
    rpcResponse,
    listDocuments,
    getSelection,
    evalCode,
    callTool,
    activateDocument,
  };
}

module.exports = {
  OpenPencilError,
  DEFAULT_TIMEOUT_MS,
  defaultDiscoveryPath,
  isProcessAlive,
  readDiscovery,
  targetArgs,
  createClient,
};
