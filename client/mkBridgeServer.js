/*
 * mkBridgeServer.js — Overlord-style localhost bridge.
 * A dependency-free WebSocket server that runs in the CEP panel's Node context (AE side).
 * The Figma plugin connects to ws://localhost:PORT and "ships" SVG; this server receives it,
 * saves a temp .svg, and calls back so the panel can run runSvgToShapes() in ExtendScript.
 *
 * No npm deps — implements the WebSocket handshake + minimal frame codec by hand,
 * so it works in a vanilla CEP Node runtime.
 *
 *   var bridge = require('./mkBridgeServer.js');
 *   var server = bridge.start({
 *     port: 7365,
 *     onSvg: function (svg, meta) {
 *       var p = bridge.saveTemp(svg);
 *       // csInterface.evalScript('runSvgToShapes("' + p.replace(/\\/g,'/') + '")', cb);
 *       return { ok: true };                  // returned to the plugin as an ack
 *     },
 *     onStatus: function (s) { console.log('[bridge]', s); }
 *   });
 */

var http = require('http');
var crypto = require('crypto');

var WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

// ---- frame decode (client->server frames are masked) -----------------------
function decodeFrames(buf, state) {
  // state.partial carries leftover bytes between chunks
  var data = state.partial ? Buffer.concat([state.partial, buf]) : buf;
  state.partial = null;
  var msgs = [];
  var offset = 0;
  while (offset + 2 <= data.length) {
    var b0 = data[offset], b1 = data[offset + 1];
    var fin = (b0 & 0x80) !== 0;
    var opcode = b0 & 0x0f;
    var masked = (b1 & 0x80) !== 0;
    var len = b1 & 0x7f;
    var p = offset + 2;
    if (len === 126) { if (p + 2 > data.length) break; len = data.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > data.length) break; len = data.readUInt32BE(p) * 0x100000000 + data.readUInt32BE(p + 4); p += 8; } // 32-bit math (legacy-Node safe)
    var mask = null;
    if (masked) { if (p + 4 > data.length) break; mask = data.slice(p, p + 4); p += 4; }
    if (p + len > data.length) break; // wait for more
    var payload = data.slice(p, p + len);
    if (masked) { for (var i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]; }
    msgs.push({ opcode: opcode, fin: fin, payload: payload });
    offset = p + len;
  }
  if (offset < data.length) state.partial = data.slice(offset);
  return msgs;
}

// ---- frame encode (server->client frames are unmasked) ---------------------
function encodeText(str) {
  var payload = Buffer.from(str, 'utf8');
  var len = payload.length, header;
  if (len < 126) { header = Buffer.from([0x81, len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeUInt32BE(Math.floor(len / 0x100000000), 2); header.writeUInt32BE(len % 0x100000000, 6); }
  return Buffer.concat([header, payload]);
}
function encodeClose() { return Buffer.from([0x88, 0x00]); }
function encodePong(payload) {
  var p = payload || Buffer.alloc(0);
  return Buffer.concat([Buffer.from([0x8a, p.length]), p]);
}

function start(opts) {
  opts = opts || {};
  var port = opts.port == null ? 7365 : opts.port;
  var onSvg = opts.onSvg || function () { return { ok: true }; };
  var onImages = opts.onImages || function () { return { ok: true }; };
  var imgBuf = [], imgTimer = null, explicitImageEnd = false, expectedImages = 0;
  function abortImages(message) {
    if (imgTimer) { clearTimeout(imgTimer); imgTimer = null; }
    imgBuf = []; explicitImageEnd = false; expectedImages = 0;
    if (opts.onAbort) opts.onAbort(message);
  }
  function flushImages(allowEmpty) {
    if (imgTimer) { clearTimeout(imgTimer); imgTimer = null; }
    if (!imgBuf.length && !allowEmpty) return;
    var batch = imgBuf; imgBuf = [];
    if (batch.length !== expectedImages) { abortImages('图片数据不完整，已取消导入'); return; }
    expectedImages = 0;
    try { onImages(batch); } catch (e) { onStatus('image handler: ' + e.message); }
  }
  var onStatus = opts.onStatus || function () {};

  var server = http.createServer(function (req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Private-Network':'true'});
      res.end(); return;
    }
    if (req.url === '/aep/start' && req.method === 'POST') {
      function started(error) {
        res.writeHead(error ? 400 : 200, {'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify(error ? {ok:false,error:error.message} : {ok:true}));
      }
      try {
        if (!opts.onStartAep) throw new Error('请更新并重新打开 AE 的 F2A 面板。');
        opts.onStartAep(started);
      } catch (error) { started(error); }
      return;
    }
    if (req.url === '/image-folder') {
      function reply(error, directory) {
        res.writeHead(error ? 400 : 200, {'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify(error ? {error:error.message} : {directory:directory || null}));
      }
      try {
        if (req.method === 'GET' && opts.onGetImageFolder) reply(null, opts.onGetImageFolder());
        else if (req.method === 'POST' && opts.onChooseImageFolder) opts.onChooseImageFolder(reply);
        else reply(new Error('请重新打开 AE 的 F2A 面板'));
      } catch (error) { reply(error); }
      return;
    }
    // simple health check + HTTP file fallback (plugin can POST here if WS is blocked)
    if (req.method === 'POST') {
      var body = '';
      req.on('data', function (c) { body += c; });
      req.on('end', function () {
        var ack = safeHandle(body, { via: 'http' });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(ack));
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('f2a bridge up on ' + port);
  });

  server.on('upgrade', function (req, socket) {
    var key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
    );
    onStatus('client connected');
    var state = { partial: null, frags: [] };
    socket.on('data', function (chunk) {
      var msgs = decodeFrames(chunk, state);
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (m.opcode === 0x8) { socket.write(encodeClose()); socket.end(); onStatus('client closed'); return; }
        if (m.opcode === 0x9) { socket.write(encodePong(m.payload)); continue; } // ping
        if (m.opcode === 0xa) { continue; }                                       // pong
        // Data frames: 0x1 text / 0x2 binary begin a message, 0x0 continues it.
        // Reassemble across frames until FIN=1 (browsers fragment large messages).
        if (m.opcode === 0x1 || m.opcode === 0x2) { state.frags = [m.payload]; }
        else if (m.opcode === 0x0) { state.frags.push(m.payload); }
        else { continue; }
        if (m.fin) {
          var text = Buffer.concat(state.frags).toString('utf8');
          state.frags = [];
          var ack = safeHandle(text, { via: 'ws' });
          socket.write(encodeText(JSON.stringify(ack)));
        }
      }
    });
    socket.on('error', function () {});
  });

  function safeHandle(text, meta) {
    try {
      // message is JSON: { type:"svg", svg:"<svg...>", name:"Frame 1" }  (or raw SVG)
      // NOTE: this is a WHITELIST — a field that is not copied here never reaches the panel.
      // Forgetting to add one is silent: organize mode looked completely dead for exactly that
      // reason, because `containers` was dropped right here.
      var msg = null, svg, name, texts = null, effects = null, shift = null, nodes = null;
      var containers = null, organize = false, imageCount = 0, vnStats = null, compSize = null;
      if (text.charAt(0) === '{') {
        msg = JSON.parse(text);
        if (msg.type === 'export-abort') {
          if (expectedImages) abortImages(msg.message || '导出失败，已取消导入');
          return {ok: false, error: msg.message || '导出失败，已取消导入'};
        }
        if (msg.type === 'images-complete') {
          if (explicitImageEnd) { explicitImageEnd = false; flushImages(true); }
          return { ok: true };
        }
        // images arrive one per message (see ui.html) and are buffered until the last one
        if (msg.type === 'image' && msg.image) {
          imgBuf.push(msg.image);
          // Modern exports explicitly finish the batch. Rendering the next PNG can take more
          // than two seconds; silence must not trigger an early import/precompose of a partial set.
          if (explicitImageEnd) return { ok: true, buffered: imgBuf.length };
          // Wait for the whole set, but ALSO flush shortly after the last arrival: if any
          // picture failed to encode the expected total is never reached and the batch
          // would hang forever (which is why nothing was imported).
          if (imgTimer) clearTimeout(imgTimer);
          if (imgBuf.length >= (msg.total || 1)) { flushImages(); return { ok: true, flushed: true }; }
          imgTimer = setTimeout(flushImages, 2000);
          return { ok: true, buffered: imgBuf.length };
        }
        svg = msg.svg; name = msg.name; texts = msg.texts || null; effects = msg.effects || null; shift = msg.shift || null; nodes = msg.nodes || null;
        containers = msg.containers || null; organize = !!msg.organize; imageCount = msg.imageCount || 0; vnStats = msg.vnStats || null;
        compSize = msg.compSize || null;
        explicitImageEnd = !!msg.imageBatch && imageCount > 0;
        expectedImages = imageCount;
      }
      else { svg = text; }
      if (!svg || svg.indexOf('<svg') === -1) return { ok: false, error: 'no svg in message' };
      var result = onSvg(svg, { name: name, via: meta.via, texts: texts, effects: effects, shift: shift, nodes: nodes,
                                containers: containers, organize: organize, imageCount: imageCount, vnStats: vnStats, compSize: compSize });
      return result || { ok: true };
    } catch (e) {
      onStatus('handle error: ' + e.message);
      return { ok: false, error: String(e.message || e) };
    }
  }

  // A port held by a stale panel context must surface instead of leaving the bar at "starting".
  server.on('error', function (e) {
    onStatus('error: ' + (e && e.code ? e.code : (e && e.message) || e));
  });
  server.listen(port, '127.0.0.1', function () { onStatus('listening on ' + port); });
  return server;
}

// ---- save incoming SVG to a temp file for ExtendScript to read -------------
var savedSerial = 0;
function saveTemp(svg, name) {
  var fs = require('fs'), os = require('os'), path = require('path');
  var safe = (name || 'figma').replace(/[^A-Za-z0-9_-]+/g, '_');
  var p = path.join(os.tmpdir(), 'f2a_' + safe + '_' + Date.now() + '_' + (++savedSerial) + '.svg');
  fs.writeFileSync(p, svg, 'utf8');
  return p;
}

module.exports = { start: start, saveTemp: saveTemp, decodeFrames: decodeFrames, encodeText: encodeText, acceptKey: acceptKey };
