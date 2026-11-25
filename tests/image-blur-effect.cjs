'use strict';

// The 保留背景模糊 path ships its own native AE plug-in (FigmaBackgroundBlur.aex). This test
// covers discovery, the copy into AE Plug-ins, the live-host probe and the panel's ensure()
// flow with fake evalScript answers, so the export can tell a loaded effect apart from
// "restart AE after the copy" and "this AE is too old".
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const effect = require('../client/figmaBackgroundBlurEffect.js');

const root = path.resolve(__dirname, '..');
const aex = path.join(root, 'ae-plugin/FigmaBackgroundBlurPlugin/FigmaBackgroundBlur.aex');

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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f2a-blur-effect-'));
  const plugins = path.join(base, 'Adobe After Effects 2026', 'Support Files', 'Plug-ins');
  fs.mkdirSync(plugins, {recursive: true});
  return {base, plugins};
}

function emptyDir(base, name) {
  const directory = path.join(base, name);
  fs.mkdirSync(directory, {recursive: true});
  return directory;
}

function check() {
  const {base, plugins} = scratch();
  try {
    // API surface of the shared plug-in core, specialised for Figma 背景模糊.
    assert.equal(effect.MATCH_NAME, 'F2A Figma Background Blur');
    assert.equal(effect.DISPLAY_NAME, 'Figma 背景模糊');
    assert.equal(effect.FILE_NAME, 'FigmaBackgroundBlur.aex');
    assert.equal(effect.MIN_AE, 16);
    assert.match(effect.TEMPLATE, /figma-background-blur-effect\.bin$/);
    assert.match(effect.PROBE_SCRIPT, /F2A Figma Background Blur/);

    // Discovery honours the F2A_AE_PLUGINS override (semicolon separated).
    withEnv({F2A_AE_PLUGINS: plugins + ';' + path.join(base, 'second')}, () => {
      assert.deepEqual(effect.discover(), [path.resolve(plugins), path.resolve(base, 'second')]);
    });

    // Missing from AE + writable Plug-ins folder + packaged .aex => copy the blur plug-in.
    withEnv({F2A_AE_PLUGINS: plugins}, () => {
      assert.deepEqual(effect.installed(), []);
      const first = effect.install(root);
      assert.equal(first.available, true);
      assert.equal(first.copied, true);
      const target = path.join(plugins, 'F2A', effect.FILE_NAME);
      assert.ok(fs.existsSync(target));
      assert.deepEqual(fs.readFileSync(target), fs.readFileSync(aex));
      assert.deepEqual(effect.installed(), [target]);
      const second = effect.install(root);
      assert.equal(second.available, true);
      assert.equal(second.copied, false);
    });

    // bundled()/pluginFiles() see the packaged source and both Plug-ins layouts.
    withEnv({F2A_AE_PLUGINS: plugins, LOCALAPPDATA: emptyDir(base, 'localappdata')}, () => {
      assert.equal(effect.bundled(root), aex);
      assert.deepEqual(effect.pluginFiles([plugins]),
        [path.join(plugins, 'F2A', effect.FILE_NAME), path.join(plugins, effect.FILE_NAME)]);
      assert.equal(effect.bundled(emptyDir(base, 'empty-ext')), '');
    });

    // Discovery keeps the AE version so callers can target only supported installs.
    withEnv({F2A_AE_PLUGINS: plugins}, () => {
      assert.deepEqual(effect.discover(0), [path.resolve(plugins)]);
      assert.equal(effect.installs()[0].version, Infinity);
      assert.deepEqual(effect.supportedInstalls(), [{version: Infinity, plugins: path.resolve(plugins)}]);
    });

    // The probe answers only OK as "the effect is loaded"; a miss reports the host version.
    assert.equal(effect.parseProbe('OK'), true);
    assert.equal(effect.parseProbe('NO:xxx'), false);
    assert.equal(effect.parseProbe('EvalScript error.'), false);
    assert.equal(effect.parseProbe(undefined), false);
    assert.equal(effect.probeVersion('NO:26.0x67'), 26);
    assert.equal(effect.probeVersion('NO:15.0x...'), 15);
    assert.equal(effect.probeVersion('NO:0'), 0);
    assert.equal(effect.probeVersion('OK'), 0);

    // The live-host probe: a loaded effect needs no copy.
    const loaded = [];
    withEnv({F2A_AE_PLUGINS: plugins}, () => {
      effect.ensure(root, (script, callback) => {
        assert.match(script, /F2A Figma Background Blur/);
        callback('OK');
      }, status => loaded.push(status));
    });
    assert.deepEqual(loaded, [{available: true, copied: false}]);

    // An AE older than CC 2019 cannot load the plug-in: tell the user, never copy.
    const oldPlugins = emptyDir(base, 'old-plugins');
    const old = [];
    withEnv({F2A_AE_PLUGINS: oldPlugins}, () => {
      effect.ensure(root, (script, callback) => callback('NO:15.0x...'), status => old.push(status));
    });
    assert.equal(old.length, 1);
    assert.equal(old[0].available, false);
    assert.equal(old[0].copied, false);
    assert.match(old[0].reason, /2019/);
    assert.ok(!fs.existsSync(path.join(oldPlugins, 'F2A')), 'an unsupported AE gets no plug-in copy');

    // AE CC 2019+ without the effect: copy for the next start, rasterise this session.
    const restartPlugins = emptyDir(base, 'restart-plugins');
    const restart = [];
    withEnv({F2A_AE_PLUGINS: restartPlugins}, () => {
      effect.ensure(root, (script, callback) => callback('NO:25.0x...'), status => restart.push(status));
    });
    assert.equal(restart.length, 1);
    assert.equal(restart[0].available, false);
    assert.equal(restart[0].copied, true);
    assert.equal(restart[0].version, 25);
    assert.match(restart[0].reason, /重启 AE/);
    const restartTarget = path.join(restartPlugins, 'F2A', effect.FILE_NAME);
    assert.ok(fs.existsSync(restartTarget));
    assert.deepEqual(restart[0].files, [restartTarget]);

    // An evaluator error is a miss, not an exception: fall through to the copy.
    const errorPlugins = emptyDir(base, 'error-plugins');
    const failure = [];
    withEnv({F2A_AE_PLUGINS: errorPlugins}, () => {
      assert.doesNotThrow(() => {
        effect.ensure(root, () => { throw new Error('EvalScript error.'); }, status => failure.push(status));
      });
    });
    assert.equal(failure.length, 1);
    assert.equal(failure[0].copied, true);
    assert.ok(fs.existsSync(path.join(errorPlugins, 'F2A', effect.FILE_NAME)));

    // No packaged .aex at all (and no installed component copy): report unavailable, never throw.
    const emptyExt = emptyDir(base, 'empty-source');
    const missing = [];
    withEnv({F2A_AE_PLUGINS: emptyDir(base, 'missing-plugins'), LOCALAPPDATA: emptyDir(base, 'missing-localappdata')}, () => {
      assert.doesNotThrow(() => {
        effect.ensure(emptyExt, (script, callback) => callback('NO:25.0x...'), status => missing.push(status));
      });
    });
    assert.equal(missing.length, 1);
    assert.equal(missing[0].available, false);
    assert.equal(missing[0].copied, false);
    assert.match(missing[0].reason, /FigmaBackgroundBlur\.aex/);

    // A read-only/garbage target only reports unavailable: install() never throws.
    const blocker = path.join(base, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    withEnv({F2A_AE_PLUGINS: path.join(blocker, 'Plug-ins')}, () => {
      const blocked = effect.install(root);
      assert.equal(blocked.available, false);
      assert.equal(blocked.copied, false);
    });

    console.log('PASS: Figma 背景模糊 discovery, copy into AE Plug-ins, live probe and ensure() restart/too-old/missing paths');
  } finally { fs.rmSync(base, {recursive: true, force: true}); }
}

if (require.main === module) {
  try { check(); } catch (error) { console.error(error); process.exitCode = 1; }
}

module.exports = {effect};
