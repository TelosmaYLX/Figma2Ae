/* ===== f2a — Figma bridge (client side) =====
 * Runs in the panel. Starts the localhost WebSocket bridge, loads the SVG->shapes
 * ExtendScript engine into the persistent AE engine, and commits complete payloads through
 * runImportBatch(). Figma drives imports through the bridge routes; the panel itself exposes
 * no buttons. Requires Node in-panel (--enable-nodejs + --mixed-context). Degrades to a
 * preview no-op in a plain browser.
 */
(function () {
  "use strict";
  var PORT = 7365;
  var CEP = (typeof window.__adobe_cep__ !== "undefined");
  var MKFigma = window.MKFigma = { connected: false, selectImageFolder: noop };

  var baseStatus = "正在启动 SVG 桥接…";   // persistent line the bar returns to
  var revertTimer = null;
  var tempSerial = 0;

  function noop() {}
  function paint(text) {
    var dot = document.getElementById("mk-fig-dot");
    var lbl = document.getElementById("mk-fig-label");
    if (dot) dot.className = "mk-fig-dot " + (MKFigma.connected ? "on" : "off");
    if (lbl) lbl.textContent = text;
  }
  // persistent state (connection) — stays until it changes
  function setBase(text) {
    baseStatus = text;
    if (revertTimer) { clearTimeout(revertTimer); revertTimer = null; }
    paint(text);
  }
  // transient message — shows, then fades back to the base connection line
  function flash(text, isErr) {
    paint(text);
    if (window.MKReport) window.MKReport(text, isErr);
    if (window.console) console.log("[svg-import] " + text);
    if (revertTimer) clearTimeout(revertTimer);
    revertTimer = setTimeout(function () { paint(baseStatus); }, 3500);
  }
  // Progress lines for the panel console. main.js owns the widget, so guard the hand-off.
  function log(text, tone) { if (window.MKLog) window.MKLog(text, tone); }
  function setConn(on) {
    MKFigma.connected = on;
    setBase(on ? "桥接服务运行中 · 端口 :" + PORT : "桥接服务已离线。请重新打开面板");
    log(on ? "Figma 桥接已连接 · 端口 " + PORT : "Figma 桥接已断开，等待重连", on ? "ok" : "err");
  }

  if (!CEP) {
    MKFigma.selectImageFolder = function () { flash('请在 AE 中选择图片保存位置'); };
    document.addEventListener("DOMContentLoaded", function () { setBase("预览模式（请在 AE 中打开）"); });
    return;
  }

  // Every import writes a pile of throwaway files into TEMP: one .ffx per gradient, plus the
  // svg / nodes / texts / effects json. Nothing ever deleted them, so a long session quietly ate
  // the disk — and once the disk is full the failures are SILENT: a gradient .ffx that cannot be
  // written just means the gradient disappears. Sweep our own leftovers before each import.
  function sweepTemp(maxAgeMs) {
    try {
      var fs = require('fs'), os = require('os'), path = require('path');
      var dir = os.tmpdir(), now = Date.now(), cut = now - (maxAgeMs || 30 * 60 * 1000);
      var names = fs.readdirSync(dir), freed = 0, n = 0;
      for (var i = 0; i < names.length; i++) {
        if (names[i].indexOf('f2a_') !== 0) continue;
        if (!/\.(ffx|json|svg)$/i.test(names[i])) continue;
        var fp = path.join(dir, names[i]);
        try {
          var st = fs.statSync(fp);
          if (st.mtimeMs > cut) continue;              // leave the current run alone
          freed += st.size; fs.unlinkSync(fp); n++;
        } catch (e1) {}                                 // locked by AE -> skip it
      }
      if (n) return { files: n, mb: Math.round(freed / 1048576 * 10) / 10 };
    } catch (e) {}
    return null;
  }

  function esLiteral(value) {
    // ExtendScript has no JSON parser, so the host reads this with eval(). U+2028/U+2029 are
    // legal inside JSON strings but TERMINATE a JS string literal ("Unterminated string
    // constant" -> the whole text payload was lost). Escaping every non-ASCII char as \uXXXX
    // keeps both the payload and script arguments safe across CEP's encoding boundary.
    var NONASCII = new RegExp("[\\u0080-\\uFFFF]", "g");
    return JSON.stringify(value).replace(NONASCII, function (c) {
      return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
    });
  }
  function saveTextsTemp(texts) { return saveJsonTemp(texts, "texts"); }
  function saveJsonTemp(obj, tag) {
    var fs = require('fs'), os = require('os'), path = require('path');
    var p = path.join(os.tmpdir(), 'f2a_' + (tag || 'data') + '_' + Date.now() + '_' + (++tempSerial) + '.json');
    fs.writeFileSync(p, esLiteral(obj), 'utf8');
    return p;
  }

  function extPath() {
    var p = decodeURIComponent(window.__adobe_cep__.getSystemPath("extension"));
    return p.replace("file:///", "").replace("file://", "");
  }
  function evalES(script, cb) { window.__adobe_cep__.evalScript(script, cb || noop); }

  var ext = extPath();
  var host = (ext + "/host/figma").replace(/\\/g, "/");
  var lastImageFolder = "";       // remembered across imports and panel restarts
  try { lastImageFolder = localStorage.getItem("f2a.imageFolder") || ""; } catch (eLs) {}
  var folderSelecting = false;
  function rememberImageFolder(folder) {
    lastImageFolder = folder;
    if (folder) localStorage.setItem('f2a.imageFolder', folder);
    else localStorage.removeItem('f2a.imageFolder');
  }
  function getImageFolder() {
    if (lastImageFolder) {
      try { if (!require('fs').statSync(lastImageFolder).isDirectory()) rememberImageFolder(''); }
      catch (error) { rememberImageFolder(''); }
    }
    return lastImageFolder;
  }
  MKFigma.getImageFolder = getImageFolder;
  getImageFolder();

  // ---- gradient .ffx generation (Overlord-style: colours aren't scriptable, so we bake a preset) ----
  var SVGParserNode = null, ffxGen = null, GRAD_TEMPLATE = null, STROKE_TEMPLATE = null, OVERLAY_TEMPLATE = null;
  try {
    SVGParserNode = require(ext + "/host/figma/svgParser.js");
    ffxGen = require(ext + "/client/ffxGradient.js");
    GRAD_TEMPLATE = require('fs').readFileSync(ext + "/host/figma/grad-template.ffx");
    try { STROKE_TEMPLATE = require('fs').readFileSync(ext + "/host/figma/gradstroke-template.ffx"); } catch (est) {}
    try { OVERLAY_TEMPLATE = require('fs').readFileSync(ext + "/host/figma/gradoverlay-template.ffx"); } catch (eov) {}
  } catch (eg) { if (window.console) console.log("[svg-import] gradient preset gen unavailable: " + eg); }

  // Parse the SVG here (same parser AE uses -> identical shape order), generate one .ffx per
  // gradient shape, and return a { shapeIndex: ffxPath } map saved as a temp JSON file.
  function buildGradientMap(svg) {
    if (!SVGParserNode || !ffxGen || !GRAD_TEMPLATE) return null;
    var fs = require('fs'), os = require('os'), path = require('path');
    var model;
    try { model = SVGParserNode.parse(svg); } catch (e) { return null; }
    function genFfx(tpl, grad, tag, i) {
      genFfx.cache = genFfx.cache || {};
      var kind = (tpl === GRAD_TEMPLATE) ? 'fill' : ((tpl === STROKE_TEMPLATE) ? 'stroke' : 'overlay');
      var cacheKey = kind + '|' + (grad.type || '') + '|' + JSON.stringify(grad.stops || []);
      if (genFfx.cache[cacheKey] && fs.existsSync(genFfx.cache[cacheKey])) return genFfx.cache[cacheKey];
      var colorStops = [], alphaStops = [];
      for (var j = 0; j < grad.stops.length; j++) {
        var s = grad.stops[j];
        colorStops.push({ loc: s.offset, rgb: s.color });
        alphaStops.push({ loc: s.offset, a: (s.opacity == null ? 1 : s.opacity) });
      }
      var out = ffxGen.generate(tpl, { colorStops: colorStops, alphaStops: alphaStops });
      var p = path.join(os.tmpdir(), 'f2a_' + tag + '_' + i + '_' + Date.now() + '_' + (++tempSerial) + '.ffx');
      fs.writeFileSync(p, out);
      genFfx.cache[cacheKey] = p.replace(/\\/g, '/');
      return genFfx.cache[cacheKey];
    }

    var map = {}, count = 0;
    for (var i = 0; i < model.shapes.length; i++) {
      var entry = null;
      var gf = model.shapes[i].gradient;
      var gs = model.shapes[i].strokeGradient;
      if (gf && gf.stops && gf.stops.length >= 2) {
        try { entry = entry || {}; entry.fill = genFfx(GRAD_TEMPLATE, gf, 'gradfill', i); } catch (e2) { if (window.console) console.log("[svg-import] fill grad " + i + ": " + e2); }
      }
      if (gs && gs.stops && gs.stops.length >= 2 && STROKE_TEMPLATE) {
        try { entry = entry || {}; entry.stroke = genFfx(STROKE_TEMPLATE, gs, 'gradstroke', i); } catch (e3) { if (window.console) console.log("[svg-import] stroke grad " + i + ": " + e3); }
      }
      // extra paints (Figma allows several fills/strokes per layer) each need their own preset
      var eps = model.shapes[i].extraPaints;
      if (eps && eps.length) {
        for (var e = 0; e < eps.length; e++) {
          var ep = eps[e];
          if (!ep.gradient || !ep.gradient.stops || ep.gradient.stops.length < 2) continue;
          var tpl = (ep.kind === 'stroke') ? STROKE_TEMPLATE : GRAD_TEMPLATE;
          if (!tpl) continue;
          try {
            entry = entry || {};
            entry.extras = entry.extras || [];
            entry.extras.push({ i: e, kind: ep.kind, ffx: genFfx(tpl, ep.gradient, 'gradextra', i * 100 + e) });
          } catch (e4) { if (window.console) console.log("[svg-import] extra grad " + i + "/" + e + ": " + e4); }
        }
      }
      if (entry) { map[i] = entry; count++; }
    }
    if (!count) return { jsonPath: "", count: 0 };
    var jp = path.join(os.tmpdir(), 'f2a_gradmap_' + Date.now() + '_' + (++tempSerial) + '.json');
    fs.writeFileSync(jp, JSON.stringify(map), 'utf8');
    return { jsonPath: jp.replace(/\\/g, '/'), count: count };
  }
  // Node mode has its own numbering, so gradient presets must be baked from the NODE list.
  // Reusing the SVG-indexed map sent presets to the wrong layers and invalidated their
  // references ("Object is invalid"), which aborted the whole build.
  function buildGradientMapFromNodes(nodes) {
    if (!ffxGen || !GRAD_TEMPLATE || !nodes || !nodes.length) return { jsonPath: "", count: 0 };
    var fs = require('fs'), os = require('os'), path = require('path');
    var cache = {};                    // identical stops share one preset file per import
    function gen(tpl, g, tag, key) {
      var kind = (tpl === GRAD_TEMPLATE) ? 'fill' : ((tpl === STROKE_TEMPLATE) ? 'stroke' : 'overlay');
      var cacheKey = kind + '|' + (g.type || '') + '|' + JSON.stringify(g.stops || []);
      if (cache[cacheKey] && fs.existsSync(cache[cacheKey])) return cache[cacheKey];
      var cs = [], as = [];
      for (var j = 0; j < g.stops.length; j++) {
        var st = g.stops[j];
        cs.push({ loc: st.offset, rgb: st.color });
        as.push({ loc: st.offset, a: (st.opacity == null ? 1 : st.opacity) });
      }
      var out = ffxGen.generate(tpl, { colorStops: cs, alphaStops: as });
      var pth = path.join(os.tmpdir(), 'f2a_' + tag + '_' + key + '_' + Date.now() + '_' + (++tempSerial) + '.ffx');
      fs.writeFileSync(pth, out);
      cache[cacheKey] = pth.replace(/\\/g, '/');
      return cache[cacheKey];
    }

    var map = {}, count = 0;
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i], entry = null, k;
      // The preset index MUST line up with svgParser.fromNodes' extraPaints, which keeps every
      // non-image paint — solids included. Numbering only the gradients shifted every preset by
      // the number of solid paints below it: a layer with solid + linear + radial + radial got
      // the wrong ramp on one paint and no preset at all on the next, which fell back to a flat
      // colour. Count exactly the same paints the parser counts.
      var fillsNoImg = [], strokesNoImg = [];
      for (k = 0; k < nd.fills.length; k++) if (nd.fills[k].kind !== 'image') fillsNoImg.push(nd.fills[k]);
      for (k = 0; k < nd.strokes.length; k++) if (nd.strokes[k].kind !== 'image') strokesNoImg.push(nd.strokes[k]);

      var anyGrad = false;
      for (k = 0; k < fillsNoImg.length; k++) if (fillsNoImg[k].kind === 'grad') anyGrad = true;
      for (k = 0; k < strokesNoImg.length; k++) if (strokesNoImg[k].kind === 'grad') anyGrad = true;
      if (!anyGrad) continue;

      try {
        // the LAST fill is the one the layer shows; earlier ones become extras underneath
        var mainFill = fillsNoImg.length ? fillsNoImg[fillsNoImg.length - 1] : null;
        var mainStroke = strokesNoImg.length ? strokesNoImg[0] : null;
        if (mainFill && mainFill.kind === 'grad') { entry = entry || {}; entry.fill = gen(GRAD_TEMPLATE, mainFill, 'ndfill', i); }
        if (mainStroke && mainStroke.kind === 'grad' && STROKE_TEMPLATE) { entry = entry || {}; entry.stroke = gen(STROKE_TEMPLATE, mainStroke, 'ndstroke', i); }

        var extras = [];
        for (k = 0; k < fillsNoImg.length - 1; k++) {
          if (fillsNoImg[k].kind !== 'grad') continue;                 // solids need no preset
          extras.push({ i: k, kind: 'fill', ffx: gen(GRAD_TEMPLATE, fillsNoImg[k], 'ndxf', i * 100 + k) });
        }
        var base = Math.max(0, fillsNoImg.length - 1);                 // stroke extras follow the fill extras
        for (k = 1; k < strokesNoImg.length; k++) {
          if (strokesNoImg[k].kind !== 'grad' || !STROKE_TEMPLATE) continue;
          extras.push({ i: base + k - 1, kind: 'stroke', ffx: gen(STROKE_TEMPLATE, strokesNoImg[k], 'ndxs', i * 100 + k) });
        }
        if (extras.length) { entry = entry || {}; entry.extras = extras; }
      } catch (e) { if (window.console) console.log("[svg-import] node grad " + i + ": " + e); }

      if (entry) { map[i] = entry; count++; }
    }
    if (!count) return { jsonPath: "", count: 0 };
    var jp = path.join(os.tmpdir(), 'f2a_nodegrad_' + Date.now() + '_' + (++tempSerial) + '.json');
    fs.writeFileSync(jp, JSON.stringify(map), 'utf8');
    return { jsonPath: jp.replace(/\\/g, '/'), count: count };
  }

  var GRAD_READY = !!(SVGParserNode && ffxGen && GRAD_TEMPLATE);

  // 1) Load the SVG engine into the persistent ExtendScript engine, in dependency order.
  ['svgParser.js', 'aeShapeBuilder.jsx', 'figmaRunner.jsx'].forEach(function (file) {
    evalES('$.evalFile(new File(File.encode(' + esLiteral(host + '/' + file) + ')));');
  });

  // 2) Folder picker shared with the Figma plugin through the bridge routes
  function chooseImageFolder(cb, force) {
    if (folderSelecting) { cb(new Error('目录窗口已打开')); return; }
    var current = getImageFolder();
    if (current && !force) { cb(null, current); return; }
    folderSelecting = true;
    function selected(error, folder) {
      folderSelecting = false;
      if (!error && folder) {
        try {
          if (!require('fs').statSync(folder).isDirectory()) throw new Error('所选位置不是文件夹');
          rememberImageFolder(folder.replace(/\\/g, '/'));
        } catch (failure) { error = failure; }
      }
      cb(error, error || !folder ? null : lastImageFolder);
    }
    try {
      if (window.cep && window.cep.fs && window.cep.fs.showOpenDialogEx) {
        var result = window.cep.fs.showOpenDialogEx(false, true, '选择图片保存位置', current, []);
        if (result.err) throw new Error('目录窗口打开失败（' + result.err + '）');
        selected(null, result.data && result.data[0]);
      } else {
        evalES('mkChooseImageFolder("选择图片保存位置")', function (folder) {
          if (/^(ERROR:|EvalScript error)/i.test(folder || '')) selected(new Error(folder));
          else selected(null, String(folder || '').replace(/^\s+|\s+$/g, ''));
        });
      }
    } catch (error) { selected(error); }
  }
  MKFigma.selectImageFolder = function (cb) {
    if (importing || importQueue.length) { if (cb) cb(new Error('正在导入，请稍后选择')); return; }
    chooseImageFolder(function (error, folder) {
      if (error) flash('选择图片保存位置失败：' + error.message, true);
      if (cb) cb(error, folder);
    }, true);
  };

  // Receive complete jobs, then commit each in ONE evalScript call. No undo group is held
  // open while waiting for PNGs or a folder dialog; later imports cannot interleave phases.
  var importQueue = [], importing = false;
  function finishImport(message, failed) {
    flash(message, failed);
    var done = importQueue.shift();
    if (done && done.cleanGrades) done.cleanGrades();
    importing = false; pumpImport();
  }
  function submitImageImport(job, list, folder) {
    function submit() { submitImport(job, saveJsonTemp(list, 'images').replace(/\\/g, '/'), folder); }
    if (!list.some(function (im) { return !!im.imageFilters; })) { submit(); return; }
    var effect = require(ext + '/client/figmaImageGradeEffect.js');
    // Preferred: the native Figma 调色 effect on each element's outer precomp, with Figma's
    // values. AE has no scripting API to list installed effects, so probe the live host; only
    // then copy the packaged .aex into the AE plug-in folder and, as the last resort, build
    // the LUT grade that requires a separate Python/aerender-style import project.
    function useEffect() {
      var graded = 0;
      for (var i = 0; i < list.length; i++)
        if (list[i].imageFilters) { list[i].imageGradeEffect = true; graded++; }
      log("图片调色：使用 Figma 调色插件还原 " + graded + " 张图片");
      submit();
    }
    function useLut(status) {
      if (status && status.available && status.copied)
        log("已将 Figma 调色插件安装到 AE 插件目录，重启 AE 后生效；本次使用 LUT 降级调色");
      else if (status && status.available)
        log("Figma 调色插件已安装但当前 AE 尚未加载，重启 AE 后生效；本次使用 LUT 降级调色");
      else if (status && !status.available)
        log("Figma 调色插件不可用（" + (status.reason || '未安装') + "）；本次使用 LUT 降级调色");
      function prepare(duration, frameRate) {
        require(ext + '/client/figmaImageGrade.js').prepareImport(ext, list, folder, duration, frameRate, function (error, cleanup) {
          if (error) { finishImport('图片调色导入失败：' + error.message, true); return; }
          job.cleanGrades = cleanup;
          try { submit(); } catch (e) { finishImport('图片导入失败：' + e.message, true); }
        });
      }
      if (!job.data.compId) { prepare(job.data.compDuration || 10, job.data.compFrameRate || 30); return; }
      evalES('(function(){var c=app.project.itemByID(' + job.data.compId + ');return c.duration+","+c.frameRate;})()', function (value) {
        var timing = String(value).split(',');
        if (!(Number(timing[0]) > 0 && Number(timing[1]) > 0)) { finishImport('目标合成已关闭', true); return; }
        prepare(Number(timing[0]), Number(timing[1]));
      });
    }
    evalES(effect.PROBE_SCRIPT, function (probe) {
      if (effect.parseProbe(probe)) { useEffect(); return; }
      var version = effect.probeVersion(probe), status;
      if (version && version < effect.MIN_AE) {
        // This AE cannot load the plug-in at all; copying it would only mislead.
        status = {available: false, copied: false,
          reason: '当前 AE ' + version + ' 早于 AE CC 2019，不支持 Figma 调色插件'};
      } else {
        try { status = effect.install(ext); } catch (e) { status = {available: false, copied: false, reason: e.message}; }
      }
      useLut(status);
    });
  }
  function submitImport(job, imagesPath, folder) {
    var data = job.data;
    data.imagesPath = imagesPath || ''; data.imageFolder = folder || '';
    job.images = null;
    var file = saveJsonTemp(data, 'batch').replace(/\\/g, '/');
    flash('正在导入 AE…');
    evalES('runImportBatch(' + esLiteral(file) + ')', function (res) {
      finishImport('AE: ' + res, /error/i.test(res));
    });
  }
  function reserveImageFilename(base, extension, used, suffix) {
    var file = base + '.' + extension;
    while (used[file.toLowerCase()]) file = base + '_' + (suffix++) + '.' + extension;
    used[file.toLowerCase()] = true;
    return file;
  }
  function pumpImport() {
    if (importing || !importQueue.length || !importQueue[0].ready || !importQueue[0].targetReady) return;
    importing = true;
    var job = importQueue[0], images = job.images || [];
    if (!job.data.compSize && !job.data.compId) { finishImport('请先打开一个合成', true); return; }
    if (!job.shadowsReady && images.some(function (image) { return !!image.shadowBase; })) {
      job.shadowsReady = true;
      var renderer = require(ext + '/client/figmaRasterEffects.js'), pending = Promise.resolve();
      var shadowed = images.filter(function (image) { return !!image.shadowBase; }).length;
      log("正在合成 " + shadowed + " 张投影图片…");
      images.forEach(function (image) {
        if (image.shadowBase) pending = pending.then(function () {
          return renderer.renderShadow(image.data, image.shadowBase, document, window.Image).then(function (data) {
            image.data = data; image.shadowBase = null;
          });
        });
      });
      pending.then(function () { importing = false; pumpImport(); }, function (error) { finishImport('投影图片处理失败：' + error.message, true); });
      return;
    }
    if (!images.length) {
      try { submitImport(job); } catch (e) { finishImport('导入失败：' + e.message, true); }
      return;
    }
    flash(lastImageFolder ? '正在保存图片…' : '请选择图片保存文件夹…');
    chooseImageFolder(function (error, folder) {
      if (error) { finishImport('选择图片保存位置失败：' + error.message, true); return; }
      try {
        folder = (folder || '').replace(/^\s+|\s+$/g, '');
        if (!folder) { finishImport('已取消导入', true); return; }
        rememberImageFolder(folder);
        var fs2 = require('fs'), path2 = require('path'), list = [], used = Object.create(null);
        var aeFilename = require(host + '/aeFilename.js');
        for (var k = 0; k < images.length; k++) {
          var im = images[k], base = aeFilename(im.name, 'image');
          var extension = String(im.ext || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
          var fname = reserveImageFilename(base, extension, used, k);
          var buf = Buffer.from(im.data, 'base64'), target = path2.join(folder, fname), needWrite = true;
          try {
            if (fs2.existsSync(target)) { var cur = fs2.readFileSync(target); if (cur.length === buf.length && cur.equals(buf)) needWrite = false; }
          } catch (eCompare) {}
          if (needWrite) {
            try { fs2.writeFileSync(target, buf); }
            catch (eLocked) {
              fname = reserveImageFilename(base + '_' + Date.now() + '_' + (++tempSerial), extension, used, k);
              fs2.writeFileSync(path2.join(folder, fname), buf);
            }
          }
          list.push({ file: fname, name: im.name, x: im.x, y: im.y, w: im.w, h: im.h,
                      natW: im.natW, natH: im.natH, scaleMode: im.scaleMode, rasterScale: im.rasterScale || null,
                      imageMatrix: im.imageMatrix || null, maskSource: im.maskSource || null, maskType: im.maskType || null,
                      imageFilters: im.imageFilters || null,
                      opacity: im.opacity, rotation: im.rotation, matte: im.matte, blend: im.blend,
                      path: im.path, z: im.z, maskId: im.maskId || null,
                      cx: im.cx, cy: im.cy, cw: im.cw, ch: im.ch, hidden: !!im.hidden, reference: !!im.reference, shadow: !!im.shadow, mergedBlend: !!im.mergedBlend, external: !!im.external });
        }
        submitImageImport(job, list, lastImageFolder);
        log("已保存 " + list.length + " 张图片 → " + folder, "ok");
      } catch (e) {
        rememberImageFolder('');
        finishImport('图片保存失败：' + (/ENOSPC/i.test(e.message) ? '磁盘空间已满' : e.message), true);
      }
    });
  }

  // 3) Start the localhost bridge (Figma plugin connects here)
  try {
    var bridge = require(ext + "/client/mkBridgeServer.js");
    bridge.start({
      port: PORT,
      onGetImageFolder: getImageFolder,
      onChooseImageFolder: MKFigma.selectImageFolder,
      onStartAep: function (callback) { log("Figma 请求启动 AEP 导出组件…"); require(ext + '/client/aepLauncher.js').start(callback); },
      onStatus: function (s) {
        if (/listening/.test(s)) { setConn(true); return; }
        // A stale panel context can still hold the port; say so instead of waiting forever.
        if (/^error:/.test(s)) {
          var reason = /EADDRINUSE/.test(s) ? '端口 ' + PORT + ' 已被占用，请关闭重复的 F2A 面板或重启 AE' : s.replace(/^error:\s*/, '');
          setBase('桥接服务启动失败：' + reason);
          log('桥接服务启动失败：' + reason, 'err');
        }
      },
      onSvg: function (svg, meta) {
        var swept = sweepTemp();                  // reclaim earlier runs before writing new files
        // Multi-region vectors (a cursor with a white body and black outline) only render right
        // when they are split per region — this says whether that happened and, if not, why.
        if (meta.vnStats && meta.vnStats.multi) {
          var vs = meta.vnStats;
          flash("矢量区域：" + vs.multi + " 个多区域，网络 " + vs.net + "，拆分 " + vs.split +
                "，同填充 " + vs.same + "，数量不匹配 " + vs.mismatch);
        }
        var p = bridge.saveTemp(svg, meta.name);
        var arg = p.replace(/\\/g, "/");
        log("收到「" + (meta.name || "未命名") + "」：" + (meta.imageCount || 0) + " 张图片待导出");
        flash("已接收 Figma 数据，正在构建…" + (swept ? "（已清理 " + swept.mb + " MB，共 " + swept.files + " 个临时文件）" : ""));
        // Gradient TEXT fill -> bake a Gradient Overlay layer-style .ffx per text node.
        // (Gradient Ramp paints the whole layer rect; the layer style respects glyph alpha.)
        try {
          if (GRAD_TEMPLATE && ffxGen && meta.texts) {
            var fsx = require('fs'), osx = require('os'), pathx = require('path');
            for (var ti = 0; ti < meta.texts.length; ti++) {
              var tg = meta.texts[ti] && meta.texts[ti].grad;
              if (!tg || !tg.stops || tg.stops.length < 2) continue;
              var cs = [], as = [];
              for (var si = 0; si < tg.stops.length; si++) {
                var st = tg.stops[si];
                cs.push({ loc: st.offset, rgb: st.color });
                as.push({ loc: st.offset, a: (st.opacity == null ? 1 : st.opacity) });
              }
              var ob = ffxGen.generate(GRAD_TEMPLATE, { colorStops: cs, alphaStops: as });
              var op2 = pathx.join(osx.tmpdir(), 'f2a_gradtext_' + ti + '_' + Date.now() + '_' + (++tempSerial) + '.ffx');
              fsx.writeFileSync(op2, ob);
              meta.texts[ti].gradFfx = op2.replace(/\\/g, '/');
            }
          }
        } catch (egt) {
          // This used to be swallowed. A failed .ffx write (a full disk, most often) meant the
          // text gradient silently vanished with no hint as to why — say it out loud instead.
          flash("文字渐变生成失败：" + (egt && egt.message ? egt.message : egt), true);
          if (window.console) console.log("[svg-import] text gradient: " + egt);
        }
        var tp = (meta.texts && meta.texts.length) ? saveTextsTemp(meta.texts).replace(/\\/g, "/") : "";
        var ep = (meta.effects && meta.effects.length) ? saveJsonTemp(meta.effects, "effects").replace(/\\/g, "/") : "";
        var gp = "", gc = 0;
        if (!GRAD_READY) { flash("渐变生成已停用（面板是否未更新？）", true); }
        try {
          var gm = (meta.nodes && meta.nodes.length) ? buildGradientMapFromNodes(meta.nodes) : buildGradientMap(svg);
          if (gm) { gp = gm.jsonPath; gc = gm.count; }
        } catch (eg2) { if (window.console) console.log(eg2); }
        flash("正在构建…（" + gc + " 个渐变 .ffx）");
        // one entry point handles shapes + text + gradient presets + effects
        var np = (meta.nodes ? saveJsonTemp(meta.nodes, 'nodes').replace(/\\/g, '/') : "");
        if (np) flash("可编辑模式：从 Figma 图层树导入 " + meta.nodes.length + " 个图层");
        var shx = (meta.shift && meta.shift.x) ? meta.shift.x : 0;
        var shy = (meta.shift && meta.shift.y) ? meta.shift.y : 0;
        var cp = (meta.organize && meta.containers && meta.containers.length)
                   ? saveJsonTemp(meta.containers, 'containers').replace(/\\/g, '/') : "";
        if (cp) flash("分组预合成：" + meta.containers.length + " 个组");
        var job = { data: {name: meta.name || '', svgPath: arg, textsPath: tp, gradMapPath: gp, effectsPath: ep,
                           shiftX: shx, shiftY: shy, nodesPath: np, containersPath: cp},
                    ready: !meta.imageCount, expectedImages: meta.imageCount || 0, targetReady: false, images: null };
        importQueue.push(job);
        // Bind the target before the PNG wait or folder dialog can change the active viewer.
        evalES('mkFigmaTargetCompId()', function (id) {
          var compId = parseInt(id, 10);
          if (compId > 0) job.data.compId = compId;
          else if (compId === 0) {
            job.data.compSize = meta.compSize;
            if (meta.compDuration > 0) job.data.compDuration = meta.compDuration;
            if (meta.compFrameRate >= 1) job.data.compFrameRate = meta.compFrameRate;
          }
          job.targetReady = true; pumpImport();
        });
        if (meta.imageCount) flash('等待图片导出完成…');
        pumpImport();
        return { ok: true, queued: true, name: meta.name };
      },
      // Pictures arrive after the SVG, one message each. Ask where to keep them (AE links to
      // footage on disk, it never embeds), write the files, then import them with their mattes.
      onAbort: function (message) {
        for (var i = 0; i < importQueue.length; i++) {
          if (importQueue[i].ready) continue;
          importQueue.splice(i, 1); flash(message, true); pumpImport(); return;
        }
      },
      onImages: function (images) {
        for (var i = 0; i < importQueue.length; i++) {
          if (importQueue[i].ready) continue;
          if (images.length !== importQueue[i].expectedImages) {
            importQueue.splice(i, 1); flash('图片数据不完整，已取消导入', true); pumpImport();
            return {ok: false, error: '图片数据不完整'};
          }
          importQueue[i].images = images; importQueue[i].ready = true;
          pumpImport();
          return { ok: true, images: images.length };
        }
        return { ok: false, error: '没有等待图片的导入任务' };
      }
    });
  } catch (e) {
    setBase("桥接服务启动失败：" + (e && e.message ? e.message : e));
  }
})();
