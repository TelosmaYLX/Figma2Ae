'use strict';

// Live (CEP) import: with Figma 调色 loaded the pictures carry a flag instead of an import
// project; when the probe fails the panel falls back to building the LUT grade project.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {harness} = require('./client-import-queue.cjs');

const filters = {exposure: -0.17, contrast: 0.05, saturation: 0.18, temperature: -0.26,
  tint: 0.21, highlights: -0.21, shadows: 0.13};
// A real 1x1 PNG is required: the fallback builds a py_aep project that probes the image.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7d0AAAAASUVORK5CYII=';

function savedImages(native) {
  return JSON.parse(fs.readFileSync(native.native[0].job.imagesPath, 'utf8'));
}

async function check() {
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

  // The probe fails: the panel builds the LUT grade project (Python + py_aep) and imports
  // that instead, so older AE installs keep working.
  const fallback = harness({probeResult: 'NO:missing'});
  fallback.start('图片调色 LUT', 1);
  fallback.images('调色图片', false, false, {imageFilters: filters, data: PNG});
  for (let i = 0; i < 400 && !fallback.native.length; i++)
    await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(fallback.native.length, fallback.messages.join(' | '));
  const lut = savedImages(fallback)[0];
  assert.equal(lut.imageGradeEffect, undefined);
  assert.match(lut.gradeProject, /图片调色\.aep$/);
  const gradeDir = require('node:path').dirname(lut.gradeProject);
  assert.ok(fs.existsSync(lut.gradeProject), 'the fallback project exists until the import finishes');
  fallback.finish();
  assert.ok(!fs.existsSync(gradeDir), 'the fallback project and LUT tables are cleaned up');

  console.log('PASS: live import prefers Figma 调色 and only builds the LUT grade project when the effect is missing');
}

if (require.main === module) check().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = {check};
