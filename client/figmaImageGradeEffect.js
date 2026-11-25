'use strict';

/* ===== Figma 调色 effect (F2A Figma Image Grade) =====
 * The native AE plug-in that reproduces Figma's seven image-fill filters. The export
 * prefers it over the LUT grade graph: the effect goes on the element's outer precomp
 * and carries Figma's values directly, so the animator can keyframe it.
 *
 * When the plug-in is not in the user's After Effects install the packaged
 * FigmaImageGrade.aex is copied into <AE>/Support Files/Plug-ins/F2A/. The installers do
 * the same copy up front, so pulling an update is enough on a normal machine. Only when
 * that is impossible (AE not found, install folder read-only) does the caller fall back to
 * the LUT grade that scripts/aep/image_grade.py builds.
 *
 * The plug-in only uses long-standing effect APIs; it was verified in After Effects
 * CC 2019 (16.1.3) and AE 2026, so every AE release F2A exports for (2024–2026) loads
 * it. AE releases older than CC 2019 are not touched, and an AEP target older than that
 * (never produced by F2A) would stay on the LUT path.
 *
 * This module is plain Node: the CEP panel uses it for the live import, scripts/
 * export-aep.cjs for the offline AEP writer. `F2A_AE_PLUGINS` overrides the discovered
 * plug-in folders (semicolon separated) and `F2A_IMAGE_GRADE_MODE=lut|effect` forces a
 * mode; tests use both.
 */

var fs = require('fs');
var path = require('path');
var execFileSync = require('child_process').execFileSync;

var MATCH_NAME = 'F2A Figma Image Grade';
var FILE_NAME = 'FigmaImageGrade.aex';
var MIN_AE = 16;                              // AE CC 2019 - oldest release verified to load the effect
var KEYS = ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows'];
var LABELS = ['曝光', '对比度', '饱和度', '白平衡', '着色', '高光', '阴影'];
var TEMPLATE = 'scripts/aep/figma-image-grade-effect.bin';

// AE stores InstallPath as "<AE>/Support Files", so plug-ins live beside aerender.
// Every discovered install keeps its version so releases older than AE CC 2019 (which
// the effect is not verified on and F2A does not export for) are left alone.
function installs() {
  var found = [], seen = {};
  function add(plugins, version) {
    if (!plugins) return;
    var dir = path.resolve(String(plugins).replace(/[\\/]+$/, ''));
    var key = dir.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    found.push({version: version, plugins: dir});
  }
  var override = process.env.F2A_AE_PLUGINS;
  if (override) {
    // An explicit override is authoritative; tests and custom installs use it.
    override.split(';').forEach(function (entry) { add(entry, Infinity); });
    return found;
  }
  if (process.platform !== 'win32') return found;
  ['HKLM\\SOFTWARE\\Adobe\\After Effects',
   'HKLM\\SOFTWARE\\WOW6432Node\\Adobe\\After Effects',
   'HKCU\\SOFTWARE\\Adobe\\After Effects'].forEach(function (key) {
    var output = '';
    try {
      output = execFileSync('reg', ['query', key, '/s', '/v', 'InstallPath'],
        {encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']});
    } catch (error) { return; }
    // reg prints the version-key header before its InstallPath value.
    var match, pattern = /(?:^|\n)([^\r\n]+)\r?\n\s*InstallPath\s+REG_SZ\s+([^\r\n]+)/gi;
    while ((match = pattern.exec(output))) {
      var version = parseFloat(match[1].slice(match[1].lastIndexOf('\\') + 1));
      if (isFinite(version)) add(path.join(match[2].trim(), 'Plug-ins'), version);
    }
  });
  return found;
}

function supportedInstalls(minVersion) {
  var minimum = minVersion == null ? MIN_AE : minVersion;
  return installs().filter(function (entry) { return entry.version >= minimum; });
}

function discover(minVersion) {
  return supportedInstalls(minVersion).map(function (entry) { return entry.plugins; });
}

function pluginFiles(dirs) {
  var files = [];
  dirs.forEach(function (dir) {
    files.push(path.join(dir, 'F2A', FILE_NAME));
    files.push(path.join(dir, FILE_NAME));
  });
  return files;
}

function installed(dirs) {
  dirs = dirs || discover();
  return pluginFiles(dirs).filter(function (file) {
    try { return fs.statSync(file).isFile(); } catch (error) { return false; }
  });
}

function bundled(ext) {
  var candidates = [
    path.join(ext, 'ae-plugins', FILE_NAME),
    path.join(ext, 'ae-plugin', 'FigmaImageGradePlugin', FILE_NAME),
  ];
  // Installations that only ship the AEP export component keep it under %LOCALAPPDATA%.
  if (process.env.LOCALAPPDATA)
    candidates.push(path.join(process.env.LOCALAPPDATA, 'F2A', 'AEP', 'ae-plugins', FILE_NAME));
  for (var i = 0; i < candidates.length; i++) {
    try { if (fs.statSync(candidates[i]).isFile()) return candidates[i]; } catch (error) {}
  }
  return '';
}

// Copy the packaged plug-in into every supported AE install that lacks it. AE loads
// plug-ins at start-up, so a running session keeps using the LUT path until it is restarted.
function install(ext) {
  var entries = supportedInstalls();
  var dirs = entries.map(function (entry) { return entry.plugins; });
  var found = installed(dirs);
  if (found.length) return {available: true, copied: false, files: found, dirs: dirs};
  if (!dirs.length) return {available: false, copied: false, dirs: dirs,
    reason: '未找到 After Effects CC 2019 及以上的安装目录'};
  var source = bundled(ext);
  if (!source) return {available: false, copied: false, reason: '缺少 FigmaImageGrade.aex', dirs: dirs};
  var files = [], errors = [];
  dirs.forEach(function (dir) {
    var folder = path.join(dir, 'F2A'), target = path.join(folder, FILE_NAME);
    try {
      fs.mkdirSync(folder, {recursive: true});
      if (!fs.existsSync(target)) fs.copyFileSync(source, target);
      if (fs.existsSync(target)) files.push(target);
    } catch (error) { errors.push(dir + '：' + (error.message || error)); }
  });
  if (files.length) return {available: true, copied: true, files: files, dirs: dirs};
  return {available: false, copied: false, reason: errors.join('；') || '无法写入 AE 插件目录', dirs: dirs};
}

// Decide how this export reproduces Figma's image filters: the native effect or the
// LUT fallback. `aeVersion` is the AEP version being written; only a target older than
// AE CC 2019 (not something F2A writes) stays on the LUT path. `template` is only needed
// by the offline writer, which clones the effect definition from disk instead of
// querying AE.
function resolve(ext, options) {
  options = options || {};
  var forced = options.mode || process.env.F2A_IMAGE_GRADE_MODE;
  if (forced === 'lut' || forced === 'effect') return {mode: forced, forced: true, available: forced === 'effect', copied: false};
  if (options.aeVersion != null) {
    var major = parseInt(String(options.aeVersion).split('.')[0], 10);
    if (major > 0 && major < MIN_AE) {
      return {mode: 'lut', forced: false, available: false, copied: false,
        reason: '目标 AE 版本（' + options.aeVersion + '）早于 AE CC 2019，不支持 Figma 调色插件'};
    }
  }
  var template = options.template || path.join(ext, TEMPLATE);
  if (!fs.existsSync(template)) {
    return {mode: 'lut', available: false, copied: false, reason: '缺少调色效果模板'};
  }
  var status = install(ext);
  status.mode = status.available ? 'effect' : 'lut';
  status.forced = false;
  return status;
}

// A tiny in-AE probe: the plug-in either adds an effect or it does not. The panel has
// no API to enumerate installed effects, and the user may have restarted AE after a
// copy — probing the live host is the only truthful answer. A miss reports app.version
// so the panel can tell "needs a restart" apart from "this AE is too old".
var PROBE_SCRIPT = '(function(){var p=app.project;if(!p)return "NO:0";' +
  'var c=p.items.addComp("F2A 调色插件检测",4,4,1,.05,24);var ok=false;' +
  'try{var l=c.layers.addShape();l.property("ADBE Effect Parade").addProperty("' + MATCH_NAME + '");ok=true;}' +
  'catch(e){}try{c.remove();}catch(e2){}return ok?"OK":"NO:"+app.version;})()';

function parseProbe(result) {
  return /^OK/.test(String(result || ''));
}

// The AE major version reported by a failed probe, or 0 when it said nothing useful.
function probeVersion(result) {
  var match = /^NO:(\d+)/.exec(String(result || ''));
  return match ? Number(match[1]) : 0;
}

module.exports = {
  MATCH_NAME: MATCH_NAME,
  FILE_NAME: FILE_NAME,
  MIN_AE: MIN_AE,
  KEYS: KEYS,
  LABELS: LABELS,
  PROBE_SCRIPT: PROBE_SCRIPT,
  parseProbe: parseProbe,
  probeVersion: probeVersion,
  installs: installs,
  supportedInstalls: supportedInstalls,
  discover: discover,
  pluginFiles: pluginFiles,
  installed: installed,
  bundled: bundled,
  install: install,
  resolve: resolve,
};
