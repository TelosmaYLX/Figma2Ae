'use strict';

const http = require('node:http');
const {randomUUID} = require('node:crypto');
const {WebSocketServer, WebSocket} = require('ws');

function start({port = 7869, commandTimeout = 60000, idleTimeout = 60000} = {}) {
  const sessions = new Map(), pending = new Map();
  let lastActivity = Date.now();
  function reply(res, status, body) {
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
    res.end(JSON.stringify(body));
  }
  function settle(id, error, result) {
    const job = pending.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    pending.delete(id);
    if (!job.res.destroyed) reply(job.res, error ? 400 : 200, error ? {error} : {result});
  }
  function arm(id, job) {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => settle(id, 'Figma 操作超时'), commandTimeout);
  }
  const server = http.createServer(async (req, res) => {
    lastActivity = Date.now();
    // Only the WebSocket is used by Figma. HTTP commands are local Node-to-Node calls.
    if (req.headers.origin) { reply(res, 403, {error:'Browser HTTP requests are not supported'}); return; }
    if (req.method === 'GET' && req.url === '/health') {
      reply(res, 200, {service:'f2a-mcp', version:1, pid:process.pid, sessions:sessions.size}); return;
    }
    if (req.method === 'GET' && req.url === '/sessions') {
      reply(res, 200, {sessions:[...sessions.values()].map(({info}) => info)}); return;
    }
    if (req.method !== 'POST' || req.url !== '/command') { reply(res, 404, {error:'Not found'}); return; }
    try {
      let size = 0;
      const parts = [];
      for await (const part of req) {
        size += part.length;
        if (size > 64 * 1024 * 1024) throw new Error('MCP 请求超过 64 MB');
        parts.push(part);
      }
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      const session = sessions.get(body.sessionId);
      if (!session || session.socket.readyState !== WebSocket.OPEN) throw new Error('F2A 文档已断开，请重新打开 Figma 中的 F2A');
      if (typeof body.command !== 'string') throw new Error('缺少 MCP 命令');
      const id = randomUUID(), job = {res, socket:session.socket};
      pending.set(id, job);
      arm(id, job);
      res.on('close', () => { clearTimeout(job.timer); pending.delete(id); });
      session.socket.send(JSON.stringify({type:'command', id, command:body.command, params:{...body.params, commandId:id}}));
    } catch (error) { reply(res, 400, {error:error.message}); }
  });
  const sockets = new WebSocketServer({server, path:'/plugin', maxPayload:128 * 1024 * 1024,
    verifyClient:({origin}) => !origin || origin === 'null' || /^https:\/\/([a-z0-9-]+\.)*figma\.com$/i.test(origin)});
  sockets.on('connection', socket => {
    const sessionId = randomUUID();
    socket.on('message', bytes => {
      lastActivity = Date.now();
      try {
        const message = JSON.parse(bytes.toString());
        if (message.type === 'hello') {
          const info = {id:sessionId, name:String(message.name || 'Figma'), fileKey:message.fileKey || null, pageId:message.pageId || null, pageName:message.pageName || null};
          sessions.set(sessionId, {socket, info});
          socket.send(JSON.stringify({type:'ready', sessionId}));
        } else if (message.type === 'result' || message.type === 'progress') {
          const job = pending.get(message.id);
          if (!job || job.socket !== socket) return;
          if (message.type === 'progress') arm(message.id, job);
          else settle(message.id, message.error, message.result);
        }
      } catch (error) { socket.send(JSON.stringify({type:'error', error:error.message})); }
    });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      sessions.delete(sessionId);
      for (const [id, job] of pending) if (job.socket === socket) settle(id, 'F2A 文档已断开');
    });
  });
  const idle = setInterval(() => {
    if (!sockets.clients.size && !pending.size && Date.now() - lastActivity >= idleTimeout) server.close();
  }, Math.min(idleTimeout, 10000));
  idle.unref();
  server.on('close', () => { clearInterval(idle); sockets.close(); });
  server.listen(port, '127.0.0.1');
  return {server, sockets, sessions, pending};
}

if (require.main === module) {
  const {server} = start({port:Number(process.env.F2A_MCP_PORT || 7869)});
  server.on('error', error => { if (error.code !== 'EADDRINUSE') console.error(error.message); process.exit(1); });
}
module.exports = {start};
