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

  // figmaBridge loads after this file but may report before the log exists, so it calls this
  // guarded hook instead of the widget directly.
  window.MKReport = function (text, isErr) { logLine(text, isErr ? "err" : ""); };

  logLine("F2A 面板已加载", "ok");
})();
