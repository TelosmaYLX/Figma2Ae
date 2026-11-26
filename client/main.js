/* ===== f2a — panel logic ===== */
(function () {
  "use strict";

  // ---- Live log ------------------------------------------------------------
  // One timestamped line per event. The bridge modules report through MKReport, so the console
  // shows what they are doing from the first tick, including updater progress.
  var logList = document.getElementById("mk-log");
  var logCap = 200;
  function stamp(now) {
    return ("0" + now.getHours()).slice(-2) + ":" + ("0" + now.getMinutes()).slice(-2) + ":" + ("0" + now.getSeconds()).slice(-2);
  }
  function logLine(text, tone) {
    if (!logList) return;
    var line = document.createElement("div");
    line.className = "mk-log-line" + (tone ? " " + tone : "");
    var time = document.createElement("span");
    time.className = "mk-log-time";
    time.textContent = stamp(new Date());
    var body = document.createElement("span");
    body.className = "mk-log-text";
    body.textContent = String(text == null ? "" : text);   // AE and Figma text stays literal
    line.appendChild(time); line.appendChild(body);
    logList.appendChild(line);
    while (logList.children.length > logCap) logList.removeChild(logList.firstChild);
    logList.scrollTop = logList.scrollHeight;
  }
  window.MKLog = logLine;

  var clearLog = document.getElementById("mk-log-clear");
  if (clearLog && logList) clearLog.onclick = function () { logList.innerHTML = ""; };

  // ---- Resizable console ---------------------------------------------------
  // The log used to be pinned to a single 72px row, so a tall AE panel could never show more
  // than a few lines. Its top grip drags the console taller or shorter; the height is clamped
  // so the motion library and status bars keep their space, and it is remembered next launch.
  var logConsoleEl = typeof document.querySelector === "function" ? document.querySelector(".mk-console") : null;
  var logResize = document.getElementById("mk-log-resize");
  var LOG_HEIGHT_DEFAULT = 72, LOG_HEIGHT_MIN = 56, LOG_HEIGHT_RESERVED = 200;
  var LOG_HEIGHT_KEY = "f2a.logHeight";
  var logHeight = LOG_HEIGHT_DEFAULT;

  function logHeightMax() {
    if (!logConsoleEl || typeof logConsoleEl.getBoundingClientRect !== "function") return LOG_HEIGHT_MIN;
    var rect = logConsoleEl.getBoundingClientRect();
    if (!rect || !isFinite(rect.bottom)) return LOG_HEIGHT_MIN;
    return Math.max(LOG_HEIGHT_MIN, Math.round(rect.bottom - LOG_HEIGHT_RESERVED));
  }
  function paintLogHeight(height) {
    var next = Math.max(LOG_HEIGHT_MIN, Math.min(logHeightMax(), Math.round(height)));
    logHeight = next;
    if (logConsoleEl && logConsoleEl.style && logConsoleEl.style.setProperty)
      logConsoleEl.style.setProperty("--log-height", next + "px");
    if (logResize && logResize.setAttribute) {
      logResize.setAttribute("aria-valuenow", String(next));
      logResize.setAttribute("aria-valuemin", String(LOG_HEIGHT_MIN));
      logResize.setAttribute("aria-valuemax", String(logHeightMax()));
    }
    return next;
  }
  function storeLogHeight() {
    try { if (typeof localStorage !== "undefined") localStorage.setItem(LOG_HEIGHT_KEY, String(logHeight)); } catch (e) {}
  }
  function storedLogHeight() {
    try {
      if (typeof localStorage !== "undefined") {
        var raw = Number(localStorage.getItem(LOG_HEIGHT_KEY));
        if (isFinite(raw) && raw > 0) return raw;
      }
    } catch (e) {}
    return LOG_HEIGHT_DEFAULT;
  }

  if (logConsoleEl && logResize && typeof logResize.addEventListener === "function" && typeof window.addEventListener === "function") {
    var logDrag = null;
    function moveLogDrag(ev) {
      if (!logDrag) return;
      paintLogHeight(logDrag.height + (logDrag.y - ev.clientY));
      if (ev.preventDefault) ev.preventDefault();
    }
    function endLogDrag() {
      if (!logDrag) return;
      logDrag = null;
      if (logConsoleEl.classList) logConsoleEl.classList.remove("is-resizing");
      storeLogHeight();
      window.removeEventListener("pointermove", moveLogDrag, false);
      window.removeEventListener("pointerup", endLogDrag, false);
      window.removeEventListener("pointercancel", endLogDrag, false);
    }
    // Drag tracking lives on the window, so the pointer keeps resizing the log even when it
    // leaves the 8px grip or the pointer id cannot be captured in the CEP host.
    logResize.addEventListener("pointerdown", function (ev) {
      if ((ev.button != null && ev.button !== 0) ||
          (logConsoleEl.classList && logConsoleEl.classList.contains("is-collapsed"))) return;
      var rect = logConsoleEl.getBoundingClientRect();
      logDrag = { y: ev.clientY, height: rect && isFinite(rect.height) ? rect.height : logHeight };
      if (logConsoleEl.classList) logConsoleEl.classList.add("is-resizing");
      window.addEventListener("pointermove", moveLogDrag, false);
      window.addEventListener("pointerup", endLogDrag, false);
      window.addEventListener("pointercancel", endLogDrag, false);
      if (ev.preventDefault) ev.preventDefault();
    });
    logResize.addEventListener("dblclick", function () {
      paintLogHeight(LOG_HEIGHT_DEFAULT);
      storeLogHeight();
    });
    logResize.addEventListener("keydown", function (ev) {
      if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
      paintLogHeight(logHeight + (ev.key === "ArrowUp" ? (ev.shiftKey ? 48 : 16) : (ev.shiftKey ? -48 : -16)));
      storeLogHeight();
      if (ev.preventDefault) ev.preventDefault();
    });
    window.addEventListener("resize", function () {
      if (!logDrag) paintLogHeight(logHeight);
    }, false);
    paintLogHeight(storedLogHeight());
  }

  // CEP's embedded Chromium context menu is oversized and only offers browser commands
  // (back / reload / print), which do not belong in the panel. Suppress it everywhere so a
  // right-click in the motion library cannot open that large native menu.
  document.addEventListener("contextmenu", function (ev) {
    ev.preventDefault();
  }, false);

  // figmaBridge loads after this file but may report before the log exists, so it calls this
  // guarded hook instead of the widget directly.
  window.MKReport = function (text, isErr) { logLine(text, isErr ? "err" : ""); };

  logLine("F2A 面板已加载", "ok");
})();
