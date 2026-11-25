'use strict';

/* ===== Figma 背景模糊 effect (F2A Figma Background Blur) =====
 * The native AE plug-in behind the panel's export option 「保留背景模糊」: Figma's own
 * background-blur algorithm is reproduced live on an adjustment layer above the source
 * layer (see scripts/aep/background-blur-export.md), so the animator keeps editable layers
 * instead of a rasterised picture.
 *
 * The panel probes the live AE host before exporting (`ensure` below). When Figma 背景模糊
 * is not loaded the packaged FigmaBackgroundBlur.aex is copied into
 * <AE>/Support Files/Plug-ins/F2A/ for the next AE start, and this export falls back to
 * rasterising the affected layers. The installers already copy both native plug-ins on
 * install and update (scripts/install-ae-plugins.ps1), so a normal machine has it after
 * restarting AE.
 *
 * This plug-in only uses long-standing effect APIs and is validated in AE 2026; F2A
 * installs and exports for AE CC 2019 (16) and newer, so every supported host loads it.
 * AE releases older than CC 2019 are not touched, and the offline AEP path always writes
 * the effect — the restore value is only used for optional offline checks.
 *
 * This module is plain Node and shares client/figmaAePlugin.js with Figma 调色;
 * `F2A_AE_PLUGINS` overrides the discovered plug-in folders (semicolon separated).
 */

var plugin = require('./figmaAePlugin.js');

var MATCH_NAME = 'F2A Figma Background Blur';
var DISPLAY_NAME = 'Figma 背景模糊';
var FILE_NAME = 'FigmaBackgroundBlur.aex';
var MIN_AE = 16;                              // AE CC 2019 - oldest release F2A installs and exports for
var TEMPLATE = 'scripts/aep/figma-background-blur-effect.bin';

var descriptor = plugin.create({
  matchName: MATCH_NAME,
  displayName: DISPLAY_NAME,
  fileName: FILE_NAME,
  minAe: MIN_AE,
  bundleDirs: ['ae-plugin/FigmaBackgroundBlurPlugin'],
  template: TEMPLATE,
});

module.exports = {
  MATCH_NAME: MATCH_NAME,
  DISPLAY_NAME: DISPLAY_NAME,
  FILE_NAME: FILE_NAME,
  MIN_AE: MIN_AE,
  TEMPLATE: TEMPLATE,
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
  ensure: descriptor.ensure,
};
