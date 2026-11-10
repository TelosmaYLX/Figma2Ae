/* ===== SaaS Kit — SVG Import module (client side) =====
 * Runs in the panel. Starts the localhost WebSocket bridge, loads the SVG->shapes
 * ExtendScript engine into the persistent AE engine, and forwards incoming SVG to
 * runSvgToShapes(). Exposes window.MKFigma for main.js buttons. Requires Node in-panel
 * (--enable-nodejs + --mixed-context). Degrades to a preview no-op in a plain browser.
 */
(function () {
  "use strict";
  var PORT = 7867;
  var CEP = (typeof window.__adobe_cep__ !== "undefined");
  var MKFigma = window.MKFigma = { connected: false, manualImport: noop };

  var baseStatus = "正在启动 SVG 桥接…";   // persistent line the bar returns to
  var revertTimer = null;

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
    if (window.MKToast) window.MKToast(text, isErr);
    if (window.console) console.log("[svg-import] " + text);
    if (revertTimer) clearTimeout(revertTimer);
    revertTimer = setTimeout(function () { paint(baseStatus); }, 3500);
  }
  function setConn(on) { MKFigma.connected = on; setBase(on ? "桥接服务运行中 · 端口 :" + PORT : "桥接服务已离线。请重新打开面板"); }

  if (!CEP) {
    MKFigma.manualImport = function () { flash("[预览] SVG 导入需要在 AE 中运行"); };
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
        if (names[i].indexOf('saaskit_') !== 0) continue;
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

  function saveTextsTemp(texts) { return saveJsonTemp(texts, "texts"); }
  function saveJsonTemp(obj, tag) {
    var fs = require('fs'), os = require('os'), path = require('path');
    var p = path.join(os.tmpdir(), 'saaskit_' + (tag || 'data') + '_' + Date.now() + '.json');
    // ExtendScript has no JSON parser, so the host reads this with eval(). U+2028/U+2029 are
    // legal inside JSON strings but TERMINATE a JS string literal ("Unterminated string
    // constant" -> the whole text payload was lost). Escaping every non-ASCII char as \uXXXX
    // keeps the file pure ASCII and eval-safe, and preserves the characters exactly.
    var NONASCII = new RegExp("[\\u0080-\\uFFFF]", "g");
    var json = JSON.stringify(obj).replace(NONASCII, function (c) {
      return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
    });
    fs.writeFileSync(p, json, 'utf8');
    return p;
  }

  function extPath() {
    var p = decodeURIComponent(window.__adobe_cep__.getSystemPath("extension"));
    return p.replace("file:///", "").replace("file://", "");
  }
  function evalES(script, cb) { window.__adobe_cep__.evalScript(script, cb || noop); }

  var ext = extPath();
  var host = (ext + "/host/figma").replace(/\\/g, "/");
  var lastImageFolder = "";       // reuse for the whole panel session; reset when AE/panel reloads

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
      var p = path.join(os.tmpdir(), 'saaskit_' + tag + '_' + i + '_' + Date.now() + '.ffx');
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
    var jp = path.join(os.tmpdir(), 'saaskit_gradmap_' + Date.now() + '.json');
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
      var pth = path.join(os.tmpdir(), 'saaskit_' + tag + '_' + key + '_' + Date.now() + '.ffx');
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
    var jp = path.join(os.tmpdir(), 'saaskit_nodegrad_' + Date.now() + '.json');
    fs.writeFileSync(jp, JSON.stringify(map), 'utf8');
    return { jsonPath: jp.replace(/\\/g, '/'), count: count };
  }

  var GRAD_READY = !!(SVGParserNode && ffxGen && GRAD_TEMPLATE);

  // 1) Load the SVG engine into the persistent ExtendScript engine, in dependency order.
  evalES('$.evalFile("' + host + '/svgParser.js");');
  evalES('$.evalFile("' + host + '/aeShapeBuilder.jsx");');
  evalES('$.evalFile("' + host + '/figmaRunner.jsx"); "loaded";', function () {});

  // 2) Manual import button (pick a local .svg)
  MKFigma.manualImport = function () {
    flash("请选择 SVG 文件…");
    evalES("figmaImportDialog();", function (res) {
      if (res === "Cancelled.") flash("已取消导入");
      else flash("AE: " + res, /error/i.test(res));
    });
  };

  // Choose once per panel session. Windows uses the modern Explorer-style folder picker;
  // other platforms (or a PowerShell failure) keep AE's native folder dialog as fallback.
  function chooseImageFolder(images, cb) {
    if (lastImageFolder) { cb(lastImageFolder); return; }
    var hint = "将 " + images.length + " 张 Figma 图片保存到…";
    function fallback() { evalES('mkChooseImageFolder("' + hint + '")', cb); }
    if (process.platform === 'win32') {
      var ps = [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -AssemblyName System.Windows.Forms",
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
        "$d.Description = '选择 Figma 图片保存文件夹'",
        "$d.ShowNewFolderButton = $true",
        "try { $d.AutoUpgradeEnabled = $true } catch {}",
        "try { $d.UseDescriptionForTitle = $true } catch {}",
        "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
        "  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false",
        "  [Console]::Write($d.SelectedPath)",
        "}"
      ].join("\r\n");
      try {
        var encoded = Buffer.from(ps, 'utf16le').toString('base64');
        require('child_process').execFile('powershell.exe',
          ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
          { encoding: 'utf8', windowsHide: false },
          function (err, stdout) {
            if (err) { fallback(); return; }
            cb(String(stdout || '').replace(/^\s+|\s+$/g, ''));
          });
      } catch (e) { fallback(); }
      return;
    }
    fallback();
  }

  // 3) Start the localhost bridge (Figma plugin connects here)
  try {
    var bridge = require(ext + "/client/mkBridgeServer.js");
    bridge.start({
      port: PORT,
      onStatus: function (s) { if (/listening/.test(s)) setConn(true); },
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
              var op2 = pathx.join(osx.tmpdir(), 'saaskit_gradtext_' + ti + '_' + Date.now() + '.ffx');
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
        var np = (meta.nodes && meta.nodes.length) ? saveJsonTemp(meta.nodes, 'nodes').replace(/\\/g, '/') : "";
        if (np) flash("可编辑模式：从 Figma 图层树导入 " + meta.nodes.length + " 个图层");
        var shx = (meta.shift && meta.shift.x) ? meta.shift.x : 0;
        var shy = (meta.shift && meta.shift.y) ? meta.shift.y : 0;
        var cp = (meta.organize && meta.containers && meta.containers.length)
                   ? saveJsonTemp(meta.containers, 'containers').replace(/\\/g, '/') : "";
        if (cp) flash("分组预合成：" + meta.containers.length + " 个组");
        else if (meta.organize) flash("没有嵌套组，将使用当前合成");
        // runOrganize also finalizes flat imports: it restacks late text/images when there are
        // no containers, so the z-order does not depend on whether precomps were requested.
        evalES('runImport("' + arg + '","' + tp + '","' + gp + '","' + ep + '",' + shx + ',' + shy + ',"' + np + '","' + cp + '")',
               function (res) {
                 flash("AE: " + res, /error/i.test(res));
                 // Collapse into precomps only once EVERYTHING is in the comp. With pictures on
                 // the way that is the images pass, which fires later; without them, right now.
                 if (!meta.imageCount) {
                   evalES('runOrganize()', function (ro) { flash("分组预合成：" + ro, /error/i.test(ro)); });
                 }
               });
        return { ok: true, queued: true, name: meta.name };
      },
      // Pictures arrive after the SVG, one message each. Ask where to keep them (AE links to
      // footage on disk, it never embeds), write the files, then import them with their mattes.
      onImages: function (images) {
        flash(lastImageFolder
          ? "收到 " + images.length + " 张图片，复用保存文件夹：" + lastImageFolder
          : "收到 " + images.length + " 张图片。请选择保存文件夹…");
        // A remembered folder returns immediately; otherwise Windows shows the Explorer picker
        // once and every later import in this panel session reuses the same directory.
        chooseImageFolder(images, function (folder) {
          folder = (folder || "").replace(/^\s+|\s+$/g, "");
          if (!folder) {
            flash("未选择文件夹，已跳过图片");
            // organize still has to run, or a cancelled picker would leave the scene uncollapsed
            evalES('runOrganize()', function (ro) { if (ro && ro !== "no groups") flash("分组预合成：" + ro, /error/i.test(ro)); });
            return;
          }
          lastImageFolder = folder.replace(/\\/g, '/');
          try {
            var fs2 = require('fs'), path2 = require('path');
            var list = [], used = {};
            for (var k = 0; k < images.length; k++) {
              var im = images[k];
              var base = (im.name || 'image'), ext = (im.ext || 'png');
              var fname = base + '.' + ext;
              if (used[fname]) fname = base + '_' + k + '.' + ext;                 // keep names unique
              used[fname] = 1;

              // Re-importing into the SAME folder used to fail silently: After Effects keeps a
              // handle on footage it already imported, so overwriting that file is refused by
              // Windows. Skip the write when the file is already byte-identical, and fall back
              // to a fresh name if the write is blocked.
              var buf = Buffer.from(im.data, 'base64');
              var target = path2.join(folder, fname), needWrite = true;
              try {
                if (fs2.existsSync(target)) {
                  var cur = fs2.readFileSync(target);
                  if (cur.length === buf.length && cur.equals(buf)) needWrite = false;
                }
              } catch (eCmp) {}
              if (needWrite) {
                try {
                  fs2.writeFileSync(target, buf);
                } catch (eLocked) {
                  fname = base + '_' + Date.now() + '.' + ext;
                  target = path2.join(folder, fname);
                  fs2.writeFileSync(target, buf);
                }
              }
              list.push({ file: fname, name: im.name, x: im.x, y: im.y, w: im.w, h: im.h,
                          natW: im.natW, natH: im.natH, scaleMode: im.scaleMode,
                          // z MUST travel with the picture: the final restack sorts by it, and a
                          // missing value read as 0 sank every photo to the bottom of the comp,
                          // behind the frame background — the image looked like it never imported.
                          opacity: im.opacity, rotation: im.rotation, matte: im.matte, blend: im.blend,
                          path: im.path, z: im.z,
                          cx: im.cx, cy: im.cy, cw: im.cw, ch: im.ch, hidden: !!im.hidden });
            }
            flash("已将 " + list.length + " 个文件保存到 " + folder);
            var ip = saveJsonTemp(list, 'images').replace(/\\/g, '/');
            evalES('runImportImages("' + ip + '","' + folder.replace(/\\/g, '/') + '")',
                   function (r2) {
                     flash("AE: " + r2, /error/i.test(r2));
                     // everything is in the comp now -> safe to collapse the groups
                     evalES('runOrganize()', function (ro) {
                       if (ro && ro !== "no groups") flash("分组预合成：" + ro, /error/i.test(ro));
                     });
                   });
          } catch (ei) {
            lastImageFolder = "";             // folder vanished/unwritable: ask again next time
            var msg = (ei && ei.message ? ei.message : String(ei));
            if (/ENOSPC/i.test(msg)) msg = "磁盘空间已满。请释放空间后重新导入" +
                                           "（After Effects 的磁盘缓存通常是主要原因）";
            flash("图片保存失败：" + msg, true);
          }
        });
        return { ok: true, images: images.length };
      }
    });
  } catch (e) {
    setBase("桥接服务启动失败：" + (e && e.message ? e.message : e));
  }
})();
