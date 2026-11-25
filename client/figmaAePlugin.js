'use strict';

/* ===== One native After Effects effect plug-in (.aex) =====
 * F2A ships two small native AE effects that reproduce parts of Figma's own renderer:
 * Figma 调色 (F2A Figma Image Grade) and Figma 背景模糊 (F2A Figma Background Blur).
 * This dependency-free module is the descriptor they share, so discovery of the AE
 * installs, the copy into <AE>/Support Files/Plug-ins/F2A/, the live-host probe and the
 * panel's "install, then retry after restart" flow only exist once.
 *
 * The installers do the copy up front (scripts/install-ae-plugins.ps1), so pulling an
 * update is enough on a normal machine. Only when that is impossible (AE not found,
 * install folder read-only) does the caller fall back — Figma 调色 to the LUT grade that
 * scripts/aep/image_grade.py builds, Figma 背景模糊 to rasterising the affected layers.
 *
 * Both plug-ins only use long-standing effect APIs; they were verified in After Effects
 * CC 2019 (16.1.3) and AE 2026, so every AE release F2A exports for (2024–2026) loads
 * them. AE releases older than CC 2019 are not touched.
 *
 * This module is plain Node: the CEP panel uses it for the live import, scripts/
 * export-aep.cjs for the offline AEP writer. `F2A_AE_PLUGINS` overrides the discovered
 * plug-in folders (semicolon separated); tests use it.
 */

var fs = require('fs');
var path = require('path');
var execFileSync = require('child_process').execFileSync;

// Build the shared descriptor for one .aex plug-in.
//   matchName   effect match name used by AE scripting (addProperty)
//   displayName name shown to the user in panel messages
//   fileName    packaged file name, e.g. FigmaImageGrade.aex
//   minAe       oldest AE major release that loads the effect (16 = AE CC 2019)
//   bundleDirs  packaged source folders relative to the F2A package, e.g.
//               ['ae-plugin/FigmaImageGradePlugin']
//   bundleFile  optional explicit packaged file, relative to the F2A package
//   template    optional effect definition template used by the offline writer
//   probeName   optional temp-comp name for the probe (defaults to
//               'F2A ' + displayName + '插件检测'; the CEP import test harness
//               recognises the Figma 调色 probe by its comp name)
function create(options) {
  options = options || {};
  var MATCH_NAME = String(options.matchName || '');
  var DISPLAY_NAME = String(options.displayName || '');
  var FILE_NAME = String(options.fileName || '');
  var MIN_AE = options.minAe == null ? 16 : Number(options.minAe);   // AE CC 2019 - verified to load the effects
  var TEMPLATE = options.template || '';
  var BUNDLE_DIRS = (options.bundleDirs || []).map(function (dir) { return String(dir); });
  var BUNDLE_FILE = options.bundleFile ? String(options.bundleFile) : '';
  var PROBE_NAME = options.probeName || ('F2A ' + DISPLAY_NAME + '插件检测');

  // AE stores InstallPath as "<AE>/Support Files", so plug-ins live beside aerender.
  // Every discovered install keeps its version so releases older than AE CC 2019 (which
  // the effects are not verified on and F2A does not export for) are left alone.
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
    var candidates = [path.join(ext, 'ae-plugins', FILE_NAME)];
    BUNDLE_DIRS.forEach(function (dir) { candidates.push(path.join(ext, dir, FILE_NAME)); });
    if (BUNDLE_FILE) candidates.push(path.join(ext, BUNDLE_FILE));
    // Installations that only ship the AEP export component keep it under %LOCALAPPDATA%.
    if (process.env.LOCALAPPDATA)
      candidates.push(path.join(process.env.LOCALAPPDATA, 'F2A', 'AEP', 'ae-plugins', FILE_NAME));
    for (var i = 0; i < candidates.length; i++) {
      try { if (fs.statSync(candidates[i]).isFile()) return candidates[i]; } catch (error) {}
    }
    return '';
  }

  // Copy the packaged plug-in into every supported AE install that lacks it. AE loads
  // plug-ins at start-up, so a running session keeps using the fallback path until it is
  // restarted.
  function install(ext) {
    var entries = supportedInstalls();
    var dirs = entries.map(function (entry) { return entry.plugins; });
    var found = installed(dirs);
    if (found.length) return {available: true, copied: false, files: found, dirs: dirs};
    if (!dirs.length) return {available: false, copied: false, dirs: dirs,
      reason: '未找到 After Effects CC 2019 及以上的安装目录'};
    var source = bundled(ext);
    if (!source) return {available: false, copied: false, reason: '缺少 ' + FILE_NAME, dirs: dirs};
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

  // A tiny in-AE probe: the plug-in either adds an effect or it does not. The panel has
  // no API to enumerate installed effects, and the user may have restarted AE after a
  // copy — probing the live host is the only truthful answer. A miss reports app.version
  // so the panel can tell "needs a restart" apart from "this AE is too old".
  var PROBE_SCRIPT = '(function(){var p=app.project;if(!p)return "NO:0";' +
    'var c=p.items.addComp("' + PROBE_NAME + '",4,4,1,.05,24);var ok=false;' +
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

  // Ask the live AE host whether the effect is loaded; when it is not, copy the packaged
  // .aex for the next start and answer what this session can do. `evalScript` is the CEP
  // panel's host evaluator: evalScript(PROBE_SCRIPT, function (result) {}). Never throws:
  // an evaluator error is treated exactly like a failed probe.
  function ensure(ext, evalScript, cb) {
    function afterProbe(result) {
      if (parseProbe(result)) { cb({available: true, copied: false}); return; }
      var version = probeVersion(result);
      if (version && version < MIN_AE) {
        // This AE cannot load the plug-in at all; copying it would only mislead.
        cb({available: false, copied: false, version: version,
          reason: '当前 AE ' + version + ' 早于 AE CC 2019，不支持' + DISPLAY_NAME + '插件'});
        return;
      }
      var status;
      try { status = install(ext); }
      catch (error) { status = {available: false, copied: false, reason: (error && error.message) || String(error)}; }
      cb({available: false, copied: !!status.copied, dirs: status.dirs, files: status.files, version: version,
        reason: status.copied
          ? '已将' + DISPLAY_NAME + '插件安装到 AE 插件目录，重启 AE 后生效'
          : (status.reason || 'AE 尚未加载' + DISPLAY_NAME + '插件')});
    }
    try { evalScript(PROBE_SCRIPT, afterProbe); }
    catch (error) { afterProbe('EvalScript error.' + ((error && error.message) || '')); }
  }

  return {
    MATCH_NAME: MATCH_NAME,
    DISPLAY_NAME: DISPLAY_NAME,
    FILE_NAME: FILE_NAME,
    MIN_AE: MIN_AE,
    TEMPLATE: TEMPLATE,
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
    ensure: ensure,
  };
}

module.exports = {create: create};
