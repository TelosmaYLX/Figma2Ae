'use strict';

// Live (CEP) import: with Figma 调色 loaded the pictures carry a flag instead of an import
// project; when the probe fails the panel installs the plug-in (when the host supports it)
// and falls back to building the LUT grade project for the running session.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {harness} = require('./client-import-queue.cjs');

const filters = {exposure: -0.17, contrast: 0.05, saturation: 0.18, temperature: -0.26,
  tint: 0.21, highlights: -0.21, shadows: 0.13};
// A real 1x1 PNG is required: the fallback builds a py_aep project that probes the image.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7d0AAAAASUVORK5CYII=';

function savedImages(native) {
  return JSON.parse(fs.readFileSync(native.native[0].job.imagesPath, 'utf8'));
}

async function waitForNative(job) {
  for (let i = 0; i < 400 && !job.native.length; i++)
    await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(job.native.length, job.messages.join(' | '));
}

async function check() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f2a-grade-panel-'));
  const plugins = path.join(base, 'Plug-ins');
  fs.mkdirSync(plugins, {recursive: true});
  const previous = process.env.F2A_AE_PLUGINS;
  // Point the copy at a scratch Plug-ins folder; never touch the real AE install in a test.
  process.env.F2A_AE_PLUGINS = plugins;
  try {
    // The probe answers OK: the picture is imported with the native effect flag and no LUT
    // project is prepared at all.
    const effect = harness({probeResult: 'OK'});
    effect.start('图片调色 插件', 1);
    effect.images('调色图片', false, false, {imageFilters: filters});
    assert.equal(effect.native.length, 1, effect.messages.join(' | '));
    const graded = savedImages(effect)[0];
    assert.equal(graded.imageGradeEffect, true);
    assert.equal(graded.imageFilters.exposure, -0.17);
    assert.equal(graded.gradeProject, undefined, 'effect mode must not build the LUT project');
    assert.equal(graded.gradeComp, undefined);
    effect.finish();

    // The probe fails on an AE 2025 host: old AE releases load the effect too, so the
    // packaged plug-in is copied for the next start and this session still builds the LUT
    // grade project.
    const restart = harness({probeResult: 'NO:25.0x...'});
    restart.start('图片调色 重启后生效', 1);
    restart.images('调色图片', false, false, {imageFilters: filters, data: PNG});
    await waitForNative(restart);
    const lut = savedImages(restart)[0];
    assert.equal(lut.imageGradeEffect, undefined);
    assert.match(lut.gradeProject, /图片调色\.aep$/);
    assert.ok(fs.existsSync(path.join(plugins, 'F2A', 'FigmaImageGrade.aex')),
      'the panel copies the packaged plug-in into the AE Plug-ins folder');
    const gradeDir = path.dirname(lut.gradeProject);
    assert.ok(fs.existsSync(lut.gradeProject), 'the fallback project exists until the import finishes');
    restart.finish();
    assert.ok(!fs.existsSync(gradeDir), 'the fallback project and LUT tables are cleaned up');

    // An AE older than CC 2019 is not a supported host: no copy, LUT for real.
    fs.rmSync(path.join(plugins, 'F2A'), {recursive: true, force: true});
    const old = harness({probeResult: 'NO:15.0x...'});
    old.start('图片调色 旧版 AE', 1);
    old.images('调色图片', false, false, {imageFilters: filters, data: PNG});
    await waitForNative(old);
    assert.equal(savedImages(old)[0].imageGradeEffect, undefined);
    assert.match(savedImages(old)[0].gradeProject, /图片调色\.aep$/);
    assert.ok(!fs.existsSync(path.join(plugins, 'F2A')), 'an unsupported AE gets no plug-in copy');
    old.finish();

    console.log('PASS: live import prefers Figma 调色, copies the plug-in for AE CC 2019+ and only uses LUT when it cannot load');
  } finally {
    if (previous === undefined) delete process.env.F2A_AE_PLUGINS;
    else process.env.F2A_AE_PLUGINS = previous;
    fs.rmSync(base, {recursive: true, force: true});
  }
}

if (require.main === module) check().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = {check};
