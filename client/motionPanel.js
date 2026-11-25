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
    var def = { speed: 1, stagger: 0.06, direction: "up", style: "snappy", anchor: "auto", replace: true };
    try {
      var raw = localStorage.getItem(LS_PARAMS);
      return raw ? Object.assign(def, JSON.parse(raw)) : def;
    } catch (e) { return def; }
  }
  function saveStoredParams(p) {
    try { localStorage.setItem(LS_PARAMS, JSON.stringify(p)); } catch (e) {}
  }

  var state = {
    tab: "builtin",            // "builtin" | "templates" | "user"
    category: "全部",
    query: "",
    autoPlayAll: false,        // Off by default: cards stay still until hovered (or the play toggle is used)
    showParams: false,
    params: loadStoredParams(),
    builtinPresets: [],
    builtinClips: [],
    userClips: [],
    templateDirs: loadStoredDirs(),
    templates: [],
    templatePageLimit: 48,
    selection: { hasComp: false, compName: "", time: 0, selected: [] },
    recording: null,           // { snapshotFile, snapshot, startedAt }
    saveFormOpen: false,
    dirInputOpen: false,
    confirmDeleteId: null
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
        for (var j = 0; j < list.length; j++) all.push(list[j]);
      } catch (e) {
        log("扫描模板目录失败：" + e.message, "err");
      }
    }
    state.templates = all;
    state.templatePageLimit = 48;
  }

  // ---- AE Selection polling ----
  var selPollTimer = null;
  function refreshSelection(silent) {
    if (!CEP) {
      state.selection = { hasComp: false, compName: "预览模式", time: 0, selected: [] };
      renderSelectionBar();
      return;
    }
    evalES("mkMotionGetSelectionInfo()", function (raw) {
      var res = parseEsJson(raw);
      if (res && res.ok) {
        state.selection = res;
      } else if (!silent && res && res.error) {
        log(res.error, "err");
      }
      renderSelectionBar();
    });
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
    var u = res.progress;
    if (res.transType === "iris") {
      var ring = stageEl.querySelector(".f2m-trans-iris");
      if (!ring) return;
      // Grows 0..0.5 to cover, then opens 0.5..1 via shrinking border
      var s = u <= 0.5 ? (u * 2) : 1;
      var hole = u <= 0.5 ? 0 : ((u - 0.5) * 2);
      ring.style.transform = "scale(" + (0.05 + s * 1.45).toFixed(3) + ")";
      ring.style.borderWidth = ((1 - hole) * 38).toFixed(1) + "px";
      ring.style.opacity = u > 0.96 || u < 0.02 ? "0" : "0.95";
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
      var grow = Math.min(1, u / 0.35);
      flashBar.style.transform = "scale(" + (0.08 + 1.15 * grow).toFixed(3) + ")";
      flashBar.style.opacity = String(u <= 0.5 ? 1 : Math.max(0, 1 - (u - 0.5) / 0.5).toFixed(3));
      return;
    }
    if (res.transType === "split" || res.transType === "shutter") {
      var panels = stageEl.querySelectorAll(".f2m-trans-bar");
      var axis = res.transType === "split" ? "translateX" : "translateY";
      for (var pi = 0; pi < panels.length; pi++) {
        // panel 0 enters from the start side, panel 1 mirrors it; both meet at 0% on the cut
        var pdir = pi === 0 ? -1 : 1;
        var pt = pdir * (105 - 210 * u);
        panels[pi].style.transform = axis + "(" + pt.toFixed(1) + "%)";
      }
      return;
    }
    var bars = stageEl.querySelectorAll(".f2m-trans-bar");
    var horiz = res.direction === "left" || res.direction === "right";
    var sign = (res.direction === "left" || res.direction === "up") ? -1 : 1;
    for (var i = 0; i < bars.length; i++) {
      var delay = bars.length > 1 ? (i / (bars.length - 1)) * 0.22 : 0;
      var bu = Math.max(0, Math.min(1, (u - delay) / (1 - 0.22)));
      var pct = -sign * 105 + sign * 210 * bu;
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
    var stagger = Number(state.params.stagger) || 0;
    var replaceTracks = !!state.params.replace;

    if (item.clip) {
      var anchor = state.params.anchor === "auto" ? (item.defaultAnchor || "end") : state.params.anchor;
      var jobPath = writeJobTemp({
        name: item.name,
        clip: item.clip,
        time_scale: timeScale,
        stagger: stagger,
        position_anchor: anchor,
        scale_relative: true,
        replaceTracks: replaceTracks
      }, "clip");
      evalES("mkMotionApplyClip(" + esLiteral(jobPath) + ")", function (raw) {
        var res = parseEsJson(raw);
        if (res.ok) {
          log("已应用「" + item.name + "」→ " + res.layers + " 层（" + res.tracks + " 条轨道，单步可撤销）", "ok");
          refreshSelection(true);
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
      if (item.supports && item.supports.stagger && stagger > 0) opts.stagger = stagger;
      var presetPath = writeJobTemp({
        name: item.name,
        command: item.command,
        options: opts,
        layerStagger: stagger,
        replaceTracks: replaceTracks
      }, "preset");
      evalES("mkMotionApplyPreset(" + esLiteral(presetPath) + ")", function (raw) {
        var res = parseEsJson(raw);
        if (res.ok) {
          var n = res.result && (res.result.layers || res.result.staggered);
          log("已应用「" + item.name + "」" + (n ? "→ " + n + " 层" : "") + "（单步可撤销）", "ok");
          refreshSelection(true);
        } else {
          report("应用「" + item.name + "」失败：" + res.error, true);
        }
      });
    }
  }

  function applyTemplateItem(item, chosenVariant) {
    if (!CEP) {
      log("预览模式：已模拟导入模板「" + item.name + "」", "ok");
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
          } else {
            log("已导入模板合成「" + (res.compName || item.name) + "」到当前时间轴", "ok");
          }
          refreshSelection(true);
        } else {
          report("导入「" + item.name + "」失败：" + res.error, true);
        }
      });
    } catch (e) {
      report("模板处理失败：" + e.message, true);
    }
  }

  function runQuickStagger() {
    if (!CEP) { log("预览模式：错峰交错", "ok"); return; }
    var off = Number(state.params.stagger) > 0 ? Number(state.params.stagger) : 0.06;
    var jobPath = writeJobTemp({
      name: "错峰交错",
      command: "stagger",
      options: { offset_seconds: off, order: "forward" }
    }, "stagger");
    evalES("mkMotionApplyPreset(" + esLiteral(jobPath) + ")", function (raw) {
      var res = parseEsJson(raw);
      if (res.ok) log("已错峰交错 " + res.result.layers + " 层（间隔 " + off + "s）", "ok");
      else report("错峰失败：" + res.error, true);
    });
  }

  function runQuickReset() {
    if (!CEP) { log("预览模式：重置选中图层动效", "ok"); return; }
    evalES("mkMotionResetSelected()", function (raw) {
      var res = parseEsJson(raw);
      if (res.ok) {
        log("已清理 " + res.layers + " 层的 " + res.cleared + " 条动效轨道（可 Ctrl+Z 撤销）", "ok");
        refreshSelection(true);
      } else {
        report("重置失败：" + res.error, true);
      }
    });
  }

  // ---- User Clip Save / Record / Import ----
  function captureFromAE(includeStatic, cb) {
    if (!CEP) { cb(new Error("请在 AE 中使用捕获/录制功能。")); return; }
    var snapFile = path.join(os.tmpdir(), "f2a_snap_" + Date.now() + "_" + (++tempSerial) + ".json");
    var jobPath = writeJobTemp({
      scope: "all",
      includeStatic: !!includeStatic,
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

  function startRecording() {
    captureFromAE(true, function (err, snap) {
      if (err) { report("开始录制失败：" + err.message, true); return; }
      state.recording = { snapshot: snap, startedAt: Date.now() };
      log("开始录制「" + snap.name + "」的 " + snap.layers.length + " 层动效，请在 AE 中调整后点击“停止并保存”", "ok");
      renderPanel();
    });
  }

  function commitSaveClip(name, tagsText) {
    if (!scanner) { report("本地动效存储模块不可用。", true); return; }
    var tags = String(tagsText || "").split(/[,，\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var rec = state.recording;
    if (rec) {
      // Capture "after" for same comp/layers and diff
      var snapFile = path.join(os.tmpdir(), "f2a_snap_after_" + Date.now() + "_" + (++tempSerial) + ".json");
      var jobPath = writeJobTemp({
        comp_id: rec.snapshot.comp,
        layer_ids: rec.snapshot.layers.map(function (l) { return l.id; }),
        scope: "all",
        includeStatic: true,
        snapshotFile: snapFile.replace(/\\/g, "/")
      }, "capture");
      evalES("mkMotionCaptureSelected(" + esLiteral(jobPath) + ")", function (raw) {
        var res = parseEsJson(raw);
        if (!res.ok) { report("读取录制结果失败：" + res.error, true); return; }
        try {
          var after = JSON.parse(fs.readFileSync(snapFile, "utf8").replace(/^\uFEFF/, ""));
          try { fs.unlinkSync(snapFile); } catch (eRm) {}
          var built = scanner.makeClipFromSnapshots(after, rec.snapshot);
          var saved = scanner.saveUserClip(name, tags, built.clip);
          state.recording = null;
          state.saveFormOpen = false;
          refreshUserClips();
          log("已保存录制动效「" + saved.name + "」（" + saved.clip.duration.toFixed(2) + "s）", "ok");
          renderPanel();
        } catch (eSave) {
          report("保存录制动效失败：" + eSave.message, true);
        }
      });
      return;
    }

    captureFromAE(false, function (err, snap) {
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
    rescanTemplates();
    log("已挂载本地模板目录（共发现 " + state.templates.length + " 个模板/预设）", "ok");
    renderPanel();
  }

  function chooseTemplateDir() {
    if (window.cep && window.cep.fs && window.cep.fs.showOpenDialogEx) {
      var pick = window.cep.fs.showOpenDialogEx(false, true, "选择本地动效模板目录（支持 AEP / MOGRT / FFX）", "", []);
      if (pick.err) { report("打开目录窗口失败（" + pick.err + "）", true); return; }
      if (pick.data && pick.data[0]) addTemplateDir(pick.data[0]);
    } else {
      state.dirInputOpen = !state.dirInputOpen;
      renderPanel();
    }
  }

  // ---- Lazy MOGRT Thumbnail Observer ----
  var mogrtObserver = null;
  function getMogrtObserver() {
    if (mogrtObserver || typeof IntersectionObserver === "undefined") return mogrtObserver;
    mogrtObserver = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isIntersecting) continue;
        var stage = entries[i].target;
        mogrtObserver.unobserve(stage);
        var item = stage._f2mTemplate;
        if (!item || item.kind !== "mogrt" || item._probed || !scanner) continue;
        item._probed = true;
        try {
          var prev = scanner.ensureMogrtPreview(item.file);
          item.thumb = prev.thumb;
          item.video = prev.video;
          if (item.thumb) {
            var img = stage.querySelector(".f2m-thumb");
            if (img) {
              img.src = fileUrl(item.thumb);
              img.hidden = false;
              var ph = stage.querySelector(".f2m-media-placeholder");
              if (ph) ph.hidden = true;
            }
          }
          if (item.video) stage.setAttribute("data-video", fileUrl(item.video));
        } catch (e) {}
      }
    }, { rootMargin: "120px" });
    return mogrtObserver;
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
    } else if (name === "record") {
      add("circle", { cx: "8", cy: "8", r: "4.2", fill: "currentColor" });
    } else if (name === "stop") {
      add("rect", { x: "4.2", y: "4.2", width: "7.6", height: "7.6", rx: "1.2", fill: "currentColor" });
    } else if (name === "upload") {
      add("path", { d: "M8 10.8V3.2M5 6l3-3 3 3M3 12.8h10", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" });
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

  function renderSelectionBar() {
    var textEl = document.getElementById("f2m-ctx-text");
    var dotEl = document.getElementById("f2m-ctx-dot");
    if (!textEl || !dotEl) return;
    var s = state.selection;
    if (!s || !s.hasComp) {
      dotEl.className = "f2m-ctx-dot off";
      textEl.textContent = CEP ? "未打开活动合成" : "预览模式 · 内置动效可实时悬停预览";
      return;
    }
    var n = s.selected ? s.selected.length : 0;
    dotEl.className = "f2m-ctx-dot " + (n > 0 ? "on" : "idle");
    var tStr = (Math.round((s.time || 0) * 100) / 100).toFixed(2) + "s";
    if (n === 0) {
      textEl.textContent = s.compName + " · 未选中图层 · " + tStr;
    } else if (n === 1) {
      textEl.textContent = "已选「" + s.selected[0].name + "」· " + tStr;
    } else {
      textEl.textContent = s.compName + " · 已选 " + n + " 层 · " + tStr;
    }
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
      for (var t = 0; t < state.templates.length; t++) addCat(state.templates[t].category);
      all = state.templates;
    } else {
      all = state.userClips;
    }

    var filtered = all.filter(function (item) {
      if (state.category !== "全部" && item.category !== state.category) return false;
      if (!q) return true;
      var hay = [
        item.name || "",
        item.category || "",
        item.pack || "",
        item.description || "",
        Array.isArray(item.tags) ? item.tags.join(" ") : ""
      ].join(" ").toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    return { items: orderDirectionItems(filtered), categories: ["全部"].concat(catSet), total: all.length };
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
      mark.setAttribute("viewBox", "0 0 24 24");
      mark.setAttribute("aria-hidden", "true");
      var p1 = document.createElementNS(ns, "path");
      p1.setAttribute("d", "M6 5h12v3.6H9.8v3.1h6.4v3.4H9.8V19H6V5z");
      p1.setAttribute("fill", "#f4f1ff");
      var p2 = document.createElementNS(ns, "circle");
      p2.setAttribute("cx", "17.2");
      p2.setAttribute("cy", "17.2");
      p2.setAttribute("r", "2.2");
      p2.setAttribute("fill", "#a78bfa");
      mark.appendChild(p1);
      mark.appendChild(p2);
      box.appendChild(mark);
      stage.appendChild(box);
    }

    card.appendChild(stage);

    // Footer metadata (duration & track info live here instead of crowding the stage)
    var foot = el("div", "f2m-foot");
    var info = el("div", "f2m-info");
    info.appendChild(el("div", "f2m-title", item.name));
    var durVal = item.clip ? item.clip.duration : ((item.defaults && item.defaults.duration) || 0.5);
    var durStr = (Math.round(durVal * 100) / 100) + "s";
    var kindText = meta && meta.trackNames.length
      ? meta.trackNames.join(" / ")
      : (item.kind === "procedural" ? (item.category || "参数") : "动效");
    info.appendChild(el("div", "f2m-sub", durStr + " · " + kindText));
    foot.appendChild(info);

    if (isUser) {
      var actions = el("div", "f2m-actions");
      var delBtn = state.confirmDeleteId === item.id
        ? el("button", "f2m-del is-confirm", "确认")
        : iconButton("f2m-del", "close", "", "删除此动效");
      delBtn.type = "button";
      delBtn.onclick = function (ev) {
        ev.stopPropagation();
        if (state.confirmDeleteId !== item.id) {
          state.confirmDeleteId = item.id;
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

  function buildTemplateCard(item) {
    var card = el("div", "f2m-card is-tpl");
    card.title = item.pack + " / " + item.category + " / " + item.name;

    var selectedVarIdx = 0;
    var stage = el("div", "f2m-stage is-media is-applyable");
    stage._f2mTemplate = item;
    stage.title = "点击" + (item.kind === "ffx" ? "应用" : "导入") + "「" + item.name + "」";

    var img = el("img", "f2m-thumb");
    img.alt = item.name;
    if (item.thumb) {
      img.src = fileUrl(item.thumb);
    } else {
      img.hidden = true;
    }
    stage.appendChild(img);

    if (!item.thumb) {
      var ph = el("div", "f2m-media-placeholder", item.kind === "ffx" ? "FX" : (item.kind === "mogrt" ? "MOGRT" : "AEP"));
      stage.appendChild(ph);
    }

    var activeVideoUrl = item.video ? fileUrl(item.video) : "";
    if (activeVideoUrl) stage.setAttribute("data-video", activeVideoUrl);

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

    // Hover plays real MP4 preview video!
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
        stage.appendChild(vid);
      }
      vid.play().catch(function () {});
    });
    card.addEventListener("mouseleave", function () {
      var vid = stage.querySelector("video.f2m-vid");
      if (vid) {
        try { vid.pause(); } catch (e) {}
        vid.remove();
      }
    });

    if (item.kind === "mogrt" && !item._probed) {
      var obs = getMogrtObserver();
      if (obs) obs.observe(stage);
    }

    card.appendChild(stage);

    var foot = el("div", "f2m-foot");
    var info = el("div", "f2m-info");
    info.appendChild(el("div", "f2m-title", item.name));
    info.appendChild(el("div", "f2m-sub", item.kind.toUpperCase() + " · " + item.category));
    foot.appendChild(info);
    card.appendChild(foot);

    stage.onclick = function (ev) {
      ev.stopPropagation();
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
      var addBtn = iconButton("f2m-chip-act primary", "plus", "添加模板目录");
      addBtn.onclick = chooseTemplateDir;
      row.appendChild(addBtn);

      if (state.templateDirs.length) {
        var rescanBtn = iconButton("f2m-chip-act", "refresh", "刷新");
        rescanBtn.onclick = function () {
          rescanTemplates();
          log("已刷新本地模板目录（" + state.templates.length + " 项）", "ok");
          renderPanel();
        };
        row.appendChild(rescanBtn);

        state.templateDirs.forEach(function (dir) {
          var label = path ? path.basename(dir) : dir;
          var pill = el("span", "f2m-dir-pill");
          pill.title = dir;
          pill.appendChild(el("span", "", label));
          var rmBtn = iconButton("f2m-dir-rm", "close", "", "移除目录");
          rmBtn.onclick = function () {
            state.templateDirs = state.templateDirs.filter(function (d) { return d !== dir; });
            saveStoredDirs(state.templateDirs);
            rescanTemplates();
            renderPanel();
          };
          pill.appendChild(rmBtn);
          row.appendChild(pill);
        });
      }
      subbar.appendChild(row);

      if (state.dirInputOpen) {
        var form = el("div", "f2m-inline-form");
        var inp = el("input", "f2m-input");
        inp.type = "text";
        inp.placeholder = "粘贴本地模板目录路径，回车确认…";
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

      var saveBtn = iconButton(
        "f2m-chip-act primary",
        state.recording ? "stop" : "plus",
        state.recording ? "停止并保存" : "保存选中动效"
      );
      saveBtn.onclick = function () {
        state.saveFormOpen = !state.saveFormOpen;
        renderSubbar();
      };
      uRow.appendChild(saveBtn);

      if (!state.recording) {
        var recBtn = iconButton("f2m-chip-act", "record", "开始录制", "记录当前状态，在 AE 中手调动效后再保存增量变更");
        recBtn.onclick = startRecording;
        uRow.appendChild(recBtn);
      } else {
        var cancelRec = el("button", "f2m-chip-act danger", "取消录制");
        cancelRec.type = "button";
        cancelRec.onclick = function () {
          state.recording = null;
          state.saveFormOpen = false;
          log("已取消动效录制");
          renderPanel();
        };
        uRow.appendChild(cancelRec);
      }

      var impBtn = iconButton("f2m-chip-act", "upload", "导入 JSON");
      impBtn.onclick = importJsonDialog;
      uRow.appendChild(impBtn);
      subbar.appendChild(uRow);

      if (state.saveFormOpen) {
        var sForm = el("div", "f2m-inline-form");
        var nameInp = el("input", "f2m-input");
        nameInp.type = "text";
        nameInp.placeholder = state.recording ? "录制动效名称（必填）" : "动效名称（如：卡片弹入）";
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

    // Clear active RAF loops and visibility tracking for old DOM nodes
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
        empty.appendChild(el("div", "f2m-empty-title", "尚未挂载本地模板目录"));
        empty.appendChild(el("div", "f2m-empty-desc", "添加本地动效数据包后，可直接预览视频缩略图并一键导入 AEP / MOGRT / FFX。"));
        var cta = iconButton("f2m-chip-act primary", "plus", "选择本地模板目录");
        cta.onclick = chooseTemplateDir;
        empty.appendChild(cta);
      } else if (state.tab === "user" && !state.userClips.length) {
        empty.appendChild(el("div", "f2m-empty-title", "暂无自存动效"));
        empty.appendChild(el("div", "f2m-empty-desc", "在 AE 中选中已调好关键帧的图层，点击上方「保存选中动效」即可复用，并与 MCP 共享。"));
      } else {
        empty.appendChild(el("div", "f2m-empty-title", "没有匹配的动效"));
        empty.appendChild(el("div", "f2m-empty-desc", "试试清空搜索关键词或切换分类。"));
      }
      grid.appendChild(empty);
      return;
    }

    var isTpl = state.tab === "templates";
    var isUser = state.tab === "user";
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
      templates: "本地模板 (" + state.templates.length + ")",
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
    renderSelectionBar();
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
        if (state.tab === "user") refreshUserClips();
        renderPanel();
      };
    }

    var search = document.getElementById("f2m-search");
    if (search) {
      search.addEventListener("input", function () {
        state.query = search.value;
        state.templatePageLimit = 48;
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

    var staggerBtn = document.getElementById("f2m-act-stagger");
    if (staggerBtn) staggerBtn.onclick = runQuickStagger;
    var resetBtn = document.getElementById("f2m-act-reset");
    if (resetBtn) resetBtn.onclick = runQuickReset;
    var refreshBtn = document.getElementById("f2m-act-refresh");
    if (refreshBtn) refreshBtn.onclick = function () { refreshSelection(false); };

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
    bindSelect("f2m-p-stagger", "stagger", true);
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
      if (total) log("动效库已就绪：" + total + " 个内置动效" + (state.templates.length ? " · " + state.templates.length + " 个本地模板" : ""), "ok");
      renderPanel();
    });
    refreshSelection(true);
    if (CEP) {
      window.addEventListener("focus", function () { refreshSelection(true); });
      selPollTimer = setInterval(function () {
        if (!document.hidden) refreshSelection(true);
      }, 2500);
    }
  }

  window.F2AMotionPanel = {
    refreshSelection: refreshSelection,
    refreshUserClips: refreshUserClips,
    addTemplateDir: addTemplateDir,
    getState: function () { return state; }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
