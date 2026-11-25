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
 * mode; tests use both. The copy/probe plumbing lives in client/figmaAePlugin.js, shared
 * with Figma 背景模糊.
 */

var fs = require('fs');
var path = require('path');
var plugin = require('./figmaAePlugin.js');

var MATCH_NAME = 'F2A Figma Image Grade';
var DISPLAY_NAME = 'Figma 调色';
var FILE_NAME = 'FigmaImageGrade.aex';
var MIN_AE = 16;                              // AE CC 2019 - oldest release verified to load the effect
var KEYS = ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows'];
var LABELS = ['曝光', '对比度', '饱和度', '白平衡', '着色', '高光', '阴影'];
var TEMPLATE = 'scripts/aep/figma-image-grade-effect.bin';

var descriptor = plugin.create({
  matchName: MATCH_NAME,
  displayName: DISPLAY_NAME,
  fileName: FILE_NAME,
  minAe: MIN_AE,
  bundleDirs: ['ae-plugin/FigmaImageGradePlugin'],
  template: TEMPLATE,
  // The live-import test harness recognises the Figma 调色 probe by this comp name.
  probeName: 'F2A 调色插件检测',
});

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
  var status = descriptor.install(ext);
  status.mode = status.available ? 'effect' : 'lut';
  status.forced = false;
  return status;
}

module.exports = {
  MATCH_NAME: MATCH_NAME,
  DISPLAY_NAME: DISPLAY_NAME,
  FILE_NAME: FILE_NAME,
  MIN_AE: MIN_AE,
  TEMPLATE: TEMPLATE,
  KEYS: KEYS,
  LABELS: LABELS,
  PROBE_SCRIPT: descriptor.PROBE_SCRIPT,
  parseProbe: descriptor.parseProbe,
  probeVersion: descriptor.probeVersion,
  installs: descriptor.installs,
  supportedInstalls: descriptor.supportedInstalls,
  discover: descriptor.discover,
  pluginFiles: descriptor.pluginFiles,
  installed: descriptor.installed,
  bundled: descriptor.bundled,
  install: descriptor.install,
  resolve: resolve,
};
