/* ===== f2a — visual motion library & local template browser (CEP panel) =====
 * Runs in AE's CEP panel (Node.js + ExtendScript) and degrades gracefully in browser preview.
 * Shares %LOCALAPPDATA%\F2A\motion-library with F2A MCP tools (ae_motion_*).
 */
(function () {
  "use strict";

  var CEP = typeof window.__adobe_cep__ !== "undefined";
  var HAS_NODE = typeof require === "function";

  var fs = HAS_NODE ? require("fs") : null;
  var path = HAS_NODE ? require("path") : null;
  var os = HAS_NODE ? require("os") : null;

  var extDir = "";
  if (CEP) {
    extDir = decodeURIComponent(window.__adobe_cep__.getSystemPath("extension"))
      .replace(/^file:\/\/\//, "").replace(/^file:\/\//, "");
  } else if (HAS_NODE && typeof __dirname === "string") {
    extDir = path.resolve(__dirname, "..");
  }

  var Preview = window.F2AMotionPreview;
  if (!Preview && HAS_NODE) {
    try {
      Preview = require(extDir ? path.join(extDir, "client", "motionPreview.js") : "./motionPreview.js");
    } catch (ePrev) {}
  }

  var scanner = null;
  if (HAS_NODE) {
    try {
      scanner = require(extDir ? path.join(extDir, "client", "templateScanner.js") : "./templateScanner.js");
    } catch (eScan) {
      if (window.console) console.log("[f2a-motion] scanner unavailable: " + eScan);
    }
  }

  var tempSerial = 0;
  function log(text, tone) {
    if (window.MKLog) window.MKLog(text, tone);
  }
  function report(text, isErr) {
    if (window.MKReport) window.MKReport(text, isErr);
  }
  function esLiteral(value) {
    var NONASCII = new RegExp("[\\u0080-\\uFFFF]", "g");
    return JSON.stringify(value).replace(NONASCII, function (c) {
      return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
    });
  }
  function writeJobTemp(obj, tag) {
    var p = path.join(os.tmpdir(), "f2a_motion_" + (tag || "job") + "_" + Date.now() + "_" + (++tempSerial) + ".json");
    fs.writeFileSync(p, esLiteral(obj), "utf8");
    return p.replace(/\\/g, "/");
  }
  function evalES(script, cb) {
    if (!CEP) {
      if (cb) cb(JSON.stringify({ ok: false, error: "当前为预览模式，请在 After Effects 中打开 F2A 面板调用。" }));
      return;
    }
    window.__adobe_cep__.evalScript(script, function (res) {
      if (cb) cb(res);
    });
  }
  function parseEsJson(raw) {
    if (!raw || raw === "EvalScript error.") return { ok: false, error: "AE 脚本执行异常，请重试或重启面板。" };
    try { return JSON.parse(raw); }
    catch (e) { return { ok: false, error: String(raw) }; }
  }
  function fileUrl(filePath) {
    if (!filePath) return "";
    var normalized = String(filePath).replace(/\\/g, "/");
    if (!/^[a-zA-Z]:/.test(normalized) && normalized[0] !== "/") normalized = "/" + normalized;
    return "file:///" + encodeURI(normalized).replace(/#/g, "%23").replace(/\?/g, "%3F");
  }

  function formatMediaDuration(sec) {
    if (!isFinite(sec) || sec <= 0) return "";
    var total = Math.round(sec);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  // A pack or video asset without a still image previews its first video frame as the card thumbnail.
  function addVideoThumbnail(stageEl, url, onDuration) {
    var vid = document.createElement("video");
    vid.className = "f2m-thumb-video";
    vid.muted = true;
    vid.playsInline = true;
    vid.preload = "metadata";
    vid.src = url;
    vid.addEventListener("loadedmetadata", function () {
      if (onDuration && isFinite(vid.duration) && vid.duration > 0) onDuration(vid.duration);
      try { if (!vid.currentTime) vid.currentTime = Math.min(0.04, vid.duration ? vid.duration * 0.05 : 0.04); } catch (e) {}
    });
    stageEl.insertBefore(vid, stageEl.firstChild);
    return vid;
  }

  // Only one audio card auditions at a time.
  var activeAudioPreview = null;
  function stopActiveAudioPreview() {
    if (!activeAudioPreview) return;
    try { activeAudioPreview.audio.pause(); } catch (e) {}
    if (activeAudioPreview.stage) activeAudioPreview.stage.classList.remove("is-playing");
    if (activeAudioPreview.fill) activeAudioPreview.fill.style.width = "0%";
    activeAudioPreview = null;
  }

  // ---- Load standalone ExtendScript motion engine into AE ----
  if (CEP && extDir) {
    var motionHost = (extDir + "/host/motion").replace(/\\/g, "/");
    ["motionEngine.jsx", "aeMotionPresets.jsx"].forEach(function (file) {
      evalES("$.evalFile(new File(File.encode(" + esLiteral(motionHost + "/" + file) + ")));");
    });
  }

  // ---- Persistent panel state ----
  var LS_DIRS = "f2a.motionTemplateDirs";
  var LS_PARAMS = "f2a.motionParams";
  var LS_COLLAPSED = "f2a.motionCollapsed";
  var LS_FAVORITES = "f2a.motionFavorites";

  function loadStoredCollapsed() {
    try { return localStorage.getItem(LS_COLLAPSED) === "1"; } catch (e) { return false; }
  }
  function saveStoredCollapsed(collapsed) {
    try { localStorage.setItem(LS_COLLAPSED, collapsed ? "1" : "0"); } catch (e) {}
  }

  function loadStoredDirs() {
    try {
      var raw = localStorage.getItem(LS_DIRS);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(function (s) { return typeof s === "string" && s.trim(); }) : [];
    } catch (e) { return []; }
  }
  function saveStoredDirs(dirs) {
    try { localStorage.setItem(LS_DIRS, JSON.stringify(dirs)); } catch (e) {}
  }
  function loadStoredParams() {
    var def = { speed: 1, direction: "up", style: "snappy", anchor: "auto", replace: true };
    try {
      var raw = localStorage.getItem(LS_PARAMS);
      return raw ? Object.assign(def, JSON.parse(raw)) : def;
    } catch (e) { return def; }
  }
  function saveStoredParams(p) {
    try { localStorage.setItem(LS_PARAMS, JSON.stringify(p)); } catch (e) {}
  }
  // Favourites survive restarts as a plain key list. Keys are namespaced per source so a
  // built-in clip, a saved clip and a template can never collide.
  function loadStoredFavorites() {
    try {
      var raw = localStorage.getItem(LS_FAVORITES);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(function (s) { return typeof s === "string" && s; }) : [];
    } catch (e) { return []; }
  }
  function saveStoredFavorites(list) {
    try { localStorage.setItem(LS_FAVORITES, JSON.stringify(list)); } catch (e) {}
  }
  function favoriteKey(item) {
    if (!item) return "";
    if (item.source === "user") return "user:" + item.id;
    if (item.file) return "template:" + item.file;
    return "motion:" + (item.id || item.name || "");
  }
  function isFavorite(item) {
    return state.favorites.indexOf(favoriteKey(item)) >= 0;
  }

  var state = {
    tab: "builtin",            // "builtin" | "templates" | "user"
    category: "全部",
    query: "",
    autoPlayAll: false,        // Off by default: cards stay still until hovered (or the play toggle is used)
    collapsed: loadStoredCollapsed(), // Fold the whole motion library down to its header strip
    showParams: false,
    params: loadStoredParams(),
    builtinPresets: [],
    builtinClips: [],
    userClips: [],
    templateDirs: loadStoredDirs(),
    templates: [],
    templateDirFilter: null,
    currentSubDir: "",
    templatePageLimit: 48,
    saveFormOpen: false,
    dirInputOpen: false,
    confirmDeleteId: null,
    renameId: null,
    favorites: loadStoredFavorites()
  };

  // ---- Load built-in catalog ----
  function loadBuiltinCatalog(done) {
    if (HAS_NODE && fs && extDir) {
      try {
        var fp = path.join(extDir, "motion-library", "builtin.json");
        if (fs.existsSync(fp)) {
          var parsed = JSON.parse(fs.readFileSync(fp, "utf8").replace(/^\uFEFF/, ""));
          state.builtinPresets = Array.isArray(parsed.presets) ? parsed.presets : [];
          state.builtinClips = Array.isArray(parsed.clips) ? parsed.clips : [];
          if (done) done();
          return;
        }
      } catch (e) {
        log("加载内置动效库失败：" + e.message, "err");
      }
    }
    // Browser preview fallback: fetch relative JSON
    if (typeof fetch === "function") {
      fetch("../motion-library/builtin.json")
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (parsed) {
          if (parsed) {
            state.builtinPresets = Array.isArray(parsed.presets) ? parsed.presets : [];
            state.builtinClips = Array.isArray(parsed.clips) ? parsed.clips : [];
          }
          if (done) done();
        })
        .catch(function () { if (done) done(); });
    } else if (done) {
      done();
    }
  }

  function refreshUserClips() {
    if (!scanner) { state.userClips = []; return; }
    try { state.userClips = scanner.listUserClips(); }
    catch (e) { state.userClips = []; }
  }

  function rescanTemplates() {
    if (!scanner) { state.templates = []; return; }
    var all = [];
    for (var i = 0; i < state.templateDirs.length; i++) {
      try {
        var list = scanner.scanTemplateDirectory(state.templateDirs[i]);
        var rootLabel = path ? path.basename(state.templateDirs[i]) : state.templateDirs[i];
        for (var j = 0; j < list.length; j++) {
          list[j].rootDir = state.templateDirs[i];
          list[j].rootLabel = rootLabel;
          all.push(list[j]);
        }
      } catch (e) {
        log("扫描本地目录失败：" + e.message, "err");
      }
    }
    state.templates = all;
    if (state.templateDirFilter && state.templateDirs.indexOf(state.templateDirFilter) < 0) {
      state.templateDirFilter = null;
      state.currentSubDir = "";
    }
    if (state.currentSubDir) {
      var cur = state.currentSubDir, pref = cur + "/";
      var stillExists = folderFilteredTemplates().some(function (it) {
        var r = String(it.relDir || "");
        return r === cur || r.indexOf(pref) === 0;
      });
      if (!stillExists) state.currentSubDir = "";
    }
    state.templatePageLimit = 48;
  }

  // ---- Live 60fps preview animation loop (only visible or hovered stages run) ----
  var activeLoops = new Map(); // stageEl -> { item, meta, startTs, duration }
  var visibleStages = new Set();
  var stageObserver = null;
  var rafId = 0;

  function getStageObserver() {
    if (stageObserver || typeof IntersectionObserver === "undefined") return stageObserver;
    var scrollRoot = document.querySelector(".f2m-scroll") || null;
    stageObserver = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var stage = entries[i].target;
        if (entries[i].isIntersecting) {
          visibleStages.add(stage);
          if (state.autoPlayAll && stage._f2mItem && !activeLoops.has(stage)) {
            startStageLoop(stage, stage._f2mItem, stage._f2mMeta);
          }
        } else {
          visibleStages.delete(stage);
          if (!stage._f2mHovered && activeLoops.has(stage)) {
            stopStageLoop(stage, stage._f2mItem);
          }
        }
      }
    }, { root: scrollRoot, rootMargin: "40px" });
    return stageObserver;
  }

  function applyBoxVisual(stageEl, res) {
    var box = stageEl.querySelector(".f2m-demo-box");
    if (!box) return;
    box.style.transform =
      "translate3d(" + res.dx.toFixed(2) + "px," + res.dy.toFixed(2) + "px,0) " +
      "rotate(" + res.rotate.toFixed(2) + "deg) " +
      "scale(" + res.scaleX.toFixed(3) + "," + res.scaleY.toFixed(3) + ")";
    box.style.opacity = String(res.opacity.toFixed(3));
  }

  function applyTextVisual(stageEl, chars) {
    var nodes = stageEl.querySelectorAll(".f2m-demo-char");
    for (var i = 0; i < nodes.length && i < chars.length; i++) {
      var c = chars[i];
      nodes[i].style.transform = "translate3d(" + c.dx.toFixed(1) + "px," + c.dy.toFixed(1) + "px,0) scale(" + c.scale.toFixed(3) + ")";
      nodes[i].style.opacity = String(c.opacity.toFixed(3));
      nodes[i].style.filter = c.blur > 0.1 ? ("blur(" + c.blur.toFixed(1) + "px)") : "none";
    }
  }

  function applyTransitionVisual(stageEl, res) {
    var u = Math.max(0, Math.min(1, res.progress));
    function smooth(t) { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); }
    if (res.transType === "iris") {
      var ring = stageEl.querySelector(".f2m-trans-iris");
      if (!ring) return;
      // AE: a filled disc grows to the frame's far-corner radius at the cut, then the stroke thins to open a hole.
      var grow = Math.min(1, u / 0.5);
      var hole = u <= 0.5 ? 0 : Math.min(1, (u - 0.5) / 0.5);
      ring.style.transform = "scale(" + Math.max(0.001, grow).toFixed(3) + ")";
      ring.style.borderWidth = ((1 - hole) * 40).toFixed(1) + "px";
      ring.style.opacity = (u < 0.01 || hole > 0.99) ? "0" : "1";
      return;
    }
    if (res.transType === "fade") {
      var fadeBar = stageEl.querySelector(".f2m-trans-bar");
      if (!fadeBar) return;
      fadeBar.style.opacity = String(Math.max(0, Math.min(1, u <= 0.5 ? u * 2 : (1 - u) * 2)).toFixed(3));
      return;
    }
    if (res.transType === "flash") {
      var flashBar = stageEl.querySelector(".f2m-trans-bar");
      if (!flashBar) return;
      // AE: burst reaches 130% within the first 0.2s (capped before the cut), then a slow exposure fall.
      var dur = Number(res.duration) || 0.9;
      var growEnd = Math.max(0.12, Math.min(0.5, 0.2 / dur));
      var fg = smooth(u / growEnd);
      flashBar.style.transform = "scale(" + (0.05 + 1.25 * fg).toFixed(3) + ")";
      var fop = u <= 0.5 ? 1 : Math.max(0, 1 - smooth((u - 0.5) / 0.5));
      flashBar.style.opacity = String(fop.toFixed(3));
      return;
    }
    if (res.transType === "split" || res.transType === "shutter") {
      var panels = stageEl.querySelectorAll(".f2m-trans-bar");
      var axis = res.transType === "split" ? "translateX" : "translateY";
      var moved = u <= 0.5 ? smooth(u / 0.5) : smooth((u - 0.5) / 0.5);
      for (var pi = 0; pi < panels.length; pi++) {
        // AE: half-frame panels slide in from ±0.78 of the frame, cover one half each at the cut, then cross out.
        var from = pi === 0 ? -106 : 106;
        var to = pi === 0 ? 206 : -206;
        var pt = u <= 0.5 ? from * (1 - moved) : to * moved;
        panels[pi].style.transform = axis + "(" + pt.toFixed(1) + "%)";
      }
      return;
    }
    var bars = stageEl.querySelectorAll(".f2m-trans-bar");
    var horiz = res.direction === "left" || res.direction === "right";
    var k = (res.direction === "left" || res.direction === "up") ? -1 : 1;
    var n = bars.length;
    var st = n > 1 ? 0.25 / (n - 1) : 0;
    var sweep = Math.max(0.001, 0.5 - (n - 1) * st);
    var startPct = -k * 105;
    var endPct = k * 105;
    for (var i = 0; i < n; i++) {
      // AE: bar i starts at ts+i*st, covers at tm-(n-1-i)*st, leaves at tm+i*st, exiting over the same sweep.
      var inStart = i * st;
      var cover = 0.5 - (n - 1 - i) * st;
      var outStart = 0.5 + i * st;
      var pct;
      if (u <= inStart) pct = startPct;
      else if (u < cover) pct = startPct * (1 - smooth((u - inStart) / sweep));
      else if (u <= outStart) pct = 0;
      else pct = endPct * smooth((u - outStart) / sweep);
      bars[i].style.transform = horiz ? ("translateX(" + pct.toFixed(1) + "%)") : ("translateY(" + pct.toFixed(1) + "%)");
    }
  }

  function resetStageVisual(stageEl, item) {
    if (!stageEl) return;
    if (item && item.command === "text_reveal") {
      var nodes = stageEl.querySelectorAll(".f2m-demo-char");
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].style.transform = "none";
        nodes[i].style.opacity = "1";
        nodes[i].style.filter = "none";
      }
      return;
    }
    if (item && item.command === "transition") {
      applyTransitionVisual(stageEl, { transType: item.defaults && item.defaults.type || "wipe", direction: state.params.direction, progress: 0.38 });
      return;
    }
    var box = stageEl.querySelector(".f2m-demo-box");
    if (box) {
      box.style.transform = "translate3d(0,0,0) rotate(0deg) scale(1,1)";
      box.style.opacity = "1";
    }
  }

  function stepAnimations(now) {
    if (!activeLoops.size) { rafId = 0; return; }
    if (document.hidden) { rafId = window.requestAnimationFrame(stepAnimations); return; }
    activeLoops.forEach(function (entry, stageEl) {
      if (!stageEl.isConnected) { activeLoops.delete(stageEl); return; }
      if (entry.startTs === null) entry.startTs = now;
      var item = entry.item;
      var speed = Number(state.params.speed) || 1;
      var dur = Math.max(0.28, (entry.duration || 0.7) / speed);
      var hold = 0.65;
      var cycle = dur + hold;
      var elapsed = Math.max(0, (now - entry.startTs) / 1000) % cycle;
      var t = Math.min(dur, elapsed);
      var progress = t / dur;

      if (item.clip && Preview) {
        var clipT = progress * (entry.meta ? entry.meta.duration : item.clip.duration);
        var res = Preview.evaluateClipAt(item.clip, clipT, item.defaultAnchor, entry.meta);
        applyBoxVisual(stageEl, res);
      } else if (item.kind === "procedural" && Preview) {
        var overrides = {};
        if (item.supports && item.supports.direction) overrides.direction = state.params.direction;
        if (item.supports && item.supports.style) overrides.style = state.params.style;
        var pRes = Preview.evaluatePresetAt(item, overrides, progress);
        if (pRes.kind === "box") applyBoxVisual(stageEl, pRes);
        else if (pRes.kind === "text") applyTextVisual(stageEl, pRes.chars);
        else if (pRes.kind === "transition") applyTransitionVisual(stageEl, pRes);
      }
    });
    if (activeLoops.size) rafId = window.requestAnimationFrame(stepAnimations);
    else rafId = 0;
  }

  function startStageLoop(stageEl, item, meta, restart) {
    if (!Preview || !stageEl) return;
    var dur = item.clip ? (meta ? meta.duration : item.clip.duration) : ((item.defaults && item.defaults.duration) || 0.65);
    var prev = activeLoops.get(stageEl);
    activeLoops.set(stageEl, {
      item: item,
      meta: meta,
      startTs: (restart || !prev) ? null : prev.startTs,
      duration: dur
    });
    if (!rafId) rafId = window.requestAnimationFrame(stepAnimations);
  }

  function stopStageLoop(stageEl, item) {
    activeLoops.delete(stageEl);
    resetStageVisual(stageEl, item);
  }

  function syncAllAutoPlay() {
    var stages = document.querySelectorAll(".f2m-stage[data-playable='1']");
    for (var i = 0; i < stages.length; i++) {
      var el = stages[i];
      var inView = visibleStages.size ? visibleStages.has(el) : true;
      if (state.autoPlayAll && inView) {
        if (!activeLoops.has(el) && el._f2mItem) startStageLoop(el, el._f2mItem, el._f2mMeta);
      } else if (!el._f2mHovered) {
        if (activeLoops.has(el)) stopStageLoop(el, el._f2mItem);
      }
    }
  }

  // ---- AE Execution Actions ----
  function applyMotionItem(item) {
    if (!CEP) {
      log("预览模式：已模拟调用「" + item.name + "」", "ok");
      return;
    }
    var speed = Number(state.params.speed) || 1;
    var timeScale = 1 / speed;
    var replaceTracks = !!state.params.replace;

    if (item.clip) {
      var anchor = state.params.anchor === "auto" ? (item.defaultAnchor || "end") : state.params.anchor;
      var jobPath = writeJobTemp({
        name: item.name,
        clip: item.clip,
        time_scale: timeScale,
        position_anchor: anchor,
        scale_relative: true,
        replaceTracks: replaceTracks
      }, "clip");
      evalES("mkMotionApplyClip(" + esLiteral(jobPath) + ")", function (raw) {
        var res = parseEsJson(raw);
        if (res.ok) {
          log("已应用「" + item.name + "」→ " + res.layers + " 层（" + res.tracks + " 条轨道，单步可撤销）", "ok");
            } else {
          report("应用「" + item.name + "」失败：" + res.error, true);
        }
      });
      return;
    }

    if (item.kind === "procedural") {
      var opts = Object.assign({}, item.defaults || {});
      if (item.supports && item.supports.direction) opts.direction = state.params.direction;
      if (item.supports && item.supports.style) {
        if (item.command === "text_reveal") opts.ease = state.params.style;
        else opts.style = state.params.style;
      }
      if (item.supports && item.supports.duration && opts.duration) {
        opts.duration = Math.max(0.08, Math.round((opts.duration * timeScale) * 1000) / 1000);
      }
      var presetPath = writeJobTemp({
        name: item.name,
        command: item.command,
        options: opts,
        replaceTracks: replaceTracks
      }, "preset");
      evalES("mkMotionApplyPreset(" + esLiteral(presetPath) + ")", function (raw) {
        var res = parseEsJson(raw);
        if (res.ok) {
          var n = res.result && (res.result.layers || res.result.staggered);
          log("已应用「" + item.name + "」" + (n ? "→ " + n + " 层" : "") + "（单步可撤销）", "ok");
            } else {
          report("应用「" + item.name + "」失败：" + res.error, true);
        }
      });
    }
  }

  function applyTemplateItem(item, chosenVariant) {
    if (!CEP) {
      log("预览模式：已模拟导入「" + item.name + "」", "ok");
      return;
    }
    try {
      var targetFile = item.file;
      var kind = item.kind;
      var compName = chosenVariant ? chosenVariant.compName : (item.defaultComp || "");

      if (kind === "mogrt") {
        if (!scanner) throw new Error("缺少 MOGRT 解析模块。");
        log("正在解包 MOGRT「" + item.name + "」…");
        targetFile = scanner.extractMogrtAep(item.file);
        kind = "aep";
      }

      var jobPath = writeJobTemp({
        name: item.name + (chosenVariant ? " " + chosenVariant.label : ""),
        kind: kind,
        file: targetFile.replace(/\\/g, "/"),
        compName: compName,
        fitToComp: true
      }, "tpl");

      evalES("mkMotionImportTemplate(" + esLiteral(jobPath) + ")", function (raw) {
        var res = parseEsJson(raw);
        if (res.ok) {
          if (res.kind === "ffx") {
            log("已应用 FFX「" + item.name + "」→ " + res.layers + " 层", "ok");
          } else if (res.kind === "aep") {
            log("已导入合成「" + (res.compName || item.name) + "」到当前时间轴", "ok");
          } else if (res.addedToTimeline) {
            log("已导入" + (res.asComp ? "分层合成" : "素材") + "「" + (res.itemName || item.name) + "」到当前时间轴", "ok");
          } else {
            log("已导入素材「" + (res.itemName || item.name) + "」到项目面板", "ok");
          }
        } else {
          report("导入「" + item.name + "」失败：" + res.error, true);
        }
      });
    } catch (e) {
      report("文件处理失败：" + e.message, true);
    }
  }

  // ---- User Clip Save / Import ----
  function captureFromAE(cb) {
    if (!CEP) { cb(new Error("请在 AE 中使用保存动效功能。")); return; }
    var snapFile = path.join(os.tmpdir(), "f2a_snap_" + Date.now() + "_" + (++tempSerial) + ".json");
    var jobPath = writeJobTemp({
      scope: "all",
      includeStatic: false,
      snapshotFile: snapFile.replace(/\\/g, "/")
    }, "capture");
    evalES("mkMotionCaptureSelected(" + esLiteral(jobPath) + ")", function (raw) {
      var res = parseEsJson(raw);
      if (!res.ok) { cb(new Error(res.error || "捕获图层动效失败。")); return; }
      try {
        var data = JSON.parse(fs.readFileSync(snapFile, "utf8").replace(/^\uFEFF/, ""));
        try { fs.unlinkSync(snapFile); } catch (eRm) {}
        cb(null, data);
      } catch (eRead) {
        cb(eRead);
      }
    });
  }

  function commitSaveClip(name, tagsText) {
    if (!scanner) { report("本地动效存储模块不可用。", true); return; }
    var tags = String(tagsText || "").split(/[,，\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    captureFromAE(function (err, snap) {
      if (err) { report("捕获动效失败：" + err.message, true); return; }
      try {
        var built = scanner.makeClipFromSnapshots(snap);
        var saved = scanner.saveUserClip(name, tags, built.clip);
        state.saveFormOpen = false;
        refreshUserClips();
        log("已保存选中动效「" + saved.name + "」（" + saved.clip.duration.toFixed(2) + "s）", "ok");
        renderPanel();
      } catch (eSave) {
        report("保存动效失败：" + eSave.message, true);
      }
    });
  }

  function renameUserClip(item, name) {
    if (!scanner) { report("本地动效存储模块不可用。", true); return false; }
    try {
      scanner.renameUserClip(item.id, name);
      state.renameId = null;
      refreshUserClips();
      log("已重命名动效「" + item.name + "」→「" + name + "」");
      renderPanel();
      return true;
    } catch (e) {
      report("重命名动效失败：" + e.message, true);
      return false;
    }
  }

  function importJsonDialog() {
    if (!scanner) return;
    if (window.cep && window.cep.fs && window.cep.fs.showOpenDialogEx) {
      var pick = window.cep.fs.showOpenDialogEx(false, false, "导入 F2A 动效 JSON 文件", "", ["json"]);
      if (pick.err || !pick.data || !pick.data[0]) return;
      try {
        var saved = scanner.importUserClipFile(pick.data[0]);
        refreshUserClips();
        log("已导入动效「" + saved.name + "」", "ok");
        renderPanel();
      } catch (e) {
        report("导入 JSON 失败：" + e.message, true);
      }
    } else {
      report("请在 AE 面板中使用导入文件对话框。", true);
    }
  }

  // Saved clips can go back out as JSON: the exported record uses the same schemaVersion: 1
  // format importUserClipFile reads (and the MCP ae_motion_import accepts).
  function exportUserClipDialog(item) {
    if (!scanner) return;
    if (!(window.cep && window.cep.fs && window.cep.fs.showSaveDialogEx)) {
      report("请在 AE 面板中导出 JSON。", true);
      return;
    }
    var base = String(item.name || "动效").replace(/[\\/:*?"<>|\r\n]+/g, "_").replace(/^\s+|\s+$/g, "").slice(0, 80) || "动效";
    var pick = window.cep.fs.showSaveDialogEx("导出 F2A 动效 JSON（可在其它机器导入）", "", ["json"], base + ".json");
    if (!pick || pick.err || !pick.data) return;
    var target = /\.json$/i.test(pick.data) ? pick.data : pick.data + ".json";
    try {
      scanner.exportUserClip(item.id, target);
      log("已导出动效「" + item.name + "」→ " + target, "ok");
    } catch (e) {
      report("导出动效失败：" + e.message, true);
    }
  }

  function addTemplateDir(dirPath) {
    var clean = String(dirPath || "").trim().replace(/^["']|["']$/g, "");
    if (!clean) return;
    if (fs && (!fs.existsSync(clean) || !fs.statSync(clean).isDirectory())) {
      report("目录不存在：" + clean, true);
      return;
    }
    var norm = path ? path.resolve(clean) : clean;
    if (state.templateDirs.indexOf(norm) < 0) {
      state.templateDirs.push(norm);
      saveStoredDirs(state.templateDirs);
    }
    state.dirInputOpen = false;
    state.templateDirFilter = state.templateDirs.length > 1 ? norm : null;
    state.currentSubDir = "";
    state.category = "全部";
    rescanTemplates();
    log("已挂载本地目录（共发现 " + state.templates.length + " 个文件）", "ok");
    renderPanel();
  }

  function chooseTemplateDir() {
    if (window.cep && window.cep.fs && window.cep.fs.showOpenDialogEx) {
      var pick = window.cep.fs.showOpenDialogEx(false, true, "选择本地文件夹（支持视频、图片、音频、AEP / MOGRT / FFX）", "", []);
      if (pick.err) { report("打开目录窗口失败（" + pick.err + "）", true); return; }
      if (pick.data && pick.data[0]) addTemplateDir(pick.data[0]);
    } else {
      state.dirInputOpen = !state.dirInputOpen;
      renderPanel();
    }
  }

  // ---- Lazy MOGRT Thumbnail Observer ----
  function applyMogrtPreview(item, stage, prev) {
    item.thumb = prev.thumb;
    item.video = prev.video;
    if (item.thumb) {
      var img = stage.querySelector(".f2m-thumb");
      if (!img) {
        img = el("img", "f2m-thumb");
        img.alt = item.name;
        stage.insertBefore(img, stage.firstChild);
      }
      img.src = fileUrl(item.thumb);
    } else if (item.video && !stage.querySelector(".f2m-thumb-video")) {
      addVideoThumbnail(stage, fileUrl(item.video));
    }
    if (item.thumb || item.video) {
      var ph = stage.querySelector(".f2m-media-placeholder");
      if (ph) ph.remove();
    }
    if (item.video) stage.setAttribute("data-video", fileUrl(item.video));
  }
  var mogrtObserver = null;
  function getMogrtObserver() {
    if (mogrtObserver || typeof IntersectionObserver === "undefined") return mogrtObserver;
    mogrtObserver = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isIntersecting) continue;
        var stage = entries[i].target;
        mogrtObserver.unobserve(stage);
        var item = stage._f2mTemplate;
        if (!item || item._probed || !scanner) continue;
        if (item.kind === "mogrt") {
          item._probed = true;
          try {
            applyMogrtPreview(item, stage, scanner.ensureMogrtPreview(item.file));
          } catch (e) {}
        } else if (item.kind === "aep" && !item.thumb && !item.video) {
          item._probed = true;
          enqueueAepPreview(item, stage);
        } else if (item.kind === "video" && item.video && !stage.querySelector(".f2m-thumb-video")) {
          var vUrl = fileUrl(item.video);
          addVideoThumbnail(stage, vUrl, function (dur) {
            item._duration = dur;
            var badge = stage.querySelector(".f2m-media-badge");
            if (badge) badge.textContent = formatMediaDuration(dur);
          });
          var ph = stage.querySelector(".f2m-media-placeholder");
          if (ph) ph.remove();
        }
      }
    }, { rootMargin: "120px" });
    return mogrtObserver;
  }

  // ---- AEP template preview: render one frame with a separate aerender process ----
  // The user's open AE project must not be touched, so this mirrors the MOGRT thumbnail cache:
  // a Python helper parses the AEP, launches aerender for one frame, and stores the result.
  var aepPreviewQueue = [];
  var aepPreviewBusy = false;
  var aepPreviewUnavailable = false;
  function aepToolRoot() {
    if (!HAS_NODE) return "";
    var roots = [];
    if (extDir) roots.push(extDir);
    if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, "F2A", "AEP"));
    for (var i = 0; i < roots.length; i++) {
      try { if (fs.existsSync(path.join(roots[i], "scripts", "aep", "render_preview.py"))) return roots[i]; } catch (e) {}
    }
    return "";
  }
  function aepPython(root) {
    if (!HAS_NODE || !root) return "";
    var env = process.env.F2A_PYTHON;
    if (env && fs.existsSync(env)) return env;
    var candidates = [
      path.join(root, "runtime", "python", "python.exe"),
      path.join(root, ".venv-aep", process.platform === "win32" ? "Scripts" : "bin", "python.exe"),
    ];
    for (var i = 0; i < candidates.length; i++) {
      try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch (e) {}
    }
    return "";
  }
  function aepCacheFor(file) {
    if (!fs || !path || !scanner) return null;
    try {
      var crypto = require("crypto");
      var st = fs.statSync(file);
      var key = crypto.createHash("sha1")
        .update(path.resolve(file) + "|" + st.mtimeMs + "|" + st.size).digest("hex").slice(0, 16);
      var dir = path.join(scanner.getPackCacheDir(), "aep-" + key);
      var metaPath = path.join(dir, "meta.json");
      if (fs.existsSync(metaPath)) {
        var meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (meta && meta.file && fs.existsSync(meta.file)) {
          return { dir: dir, thumb: meta.kind === "video" ? null : meta.file, video: meta.kind === "video" ? meta.file : null, meta: meta };
        }
      }
      return { dir: dir, thumb: null, video: null };
    } catch (e) { return null; }
  }
  function applyTemplatePreview(item, stage, thumbPath) {
    item.thumb = thumbPath;
    var img = stage.querySelector(".f2m-thumb");
    if (!img) {
      img = el("img", "f2m-thumb");
      img.alt = item.name;
      stage.insertBefore(img, stage.firstChild);
    }
    img.src = fileUrl(thumbPath);
    var ph = stage.querySelector(".f2m-media-placeholder");
    if (ph) ph.remove();
  }
  function applyAepPreview(item, stage, file, kind) {
    if (kind === "video") {
      item.video = file;
      if (!stage.querySelector(".f2m-thumb-video")) addVideoThumbnail(stage, fileUrl(file));
      stage.setAttribute("data-video", fileUrl(file));
    } else {
      applyTemplatePreview(item, stage, file);
      return;
    }
    var ph = stage.querySelector(".f2m-media-placeholder");
    if (ph) ph.remove();
  }
  function lastJsonLine(text) {
    var lines = String(text || "").split(/\r?\n/);
    for (var i = lines.length - 1; i >= 0; i--) {
      var line = lines[i].trim();
      if (line.charAt(0) === "{") {
        try { return JSON.parse(line); } catch (e) {}
      }
    }
    return null;
  }
  function pumpAepPreviews() {
    if (aepPreviewBusy || !aepPreviewQueue.length) return;
    if (!CEP || !HAS_NODE || aepPreviewUnavailable) return;
    var root = aepToolRoot();
    var python = aepPython(root);
    if (!root || !python) {
      aepPreviewUnavailable = true;
      log("AEP 预览组件不可用：找不到 Python 或 render_preview.py", "err");
      aepPreviewQueue.length = 0;
      return;
    }
    aepPreviewBusy = true;
    var job = aepPreviewQueue.shift();
    try { fs.mkdirSync(job.cache.dir, { recursive: true }); } catch (eMk) {}
    var childProcess = require("child_process");
    childProcess.execFile(python, [
      path.join(root, "scripts", "aep", "render_preview.py"),
      "--aep", job.item.file,
      "--cache-dir", job.cache.dir,
    ], { windowsHide: true, timeout: 240000, maxBuffer: 4 * 1024 * 1024 }, function (error, stdout, stderr) {
      aepPreviewBusy = false;
      var res = lastJsonLine(stdout);
      var previewFile = res && res.file ? res.file : "";
      var previewKind = res && res.kind ? res.kind : "image";
      var liveStage = job.stage && job.stage.isConnected ? job.stage : (job.item._stage && job.item._stage.isConnected ? job.item._stage : null);
      if (res && res.ok && previewFile && fs.existsSync(previewFile)) {
        job.item._previewQueued = false;
        if (previewKind === "video") job.item.video = previewFile; else job.item.thumb = previewFile;
        if (liveStage) applyAepPreview(job.item, liveStage, previewFile, previewKind);
      } else {
        job.item._previewQueued = false;
        job.item._previewFailed = true;
        if (liveStage) {
          var ph = liveStage.querySelector(".f2m-media-placeholder");
          if (ph) ph.textContent = "AEP（无预览）";
        }
        var message = (res && res.error) || (error && error.message) || (stderr ? String(stderr).slice(0, 200) : "未知错误");
        log("模板预览生成失败：" + job.item.name + " — " + message, "err");
      }
      setTimeout(pumpAepPreviews, 50);
    });
  }
  function enqueueAepPreview(item, stage) {
    if (!CEP || !HAS_NODE || !scanner) return;
    if (item._previewQueued || item._previewFailed || item.thumb || item.video) return;
    var cache = aepCacheFor(item.file);
    if (!cache) return;
    if (cache.thumb || cache.video) {
      applyAepPreview(item, stage, cache.thumb || cache.video, cache.video ? "video" : "image");
      return;
    }
    item._previewQueued = true;
    var ph = stage.querySelector(".f2m-media-placeholder");
    if (ph) ph.textContent = "生成预览…";
    aepPreviewQueue.push({ item: item, stage: stage, cache: cache });
    pumpAepPreviews();
  }

  // ---- DOM Helpers & Flat Vector Icons ----
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function svgIcon(name) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "f2m-svg-ico");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    function add(tag, attrs) {
      var n = document.createElementNS(ns, tag);
      for (var k in attrs) if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]);
      svg.appendChild(n);
    }
    if (name === "play") {
      add("polygon", { points: "5,3.2 13,8 5,12.8", fill: "currentColor" });
    } else if (name === "pause") {
      add("rect", { x: "4.2", y: "3.5", width: "2.6", height: "9", rx: "0.7", fill: "currentColor" });
      add("rect", { x: "9.2", y: "3.5", width: "2.6", height: "9", rx: "0.7", fill: "currentColor" });
    } else if (name === "plus") {
      add("path", { d: "M8 3.2v9.6M3.2 8h9.6", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round" });
    } else if (name === "refresh") {
      add("path", { d: "M13.5 8a5.5 5.5 0 1 1-1.4-3.65M13.5 2.5v2.75h-2.75", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" });
    } else if (name === "check") {
      add("path", { d: "M3.2 8.3l3 3 6.6-6.6", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round" });
    } else if (name === "star" || name === "star-filled") {
      var filled = name === "star-filled";
      add("path", {
        d: "M8 2.2l1.66 3.36 3.71.54-2.68 2.62.63 3.69L8 10.67l-3.32 1.74.63-3.69-2.68-2.62 3.71-.54L8 2.2z",
        fill: filled ? "currentColor" : "none",
        stroke: "currentColor", "stroke-width": filled ? "1" : "1.2",
        "stroke-linejoin": "round"
      });
    } else if (name === "upload") {
      add("path", { d: "M8 10.8V3.2M5 6l3-3 3 3M3 12.8h10", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" });
    } else if (name === "download") {
      add("path", { d: "M8 3.2v7.6M5 8.2l3 3 3-3M3 12.8h10", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" });
    } else if (name === "close") {
      add("path", { d: "M4.5 4.5l7 7M11.5 4.5l-7 7", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round" });
    }
    return svg;
  }

  function iconButton(cls, iconName, labelText, title) {
    var btn = el("button", cls);
    btn.type = "button";
    if (title) btn.title = title;
    if (iconName) btn.appendChild(svgIcon(iconName));
    if (labelText) btn.appendChild(el("span", "", labelText));
    return btn;
  }

  // ---- Favourites ----
  // A hollow star on every motion card becomes solid once saved; the 收藏 pill in the
  // category strip filters the current tab down to those cards.
  function toggleFavorite(item) {
    var key = favoriteKey(item);
    if (!key) return;
    var at = state.favorites.indexOf(key);
    if (at >= 0) {
      state.favorites.splice(at, 1);
      log("已取消收藏「" + item.name + "」");
    } else {
      state.favorites.push(key);
      log("已收藏「" + item.name + "」");
    }
    saveStoredFavorites(state.favorites);
    renderGrid();
  }

  function favoriteButton(item) {
    var on = isFavorite(item);
    var btn = iconButton("f2m-fav" + (on ? " is-on" : ""), on ? "star-filled" : "star", "", (on ? "取消收藏" : "收藏") + "「" + item.name + "」");
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.onclick = function (ev) {
      ev.stopPropagation();
      toggleFavorite(item);
    };
    return btn;
  }

  // Directional variants (上/下/左/右) read in 上、下、左、右 order wherever they appear,
  // while non-directional entries keep their original position.
  var DIRECTION_TOKENS = [
    ["上滑", 0], ["下滑", 1], ["左滑", 2], ["右滑", 3],
    ["上浮", 0], ["下落", 1], ["下沉", 1], ["上移", 0], ["下移", 1], ["左移", 2], ["右移", 3],
    ["向上", 0], ["向下", 1], ["向左", 2], ["向右", 3],
    ["上展开", 0], ["下展开", 1], ["左展开", 2], ["右展开", 3]
  ];
  function directionMatch(name) {
    for (var i = 0; i < DIRECTION_TOKENS.length; i++) {
      var token = DIRECTION_TOKENS[i][0], at = name.indexOf(token);
      if (at >= 0) return { rank: DIRECTION_TOKENS[i][1], key: name.slice(0, at) + name.slice(at + token.length) };
    }
    return null;
  }
  function orderDirectionItems(items) {
    var families = {}, order = [], i;
    for (i = 0; i < items.length; i++) {
      var m = directionMatch(String(items[i].name || ""));
      if (!m) continue;
      if (!families[m.key]) { families[m.key] = { refs: [], indices: [] }; order.push(m.key); }
      families[m.key].refs.push({ item: items[i], rank: m.rank, index: i });
      families[m.key].indices.push(i);
    }
    var out = items.slice();
    for (i = 0; i < order.length; i++) {
      var fam = families[order[i]];
      if (fam.refs.length < 2) continue;
      var sorted = fam.refs.slice().sort(function (a, b) { return a.rank - b.rank || a.index - b.index; });
      for (var j = 0; j < fam.indices.length; j++) out[fam.indices[j]] = sorted[j].item;
    }
    return out;
  }

  function folderFilteredTemplates() {
    if (!state.templateDirFilter) return state.templates;
    return state.templates.filter(function (item) { return item.rootDir === state.templateDirFilter; });
  }

  function activeBrowseRoot() {
    if (state.templateDirFilter) return state.templateDirFilter;
    if (state.templateDirs.length === 1) return state.templateDirs[0];
    return null;
  }

  function listLevelLocal(items, subDir) {
    if (scanner && typeof scanner.listFolderLevel === "function") {
      return scanner.listFolderLevel(items, subDir);
    }
    var cur = String(subDir || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    var pref = cur ? (cur + "/") : "";
    var map = {}, order = [], files = [];
    for (var i = 0; i < items.length; i++) {
      var rel = String(items[i].relDir || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      if (rel === cur) { files.push(items[i]); continue; }
      if (cur && rel.indexOf(pref) !== 0) continue;
      var rest = cur ? rel.slice(pref.length) : rel;
      if (!rest) continue;
      var seg = rest.split("/")[0];
      var childRel = cur ? (cur + "/" + seg) : seg;
      if (!map[childRel]) { map[childRel] = { name: seg, relDir: childRel, count: 0 }; order.push(childRel); }
      map[childRel].count++;
    }
    var folders = order.map(function (k) { return map[k]; })
      .sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
    return { folders: folders, files: files };
  }

  function subDirScopedTemplates() {
    var list = folderFilteredTemplates();
    var sub = state.currentSubDir;
    if (!sub || !activeBrowseRoot()) return list;
    var pref = sub + "/";
    return list.filter(function (item) {
      var r = String(item.relDir || "");
      return r === sub || r.indexOf(pref) === 0;
    });
  }

  function currentItemsAndCategories() {
    var q = state.query.trim().toLowerCase();
    var all = [];
    var catSet = [];
    function addCat(c) { if (c && catSet.indexOf(c) < 0) catSet.push(c); }

    if (state.tab === "builtin") {
      // Combine curated real-data clips + procedural AE Motion presets
      var order = ["入场", "组合", "弹跳", "缩放", "旋转", "文字", "强调", "出场", "转场"];
      order.forEach(addCat);
      var merged = [];
      for (var i = 0; i < state.builtinClips.length; i++) merged.push(state.builtinClips[i]);
      for (var j = 0; j < state.builtinPresets.length; j++) merged.push(state.builtinPresets[j]);
      all = merged;
    } else if (state.tab === "templates") {
      all = subDirScopedTemplates();
      var preferredCats = ["视频", "图片", "音频", "设计稿", "AEP 模板", "MOGRT", "FFX 特效"];
      var present = {};
      for (var t = 0; t < all.length; t++) if (all[t].category) present[all[t].category] = true;
      preferredCats.forEach(function (c) { if (present[c]) addCat(c); });
      for (var t2 = 0; t2 < all.length; t2++) addCat(all[t2].category);
    } else {
      all = state.userClips;
    }

    var favoritesOnly = state.category === "收藏";
    var filtered = all.filter(function (item) {
      if (favoritesOnly) {
        if (!isFavorite(item)) return false;
      } else if (state.category !== "全部" && item.category !== state.category) return false;
      if (!q) return true;
      var hay = [
        item.name || "",
        item.ext || "",
        item.category || "",
        item.relDir || "",
        item.pack || "",
        item.description || "",
        Array.isArray(item.tags) ? item.tags.join(" ") : ""
      ].join(" ").toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    return { items: orderDirectionItems(filtered), categories: ["全部", "收藏"].concat(catSet), total: all.length };
  }

  function buildMotionCard(item, isUser) {
    var card = el("div", "f2m-card");
    card.title = (item.description || item.name) + (item.tags && item.tags.length ? "\n标签：" + item.tags.join(" / ") : "");

    var stage = el("div", "f2m-stage is-applyable");
    stage.setAttribute("data-playable", "1");
    stage.title = "点击应用「" + item.name + "」";

    var meta = item.clip && Preview ? Preview.analyzeClip(item.clip, item.defaultAnchor) : null;
    stage._f2mItem = item;
    stage._f2mMeta = meta;

    // Clean, uncluttered preview stage with crisp visual subject
    if (item.command === "text_reveal") {
      var wrap = el("div", "f2m-demo-text");
      ["S", "A", "M", "P", "L", "E"].forEach(function (ch) {
        wrap.appendChild(el("span", "f2m-demo-char", ch));
      });
      stage.appendChild(wrap);
    } else if (item.command === "transition") {
      var tType = (item.defaults && item.defaults.type) || "wipe";
      var frame = el("div", "f2m-trans-frame");
      if (tType === "iris") {
        frame.appendChild(el("div", "f2m-trans-iris"));
      } else if (tType === "fade" || tType === "split" || tType === "shutter" || tType === "flash") {
        frame.className = "f2m-trans-frame is-" + tType;
        var panelCount = (tType === "fade" || tType === "flash") ? 1 : 2;
        for (var pi = 0; pi < panelCount; pi++) frame.appendChild(el("div", "f2m-trans-bar"));
      } else {
        var count = tType === "bars" ? 5 : 1;
        var horiz = state.params.direction === "left" || state.params.direction === "right";
        frame.className = "f2m-trans-frame " + (horiz ? "is-horiz" : "is-vert");
        for (var bi = 0; bi < count; bi++) frame.appendChild(el("div", "f2m-trans-bar"));
      }
      stage.appendChild(frame);
      resetStageVisual(stage, item);
    } else {
      var box = el("div", "f2m-demo-box");
      var ns = "http://www.w3.org/2000/svg";
      var mark = document.createElementNS(ns, "svg");
      mark.setAttribute("class", "f2m-demo-mark");
      mark.setAttribute("viewBox", "36 33 192 192");
      mark.setAttribute("aria-hidden", "true");
      var stem = document.createElementNS(ns, "path");
      stem.setAttribute("d", "M74 100 C74 68, 94 50, 126 50 H130 C116 56, 110 70, 110 92 V190 A18 18 0 0 1 74 190 Z");
      stem.setAttribute("fill", "#f0f0f0");
      var wing = document.createElementNS(ns, "path");
      wing.setAttribute("d", "M74 100 C74 64, 96 50, 132 50 H172 A18 18 0 0 1 172 86 H126 C104 86, 86 98, 74 120 Z");
      wing.setAttribute("fill", "#f0f0f0");
      var bar = document.createElementNS(ns, "rect");
      bar.setAttribute("x", "116");
      bar.setAttribute("y", "118");
      bar.setAttribute("width", "62");
      bar.setAttribute("height", "34");
      bar.setAttribute("rx", "17");
      bar.setAttribute("fill", "#f0f0f0");
      mark.appendChild(stem);
      mark.appendChild(wing);
      mark.appendChild(bar);
      box.appendChild(mark);
      stage.appendChild(box);
    }

    card.appendChild(stage);
    // The favourite star floats on the preview's top-right corner; the footer keeps name actions.
    stage.appendChild(favoriteButton(item));
    // Footer: duration/track metadata, plus rename/export/delete for saved clips. Clicking a
    // saved clip's name swaps the title for the inline input, so no separate rename icon is needed.
    var foot = el("div", "f2m-foot");
    var info = el("div", "f2m-info");
    var renaming = isUser && state.renameId === item.id;
    var renameInput = null;
    if (renaming) {
      renameInput = el("input", "f2m-input f2m-rename-input");
      renameInput.type = "text";
      renameInput.value = item.name;
      renameInput.maxLength = 120;
      renameInput.setAttribute("aria-label", "动效名称");
      info.appendChild(renameInput);
    } else if (isUser) {
      var titleEl = el("div", "f2m-title is-editable", item.name);
      titleEl.title = "点击重命名此动效";
      titleEl.setAttribute("role", "button");
      titleEl.tabIndex = 0;
      var beginRename = function (ev) {
        if (ev) ev.stopPropagation();
        state.renameId = item.id;
        state.confirmDeleteId = null;
        renderGrid();
      };
      titleEl.onclick = beginRename;
      titleEl.onkeydown = function (ev) {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); beginRename(ev); }
      };
      info.appendChild(titleEl);
    } else {
      info.appendChild(el("div", "f2m-title", item.name));
    }
    var durVal = item.clip ? item.clip.duration : ((item.defaults && item.defaults.duration) || 0.5);
    var durStr = (Math.round(durVal * 100) / 100) + "s";
    var kindText = meta && meta.trackNames.length
      ? meta.trackNames.join(" / ")
      : (item.kind === "procedural" ? (item.category || "参数") : "动效");
    info.appendChild(el("div", "f2m-sub", durStr + " · " + kindText));
    foot.appendChild(info);

    if (isUser) {
      var actions = el("div", "f2m-actions");
      var cancelRename = function () {
        state.renameId = null;
        renderGrid();
      };
      var saveRename = function () {
        var next = renameInput ? renameInput.value.trim() : "";
        if (!next) {
          report("请输入动效名称。", true);
          if (renameInput) renameInput.focus();
          return;
        }
        if (next === item.name) { cancelRename(); return; }
        renameUserClip(item, next);
      };
      if (renaming) {
        if (renameInput) {
          renameInput.addEventListener("keydown", function (ev) {
            if (ev.key === "Enter") { ev.preventDefault(); saveRename(); }
            else if (ev.key === "Escape") { ev.preventDefault(); cancelRename(); }
          });
          setTimeout(function () { renameInput.focus(); renameInput.select(); }, 0);
        }
        var okBtn = iconButton("f2m-del is-ok", "check", "", "保存名称");
        okBtn.type = "button";
        okBtn.onclick = function (ev) { ev.stopPropagation(); saveRename(); };
        var cancelBtn = iconButton("f2m-del is-cancel", "close", "", "取消重命名");
        cancelBtn.type = "button";
        cancelBtn.onclick = function (ev) { ev.stopPropagation(); cancelRename(); };
        actions.appendChild(okBtn);
        actions.appendChild(cancelBtn);
      } else {
        var exportBtn = iconButton("f2m-del is-export", "download", "", "导出为 JSON（可在其它机器导入）");
        exportBtn.type = "button";
        exportBtn.onclick = function (ev) {
          ev.stopPropagation();
          exportUserClipDialog(item);
        };
        actions.appendChild(exportBtn);
        var delBtn = state.confirmDeleteId === item.id
          ? el("button", "f2m-del is-confirm", "确认")
          : iconButton("f2m-del", "close", "", "删除此动效");
        delBtn.type = "button";
        delBtn.onclick = function (ev) {
          ev.stopPropagation();
          if (state.confirmDeleteId !== item.id) {
            state.confirmDeleteId = item.id;
            state.renameId = null;
            renderGrid();
            return;
          }
          state.confirmDeleteId = null;
          if (scanner) scanner.deleteUserClip(item.id);
          refreshUserClips();
          log("已删除自存动效「" + item.name + "」");
          renderPanel();
        };
        actions.appendChild(delBtn);
      }
      foot.appendChild(actions);
    }
    card.appendChild(foot);

    // Clicking the preview applies the motion; hover only previews (auto-loop is off by default).
    stage.onclick = function (ev) {
      ev.stopPropagation();
      applyMotionItem(item);
    };
    card.addEventListener("mouseenter", function () {
      stage._f2mHovered = true;
      startStageLoop(stage, item, meta, true);
    });
    card.addEventListener("mouseleave", function () {
      stage._f2mHovered = false;
      if (!state.autoPlayAll) stopStageLoop(stage, item);
    });

    var obs = getStageObserver();
    if (obs) obs.observe(stage);
    else if (state.autoPlayAll) startStageLoop(stage, item, meta);

    return card;
  }

  function buildFolderSvg() {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "f2m-folder-ico");
    svg.setAttribute("viewBox", "0 0 34 28");
    svg.setAttribute("aria-hidden", "true");
    var p = document.createElementNS(ns, "path");
    p.setAttribute("d", "M3.5 5.5A2.5 2.5 0 0 1 6 3h6.4a2.5 2.5 0 0 1 1.9.87l1.55 1.83c.38.45.94.7 1.53.7H28a2.5 2.5 0 0 1 2.5 2.5v13.6A2.5 2.5 0 0 1 28 25H6a2.5 2.5 0 0 1-2.5-2.5V5.5Z");
    p.setAttribute("fill", "currentColor");
    p.setAttribute("fill-opacity", "0.22");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.6");
    p.setAttribute("stroke-linejoin", "round");
    svg.appendChild(p);
    return svg;
  }

  function buildFolderCard(folder) {
    var card = el("div", "f2m-card is-folder");
    card.title = "打开文件夹「" + folder.name + "」（" + folder.count + " 项）";
    var stage = el("div", "f2m-stage is-media is-folder is-applyable");
    stage.appendChild(buildFolderSvg());
    stage.appendChild(el("span", "f2m-media-badge", folder.count + " 项"));
    card.appendChild(stage);

    var foot = el("div", "f2m-foot");
    var info = el("div", "f2m-info");
    info.appendChild(el("div", "f2m-title", folder.name));
    info.appendChild(el("div", "f2m-sub", "文件夹 · " + folder.count + " 项"));
    foot.appendChild(info);
    card.appendChild(foot);

    card.onclick = function () {
      if (folder.rootDir) {
        state.templateDirFilter = folder.rootDir;
        state.currentSubDir = "";
      } else {
        state.currentSubDir = folder.relDir || "";
      }
      state.category = "全部";
      state.templatePageLimit = 48;
      renderPanel();
      var sc = document.querySelector(".f2m-scroll");
      if (sc) sc.scrollTop = 0;
    };
    return card;
  }

  function buildAudioWaveSvg() {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "f2m-audio-wave");
    svg.setAttribute("viewBox", "0 0 46 24");
    svg.setAttribute("aria-hidden", "true");
    var bars = [
      [3, 9, 6], [9, 6, 12], [15, 3, 18], [21, 7, 10],
      [27, 4, 16], [33, 8, 8], [39, 6, 12]
    ];
    for (var i = 0; i < bars.length; i++) {
      var r = document.createElementNS(ns, "rect");
      r.setAttribute("x", String(bars[i][0]));
      r.setAttribute("y", String(bars[i][1]));
      r.setAttribute("width", "3");
      r.setAttribute("height", String(bars[i][2]));
      r.setAttribute("rx", "1.5");
      r.setAttribute("fill", "currentColor");
      svg.appendChild(r);
    }
    return svg;
  }

  function buildTemplateCard(item) {
    var card = el("div", "f2m-card is-tpl");
    card.title = item.pack + " / " + item.category + " / " + item.name;

    var selectedVarIdx = 0;
    var stage = el("div", "f2m-stage is-media is-applyable" + (item.transparent ? " is-transparent" : ""));
    stage._f2mTemplate = item;
    item._stage = stage;
    stage.title = "点击" + (item.kind === "ffx" ? "应用" : "导入") + "「" + item.name + "」";

    if (item.kind === "aep" && !item.thumb && !item.video) {
      var cachedPreview = aepCacheFor(item.file);
      if (cachedPreview) {
        if (cachedPreview.thumb) item.thumb = cachedPreview.thumb;
        else if (cachedPreview.video) item.video = cachedPreview.video;
      }
    }
    var thumbUrl = item.thumb ? fileUrl(item.thumb) : "";
    var activeVideoUrl = item.video ? fileUrl(item.video) : "";
    var badgeLabel = (item.ext || item.kind || "").toUpperCase();

    if (thumbUrl) {
      var img = el("img", "f2m-thumb" + (item.transparent ? " is-contain" : ""));
      img.alt = item.name;
      img.loading = "lazy";
      img.src = thumbUrl;
      stage.appendChild(img);
    }

    if (item.kind === "audio") {
      stage.appendChild(buildAudioWaveSvg());
      var audBadge = el("span", "f2m-media-badge", item._duration ? formatMediaDuration(item._duration) : badgeLabel);
      stage.appendChild(audBadge);
    } else if (!thumbUrl && activeVideoUrl) {
      if (item.kind === "video") {
        // Lazy-load video thumbnails via IntersectionObserver so large media folders stay responsive.
        stage.appendChild(el("div", "f2m-media-placeholder", badgeLabel));
        stage.appendChild(el("span", "f2m-media-badge", item._duration ? formatMediaDuration(item._duration) : badgeLabel));
        var vidObs = getMogrtObserver();
        if (vidObs) vidObs.observe(stage);
        else {
          addVideoThumbnail(stage, activeVideoUrl, function (dur) {
            item._duration = dur;
            var b = stage.querySelector(".f2m-media-badge");
            if (b) b.textContent = formatMediaDuration(dur);
          });
          var ph0 = stage.querySelector(".f2m-media-placeholder");
          if (ph0) ph0.remove();
        }
      } else {
        addVideoThumbnail(stage, activeVideoUrl);
      }
    } else if (!thumbUrl && !activeVideoUrl) {
      var phText = item.kind === "ffx" ? "FX" : (badgeLabel || (item.kind === "mogrt" ? "MOGRT" : "AEP"));
      if (item.kind === "aep" && item._previewQueued) phText = "生成预览…";
      var ph = el("div", "f2m-media-placeholder", phText);
      stage.appendChild(ph);
    }

    if (activeVideoUrl) stage.setAttribute("data-video", activeVideoUrl);

    var scrubBar = null, scrubFill = null;
    if (activeVideoUrl || (item.kind === "audio" && item.audio)) {
      scrubBar = el("div", "f2m-scrub-bar");
      scrubFill = el("div", "f2m-scrub-fill");
      scrubBar.appendChild(scrubFill);
      stage.appendChild(scrubBar);
    }

    // Variant switcher for Titles Factory (A1 / A2 / A3) — subtle pill on top-right
    if (item.variants && item.variants.length > 1) {
      var varBar = el("div", "f2m-varbar");
      item.variants.forEach(function (v, idx) {
        var vb = el("button", "f2m-varbtn" + (idx === 0 ? " active" : ""), v.label);
        vb.type = "button";
        vb.onclick = function (ev) {
          ev.stopPropagation();
          selectedVarIdx = idx;
          var siblings = varBar.querySelectorAll(".f2m-varbtn");
          for (var s = 0; s < siblings.length; s++) siblings[s].className = "f2m-varbtn" + (s === idx ? " active" : "");
          var vSrc = v.inVideo || v.outVideo || "";
          if (vSrc) {
            var u = fileUrl(vSrc);
            stage.setAttribute("data-video", u);
            var existingVid = stage.querySelector("video.f2m-vid");
            if (existingVid) { existingVid.src = u; existingVid.play().catch(function () {}); }
          }
        };
        varBar.appendChild(vb);
      });
      stage.appendChild(varBar);
    }

    // Hover plays real video preview + horizontal scrub (Aeviewer-style), or auditions audio.
    if (item.kind === "audio" && item.audio) {
      var audUrl = fileUrl(item.audio);
      var audEl = null;
      card.addEventListener("mouseenter", function () {
        stopActiveAudioPreview();
        if (!audEl) {
          audEl = document.createElement("audio");
          audEl.preload = "metadata";
          audEl.src = audUrl;
          audEl.addEventListener("loadedmetadata", function () {
            if (isFinite(audEl.duration) && audEl.duration > 0) {
              item._duration = audEl.duration;
              var b = stage.querySelector(".f2m-media-badge");
              if (b) b.textContent = formatMediaDuration(audEl.duration);
            }
          });
          audEl.addEventListener("timeupdate", function () {
            if (scrubFill && audEl.duration > 0) {
              scrubFill.style.width = Math.min(100, (audEl.currentTime / audEl.duration) * 100).toFixed(1) + "%";
            }
          });
          audEl.addEventListener("ended", function () {
            stage.classList.remove("is-playing");
            if (scrubFill) scrubFill.style.width = "0%";
          });
        }
        try { audEl.currentTime = 0; } catch (e) {}
        stage.classList.add("is-playing");
        activeAudioPreview = { audio: audEl, stage: stage, fill: scrubFill };
        audEl.play().catch(function () {});
      });
      card.addEventListener("mouseleave", function () {
        if (activeAudioPreview && activeAudioPreview.stage === stage) stopActiveAudioPreview();
      });
    } else {
      card.addEventListener("mouseenter", function () {
        var vUrl = stage.getAttribute("data-video");
        if (!vUrl) return;
        var vid = stage.querySelector("video.f2m-vid");
        if (!vid) {
          vid = document.createElement("video");
          vid.className = "f2m-vid";
          vid.muted = true;
          vid.loop = true;
          vid.playsInline = true;
          vid.autoplay = true;
          vid.src = vUrl;
          vid.addEventListener("timeupdate", function () {
            if (scrubFill && vid.duration > 0) {
              scrubFill.style.width = Math.min(100, (vid.currentTime / vid.duration) * 100).toFixed(1) + "%";
            }
          });
          vid.addEventListener("loadedmetadata", function () {
            if (scrubBar) scrubBar.classList.add("is-ready");
            if (isFinite(vid.duration) && vid.duration > 0) {
              item._duration = vid.duration;
              var b = stage.querySelector(".f2m-media-badge");
              if (b) b.textContent = formatMediaDuration(vid.duration);
            }
          });
          stage.appendChild(vid);
        }
        stage.classList.add("is-playing");
        vid.play().catch(function () {});
      });
      stage.addEventListener("mousemove", function (ev) {
        if (item.kind !== "video") return;
        var vid = stage.querySelector("video.f2m-vid");
        if (!vid || !isFinite(vid.duration) || vid.duration <= 0) return;
        var rect = stage.getBoundingClientRect();
        if (!rect || rect.width <= 0) return;
        var ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        try { vid.currentTime = ratio * vid.duration; } catch (e) {}
        if (scrubFill) scrubFill.style.width = (ratio * 100).toFixed(1) + "%";
      });
      card.addEventListener("mouseleave", function () {
        stage.classList.remove("is-playing");
        if (scrubFill) scrubFill.style.width = "0%";
        var vid = stage.querySelector("video.f2m-vid");
        if (vid) {
          try { vid.pause(); } catch (e) {}
          vid.remove();
        }
      });
    }

    if (item.kind === "mogrt" && !item._probed) {
      var obs = getMogrtObserver();
      if (obs) obs.observe(stage);
      else if (scanner) {
        item._probed = true;
        setTimeout(function () {
          try { applyMogrtPreview(item, stage, scanner.ensureMogrtPreview(item.file)); } catch (e) {}
        }, 0);
      }
    } else if (item.kind === "aep" && !item.thumb && !item.video && !item._probed) {
      var aepObs = getMogrtObserver();
      if (aepObs) aepObs.observe(stage);
      else { item._probed = true; enqueueAepPreview(item, stage); }
    }

    card.appendChild(stage);
    stage.appendChild(favoriteButton(item));

    var foot = el("div", "f2m-foot");
    var info = el("div", "f2m-info");
    info.appendChild(el("div", "f2m-title", item.name));
    info.appendChild(el("div", "f2m-sub", badgeLabel + " · " + item.category));
    foot.appendChild(info);
    card.appendChild(foot);

    stage.onclick = function (ev) {
      ev.stopPropagation();
      stopActiveAudioPreview();
      var chosen = (item.variants && item.variants[selectedVarIdx]) || null;
      applyTemplateItem(item, chosen);
    };

    return card;
  }

  function renderSubbar() {
    var subbar = document.getElementById("f2m-subbar");
    if (!subbar) return;
    subbar.innerHTML = "";
    subbar.hidden = true;

    if (state.tab === "templates") {
      subbar.hidden = false;
      var row = el("div", "f2m-subrow");
      var addBtn = iconButton("f2m-chip-act primary", "plus", "添加文件夹");
      addBtn.onclick = chooseTemplateDir;
      row.appendChild(addBtn);

      if (state.templateDirs.length) {
        var rescanBtn = iconButton("f2m-chip-act", "refresh", "刷新");
        rescanBtn.onclick = function () {
          rescanTemplates();
          log("已刷新本地目录（" + state.templates.length + " 项）", "ok");
          renderPanel();
        };
        row.appendChild(rescanBtn);

        var allPill = el("button", "f2m-dir-pill" + (state.templateDirFilter ? "" : " active"), "全部");
        allPill.type = "button";
        allPill.title = "显示所有导入目录";
        allPill.onclick = function () {
          state.templateDirFilter = null;
          state.currentSubDir = "";
          state.category = "全部";
          state.templatePageLimit = 48;
          renderPanel();
        };
        row.appendChild(allPill);

        state.templateDirs.forEach(function (dir) {
          var label = path ? path.basename(dir) : dir;
          var active = state.templateDirFilter === dir;
          var pill = el("span", "f2m-dir-pill" + (active ? " active" : ""));
          pill.title = active ? "取消「" + label + "」筛选" : "只看「" + label + "」";
          pill.setAttribute("role", "button");
          pill.tabIndex = 0;
          pill.appendChild(el("span", "", label));
          function toggleFilter(ev) {
            if (ev) ev.stopPropagation();
            state.templateDirFilter = active ? null : dir;
            state.currentSubDir = "";
            state.category = "全部";
            state.templatePageLimit = 48;
            renderPanel();
          }
          pill.onclick = toggleFilter;
          pill.onkeydown = function (ev) {
            if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleFilter(ev); }
          };
          var rmBtn = iconButton("f2m-dir-rm", "close", "", "移除目录");
          rmBtn.onkeydown = function (ev) { ev.stopPropagation(); };
          rmBtn.onclick = function (ev) {
            ev.stopPropagation();
            state.templateDirs = state.templateDirs.filter(function (d) { return d !== dir; });
            if (state.templateDirFilter === dir) {
              state.templateDirFilter = null;
              state.currentSubDir = "";
            }
            saveStoredDirs(state.templateDirs);
            rescanTemplates();
            renderPanel();
          };
          pill.appendChild(rmBtn);
          row.appendChild(pill);
        });
      }
      subbar.appendChild(row);

      // Breadcrumb navigation when browsing inside a subfolder (or into one of multiple mounted roots).
      var browseRoot = activeBrowseRoot();
      var showCrumbs = !!state.currentSubDir || (state.templateDirs.length > 1 && !!state.templateDirFilter);
      if (showCrumbs && browseRoot) {
        var crumbs = el("div", "f2m-crumbs");
        var backBtn = el("button", "f2m-crumb-back", "← 返回");
        backBtn.type = "button";
        backBtn.title = "返回上一级文件夹";
        backBtn.onclick = function () {
          if (state.currentSubDir) {
            var parts = state.currentSubDir.split("/");
            parts.pop();
            state.currentSubDir = parts.join("/");
          } else if (state.templateDirs.length > 1) {
            state.templateDirFilter = null;
          }
          state.category = "全部";
          state.templatePageLimit = 48;
          renderPanel();
        };
        crumbs.appendChild(backBtn);

        if (state.templateDirs.length > 1) {
          var allCrumb = el("button", "f2m-crumb-btn", "全部");
          allCrumb.type = "button";
          allCrumb.onclick = function () {
            state.templateDirFilter = null;
            state.currentSubDir = "";
            state.category = "全部";
            state.templatePageLimit = 48;
            renderPanel();
          };
          crumbs.appendChild(allCrumb);
          crumbs.appendChild(el("span", "f2m-crumb-sep", "/"));
        }

        var rootLabel = path ? path.basename(browseRoot) : browseRoot;
        var segs = state.currentSubDir ? state.currentSubDir.split("/") : [];
        if (segs.length === 0) {
          crumbs.appendChild(el("span", "f2m-crumb-cur", rootLabel));
        } else {
          var rootCrumb = el("button", "f2m-crumb-btn", rootLabel);
          rootCrumb.type = "button";
          rootCrumb.onclick = function () {
            state.currentSubDir = "";
            state.category = "全部";
            state.templatePageLimit = 48;
            renderPanel();
          };
          crumbs.appendChild(rootCrumb);
          for (var ci = 0; ci < segs.length; ci++) {
            crumbs.appendChild(el("span", "f2m-crumb-sep", "/"));
            if (ci === segs.length - 1) {
              crumbs.appendChild(el("span", "f2m-crumb-cur", segs[ci]));
            } else {
              (function (targetRel) {
                var sb = el("button", "f2m-crumb-btn", segs[ci]);
                sb.type = "button";
                sb.onclick = function () {
                  state.currentSubDir = targetRel;
                  state.category = "全部";
                  state.templatePageLimit = 48;
                  renderPanel();
                };
                crumbs.appendChild(sb);
              })(segs.slice(0, ci + 1).join("/"));
            }
          }
        }
        subbar.appendChild(crumbs);
      }

      if (state.dirInputOpen) {
        var form = el("div", "f2m-inline-form");
        var inp = el("input", "f2m-input");
        inp.type = "text";
        inp.placeholder = "粘贴本地文件夹路径，回车确认…";
        var ok = el("button", "f2m-chip-act primary", "确定");
        ok.type = "button";
        ok.onclick = function () { addTemplateDir(inp.value); };
        inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") addTemplateDir(inp.value); });
        form.appendChild(inp);
        form.appendChild(ok);
        subbar.appendChild(form);
      }
      return;
    }

    if (state.tab === "user") {
      subbar.hidden = false;
      var uRow = el("div", "f2m-subrow");

      var saveBtn = iconButton("f2m-chip-act primary", "plus", "保存选中动效");
      saveBtn.onclick = function () {
        state.saveFormOpen = !state.saveFormOpen;
        renderSubbar();
      };
      uRow.appendChild(saveBtn);

      var impBtn = iconButton("f2m-chip-act", "upload", "导入 JSON");
      impBtn.title = "从 JSON 文件导入动效；卡片右侧的下载按钮可把已有动效导出为 JSON";
      impBtn.onclick = importJsonDialog;
      uRow.appendChild(impBtn);
      subbar.appendChild(uRow);

      if (state.saveFormOpen) {
        var sForm = el("div", "f2m-inline-form");
        var nameInp = el("input", "f2m-input");
        nameInp.type = "text";
        nameInp.placeholder = "动效名称（如：卡片弹入）";
        var tagInp = el("input", "f2m-input is-tag");
        tagInp.type = "text";
        tagInp.placeholder = "标签（逗号分隔）";
        var goBtn = el("button", "f2m-chip-act primary", "保存");
        goBtn.type = "button";
        var doSave = function () {
          if (!nameInp.value.trim()) { report("请填写动效名称。", true); return; }
          commitSaveClip(nameInp.value.trim(), tagInp.value);
        };
        goBtn.onclick = doSave;
        nameInp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") doSave(); });
        sForm.appendChild(nameInp);
        sForm.appendChild(tagInp);
        sForm.appendChild(goBtn);
        subbar.appendChild(sForm);
        setTimeout(function () { nameInp.focus(); }, 0);
      }
    }
  }

  function renderGrid() {
    var grid = document.getElementById("f2m-grid");
    var catsEl = document.getElementById("f2m-cats");
    if (!grid || !catsEl) return;

    // Clear active RAF loops, audio audition and visibility tracking for old DOM nodes
    stopActiveAudioPreview();
    activeLoops.clear();
    visibleStages.clear();
    if (stageObserver) stageObserver.disconnect();
    grid.innerHTML = "";
    catsEl.innerHTML = "";

    var data = currentItemsAndCategories();
    if (data.categories.indexOf(state.category) < 0) {
      state.category = "全部";
      data = currentItemsAndCategories();
    }

    // Category filter pills
    if (data.categories.length > 1) {
      catsEl.hidden = false;
      data.categories.forEach(function (cat) {
        var pill = el("button", "f2m-cat" + (state.category === cat ? " active" : ""), cat);
        pill.type = "button";
        pill.onclick = function () {
          state.category = cat;
          state.templatePageLimit = 48;
          state.renameId = null;
          renderGrid();
        };
        catsEl.appendChild(pill);
      });
    } else {
      catsEl.hidden = true;
    }

    // Empty states
    if (!data.items.length) {
      var empty = el("div", "f2m-empty");
      if (state.tab === "templates" && !state.templateDirs.length) {
        empty.appendChild(el("div", "f2m-empty-title", "尚未挂载本地文件夹"));
        empty.appendChild(el("div", "f2m-empty-desc", "点击上方「添加文件夹」挂载本地目录，即可预览并导入视频、图片、音频、设计稿及 AEP / MOGRT / FFX。"));
      } else if (state.tab === "user" && !state.userClips.length) {
        empty.appendChild(el("div", "f2m-empty-title", "暂无自存动效"));
        empty.appendChild(el("div", "f2m-empty-desc", "在 AE 中选中已调好关键帧的图层，点击上方「保存选中动效」即可复用，并与 MCP 共享。"));
      } else if (state.category === "收藏") {
        empty.appendChild(el("div", "f2m-empty-title", "还没有收藏的项目"));
        empty.appendChild(el("div", "f2m-empty-desc", "点击预览图右上角的星标，即可把常用动效或素材收进这里。"));
      } else {
        empty.appendChild(el("div", "f2m-empty-title", state.tab === "templates" ? "没有匹配的本地文件" : "没有匹配的动效"));
        empty.appendChild(el("div", "f2m-empty-desc", "试试清空搜索关键词或切换分类。"));
      }
      grid.appendChild(empty);
      return;
    }

    var isTpl = state.tab === "templates";
    var isUser = state.tab === "user";
    var useFolderHierarchy = isTpl && state.category === "全部" && !state.query.trim();

    if (useFolderHierarchy) {
      var fragHier = document.createDocumentFragment();
      var browseRoot = activeBrowseRoot();
      if (!browseRoot) {
        // Multiple mounted folders on "全部": present each mounted folder as a top-level folder card.
        var counts = {};
        for (var k = 0; k < state.templates.length; k++) {
          var rd = state.templates[k].rootDir;
          counts[rd] = (counts[rd] || 0) + 1;
        }
        state.templateDirs.forEach(function (dir) {
          var label = path ? path.basename(dir) : dir;
          fragHier.appendChild(buildFolderCard({ name: label, rootDir: dir, relDir: "", count: counts[dir] || 0 }));
        });
        grid.appendChild(fragHier);
        return;
      }

      var level = listLevelLocal(folderFilteredTemplates(), state.currentSubDir);
      for (var fi = 0; fi < level.folders.length; fi++) {
        fragHier.appendChild(buildFolderCard(level.folders[fi]));
      }
      var fileSlice = level.files.slice(0, state.templatePageLimit);
      for (var fl = 0; fl < fileSlice.length; fl++) {
        fragHier.appendChild(buildTemplateCard(fileSlice[fl]));
      }
      grid.appendChild(fragHier);

      if (level.files.length > state.templatePageLimit) {
        var moreHier = el("div", "f2m-more-wrap");
        var moreHierBtn = el("button", "f2m-chip-act", "加载更多（剩余 " + (level.files.length - state.templatePageLimit) + " 项）");
        moreHierBtn.type = "button";
        moreHierBtn.onclick = function () {
          state.templatePageLimit += 60;
          renderGrid();
        };
        moreHier.appendChild(moreHierBtn);
        grid.appendChild(moreHier);
      }
      return;
    }

    var limit = isTpl ? state.templatePageLimit : data.items.length;
    var slice = data.items.slice(0, limit);

    var frag = document.createDocumentFragment();
    for (var i = 0; i < slice.length; i++) {
      frag.appendChild(isTpl ? buildTemplateCard(slice[i]) : buildMotionCard(slice[i], isUser));
    }
    grid.appendChild(frag);

    if (isTpl && data.items.length > limit) {
      var moreWrap = el("div", "f2m-more-wrap");
      var moreBtn = el("button", "f2m-chip-act", "加载更多（剩余 " + (data.items.length - limit) + " 项）");
      moreBtn.type = "button";
      moreBtn.onclick = function () {
        state.templatePageLimit += 60;
        renderGrid();
      };
      moreWrap.appendChild(moreBtn);
      grid.appendChild(moreWrap);
    }
  }

  function renderTabs() {
    var builtinCount = state.builtinClips.length + state.builtinPresets.length;
    var map = {
      builtin: "内置动效 (" + builtinCount + ")",
      templates: "本地文件 (" + folderFilteredTemplates().length + ")",
      user: "我的动效 (" + state.userClips.length + ")"
    };
    var btns = document.querySelectorAll(".f2m-tab");
    for (var i = 0; i < btns.length; i++) {
      var key = btns[i].getAttribute("data-tab");
      btns[i].textContent = map[key] || key;
      btns[i].className = "f2m-tab" + (state.tab === key ? " active" : "");
    }
  }

  function renderPanel() {
    renderTabs();
    renderSubbar();
    renderGrid();
  }

  // ---- Wire static DOM controls ----
  function bindControls() {
    var tabs = document.querySelectorAll(".f2m-tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].onclick = function () {
        state.tab = this.getAttribute("data-tab");
        state.category = "全部";
        state.confirmDeleteId = null;
        state.renameId = null;
        if (state.tab === "user") refreshUserClips();
        renderPanel();
      };
    }

    var search = document.getElementById("f2m-search");
    if (search) {
      search.addEventListener("input", function () {
        state.query = search.value;
        state.templatePageLimit = 48;
        state.renameId = null;
        renderGrid();
      });
    }

    var paramsToggle = document.getElementById("f2m-params-toggle");
    var paramsBox = document.getElementById("f2m-params");
    if (paramsToggle && paramsBox) {
      paramsToggle.onclick = function () {
        state.showParams = !state.showParams;
        paramsBox.hidden = !state.showParams;
        paramsToggle.className = "f2m-icon-act" + (state.showParams ? " active" : "");
      };
    }

    var playToggle = document.getElementById("f2m-play-toggle");
    function paintPlayToggle() {
      if (!playToggle) return;
      playToggle.innerHTML = "";
      playToggle.appendChild(svgIcon(state.autoPlayAll ? "pause" : "play"));
      playToggle.className = "f2m-icon-act is-square" + (state.autoPlayAll ? " active" : "");
      playToggle.title = state.autoPlayAll ? "切换为仅悬停预览" : "开启可视卡片自动循环预览";
    }
    paintPlayToggle();
    if (playToggle) {
      playToggle.onclick = function () {
        state.autoPlayAll = !state.autoPlayAll;
        paintPlayToggle();
        syncAllAutoPlay();
      };
    }


    // Parameter bindings
    function bindSelect(id, key, isNum) {
      var sel = document.getElementById(id);
      if (!sel) return;
      sel.value = String(state.params[key]);
      sel.onchange = function () {
        state.params[key] = isNum ? Number(sel.value) : sel.value;
        saveStoredParams(state.params);
        if (key === "direction" || key === "style") renderGrid();
      };
    }
    bindSelect("f2m-p-speed", "speed", true);
    bindSelect("f2m-p-dir", "direction", false);
    bindSelect("f2m-p-style", "style", false);
    bindSelect("f2m-p-anchor", "anchor", false);

    var repChk = document.getElementById("f2m-p-replace");
    if (repChk) {
      repChk.checked = !!state.params.replace;
      repChk.onchange = function () {
        state.params.replace = !!repChk.checked;
        saveStoredParams(state.params);
      };
    }

    // Collapsible motion library: the header strip stays, everything under it folds away.
    var shellEl = document.querySelector(".f2m-shell");
    var collapseBtn = document.getElementById("f2m-act-collapse");
    function paintCollapsed() {
      if (shellEl) shellEl.classList.toggle("is-collapsed", !!state.collapsed);
      if (collapseBtn) {
        var label = state.collapsed ? "展开动效库" : "折叠动效库";
        collapseBtn.title = label;
        collapseBtn.setAttribute("aria-label", label);
        collapseBtn.setAttribute("aria-expanded", String(!state.collapsed));
      }
    }
    paintCollapsed();
    if (collapseBtn) {
      collapseBtn.onclick = function () {
        state.collapsed = !state.collapsed;
        saveStoredCollapsed(state.collapsed);
        paintCollapsed();
        if (state.collapsed) {
          activeLoops.forEach(function (entry, stageEl) { stopStageLoop(stageEl, entry && entry.item); });
        } else {
          renderGrid();
        }
      };
    }

    // Collapsible log console toggle (keeps #mk-log and #mk-log-clear untouched)
    var logToggle = document.getElementById("f2m-log-toggle");
    var consoleSec = document.querySelector(".mk-console");
    if (logToggle && consoleSec) {
      logToggle.onclick = function () {
        var collapsed = consoleSec.classList.toggle("is-collapsed");
        logToggle.textContent = collapsed ? "展开" : "收起";
      };
    }
  }

  // ---- Boot ----
  function boot() {
    bindControls();
    refreshUserClips();
    if (state.templateDirs.length) rescanTemplates();
    loadBuiltinCatalog(function () {
      var total = state.builtinClips.length + state.builtinPresets.length;
      if (total) log("动效库已就绪：" + total + " 个内置动效" + (state.templates.length ? " · " + state.templates.length + " 个本地文件" : ""), "ok");
      renderPanel();
    });
  }

  window.F2AMotionPanel = {
    refreshUserClips: refreshUserClips,
    addTemplateDir: addTemplateDir,
    getState: function () { return state; }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
