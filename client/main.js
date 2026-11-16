/* ===== f2a — panel logic ===== */
(function () {
  "use strict";

  // ---- ExtendScript bridge (CEP) with browser-preview fallback ----
  var CEP = (typeof window.__adobe_cep__ !== "undefined");
  function run(jsx, label) {
    if (CEP) {
      window.__adobe_cep__.evalScript(jsx, function (res) {
        if (res && /error|undefined function|is not defined/i.test(String(res))) {
          toast(label + ": " + res, true);
        } else {
          toast(label);
        }
      });
    } else {
      // preview mode in a normal browser
      toast("[预览] " + label + "  →  " + jsx);
      console.log("evalScript:", jsx);
    }
  }

  // ---- Tool model. Each item: label, icon, and either .jsx (action) or .items (popup) ----
  // This panel only carries the Figma → AE entry point. The AE motion-toolkit groups
  // (文本/动画/转场/交互/元素/背景/绑定) are not part of this panel; host/f2a.jsx keeps
  // the ExtendScript they called for scripts that still need it.
  var GROUPS = [
    { label: "SVG 导入", grid: 1, items: [
      { label: "导入 SVG 文件", icon: "\u25c6", fn: "manualImport" }
    ]}
  ];


  // ---- Rendering ----
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function makeButton(item) {
    var b = el("button", "mk-btn" + (item.primary ? " primary" : "") + (item.items ? " has-more" : ""));
    var ic = el("span", "ic", item.icon || "▸");
    var lbl = el("span", "lbl", item.label);
    b.appendChild(ic); b.appendChild(lbl);
    if (item.items) {
      var chev = el("span", "chev", "▾");
      b.appendChild(chev);
      b.addEventListener("click", function () {
        openPopup(item);
      });
    } else if (item.fn) {
      // panel-side action handled by a module (e.g. Figma bridge), not ExtendScript
      b.addEventListener("click", function () {
        if (window.MKFigma && typeof window.MKFigma[item.fn] === "function") window.MKFigma[item.fn]();
        else toast(item.label + "：模块未加载", true);
      });
    } else {
      b.addEventListener("click", function () {
        run(item.jsx, item.label);
      });
    }
    return b;
  }

  function render() {
    var main = document.getElementById("mk-main");
    main.innerHTML = "";
    GROUPS.forEach(function (g) {
      var grp = el("section", "mk-group");
      grp.appendChild(el("div", "mk-group-label", g.label));
      var grid = el("div", "mk-grid" + (g.grid === 1 ? " one" : ""));
      g.items.forEach(function (it) { grid.appendChild(makeButton(it)); });
      grp.appendChild(grid);
      main.appendChild(grp);
    });
  }

  // ---- Popup ----
  var overlay = document.getElementById("mk-overlay");
  var popTitle = document.getElementById("mk-popup-title");
  var popBody = document.getElementById("mk-popup-body");

  function openPopup(item) {
    popTitle.textContent = item.pop || item.label;
    popBody.innerHTML = "";
    popBody.className = "mk-popup-body" + (item.grid === 1 ? " one" : "");
    item.items.forEach(function (sub) {
      var b = el("button", "mk-btn");
      b.appendChild(el("span", "ic", sub.icon || "▸"));
      b.appendChild(el("span", "lbl", sub.label));
      b.addEventListener("click", function () { run(sub.jsx, sub.label); closePopup(); });
      popBody.appendChild(b);
    });
    overlay.hidden = false;
  }
  function closePopup() { overlay.hidden = true; }

  document.getElementById("mk-popup-close").addEventListener("click", closePopup);
  overlay.addEventListener("click", function (e) { if (e.target === overlay) closePopup(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePopup(); });

  // ---- Live log ------------------------------------------------------------
  // One timestamped line per event. figmaBridge reports progress through MKToast/MKLog, so the
  // console shows what the bridge is doing even when the Figma panel is out of sight.
  var logList = document.getElementById("mk-log");
  var logCap = 200;
  function stamp(now) {
    return ("0" + now.getHours()).slice(-2) + ":" + ("0" + now.getMinutes()).slice(-2) + ":" + ("0" + now.getSeconds()).slice(-2);
  }
  function logLine(text, tone) {
    if (!logList) return;
    var line = document.createElement("div");
    line.className = "mk-log-line" + (tone ? " " + tone : "");
    var time = el("span", "mk-log-time");
    time.textContent = stamp(new Date());
    line.appendChild(time);
    var body = el("span", "mk-log-text");
    body.textContent = String(text == null ? "" : text);   // AE and Figma text stays literal
    line.appendChild(body);
    logList.appendChild(line);
    while (logList.children.length > logCap) logList.removeChild(logList.firstChild);
    logList.scrollTop = logList.scrollHeight;
  }
  window.MKLog = logLine;
  var clearLog = document.getElementById("mk-log-clear");
  if (clearLog && logList) clearLog.onclick = function () { logList.innerHTML = ""; };

  // ---- Toast ----
  var statusEl = document.getElementById("mk-status");
  var tmr = null;
  function toast(msg, isErr) {
    statusEl.textContent = msg;
    statusEl.className = "mk-status show" + (isErr ? " err" : "");
    if (tmr) clearTimeout(tmr);
    tmr = setTimeout(function () { statusEl.className = "mk-status"; }, isErr ? 4200 : 1800);
    logLine(msg, isErr ? "err" : "");
  }

  // expose toast so the Figma bridge module can report status through the same UI
  window.MKToast = toast;

  logLine("F2A 面板已加载", "ok");
  render();
})();
