'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const effect = require('../client/figmaImageGradeEffect.js');

const root = path.resolve(__dirname, '..');

function withEnv(values, action) {
  const saved = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key];
  }
  try { return action(); }
  finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}

function scratch() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f2a-grade-effect-'));
  const plugins = path.join(base, 'Adobe After Effects 2026', 'Support Files', 'Plug-ins');
  fs.mkdirSync(plugins, {recursive: true});
  return {base, plugins};
}

function check() {
  const {base, plugins} = scratch();
  try {
    // Discovery honours the F2A_AE_PLUGINS override (semicolon separated).
    withEnv({F2A_AE_PLUGINS: plugins + ';' + path.join(base, 'second')}, () => {
      assert.deepEqual(effect.discover(), [path.resolve(plugins), path.resolve(base, 'second')]);
    });

    // Missing from AE + writable Plug-ins folder + packaged .aex => install and use the effect.
    withEnv({F2A_AE_PLUGINS: plugins, F2A_IMAGE_GRADE_MODE: undefined}, () => {
      assert.deepEqual(effect.installed(), []);
      const first = effect.resolve(root);
      assert.equal(first.mode, 'effect');
      assert.equal(first.copied, true);
      assert.ok(fs.existsSync(path.join(plugins, 'F2A', effect.FILE_NAME)));
      assert.deepEqual(effect.installed(), [path.join(plugins, 'F2A', effect.FILE_NAME)]);
      const second = effect.resolve(root);
      assert.equal(second.mode, 'effect');
      assert.equal(second.copied, false);
    });

    // Forced modes still win, so the tests (and a user workaround) can pin one path.
    withEnv({F2A_AE_PLUGINS: plugins, F2A_IMAGE_GRADE_MODE: 'lut'}, () => {
      assert.equal(effect.resolve(root).mode, 'lut');
    });
    withEnv({F2A_AE_PLUGINS: path.join(base, 'empty'), F2A_IMAGE_GRADE_MODE: 'effect'}, () => {
      assert.equal(effect.resolve(root).mode, 'effect');
    });

    // A missing template means the offline writer cannot clone the effect: LUT fallback.
    withEnv({F2A_AE_PLUGINS: path.join(base, 'empty'), F2A_IMAGE_GRADE_MODE: undefined}, () => {
      const resolution = effect.resolve(root, {template: path.join(base, 'missing.bin')});
      assert.equal(resolution.mode, 'lut');
      assert.match(resolution.reason, /模板/);
    });

    // Unwritable plug-ins location (a file where the folder should be) => LUT fallback.
    const blocker = path.join(base, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    withEnv({F2A_AE_PLUGINS: path.join(blocker, 'Plug-ins'), F2A_IMAGE_GRADE_MODE: undefined}, () => {
      const resolution = effect.resolve(root);
      assert.equal(resolution.mode, 'lut');
      assert.equal(resolution.available, false);
    });

    // AE 2024/2025 targets use the plug-in exactly like 2026 (verified in AE CC 2019);
    // only a target older than CC 2019, which F2A never writes, stays on the LUT path.
    withEnv({F2A_AE_PLUGINS: plugins, F2A_IMAGE_GRADE_MODE: undefined}, () => {
      assert.equal(effect.MIN_AE, 16);
      for (const aeVersion of ['24.0', '25.0', '26.0'])
        assert.equal(effect.resolve(root, {aeVersion}).mode, 'effect', aeVersion);
      const ancient = effect.resolve(root, {aeVersion: '15.0'});
      assert.equal(ancient.mode, 'lut');
      assert.match(ancient.reason, /2019/);
    });

    // Discovery keeps the AE version so the writer can target only supported installs.
    withEnv({F2A_AE_PLUGINS: plugins}, () => {
      assert.deepEqual(effect.discover(0), [path.resolve(plugins)]);
      assert.equal(effect.installs().length, 1);
      assert.equal(effect.installs()[0].version, Infinity);
      assert.deepEqual(effect.supportedInstalls(), [{version: Infinity, plugins: path.resolve(plugins)}]);
    });

    // The live probe answers only OK as "the effect is loaded".
    assert.equal(effect.parseProbe('OK'), true);
    assert.equal(effect.parseProbe('NO:xxx'), false);
    assert.equal(effect.parseProbe('EvalScript error.'), false);
    assert.equal(effect.parseProbe(undefined), false);
    assert.match(effect.PROBE_SCRIPT, /F2A Figma Image Grade/);
    // A miss reports the host version so the panel can skip an unsupported AE.
    assert.equal(effect.probeVersion('NO:26.0x67'), 26);
    assert.equal(effect.probeVersion('NO:16.0x...'), 16);
    assert.equal(effect.probeVersion('NO:0'), 0);
    assert.equal(effect.probeVersion('OK'), 0);
    console.log('PASS: Figma 调色 discovery, copy into AE Plug-ins, AE 2024–2026 targeting, forced modes, LUT fallback and live probe');
  } finally { fs.rmSync(base, {recursive: true, force: true}); }
}

if (require.main === module) {
  try { check(); } catch (error) { console.error(error); process.exitCode = 1; }
}

module.exports = {effect};
