'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {png} = require('./direct-aep.cjs');
const {exportAep} = require('../scripts/export-aep.cjs');
const {prepareImport} = require('../client/figmaImageGrade.js');

const root = path.resolve(__dirname, '..');
const python = process.env.F2A_PYTHON || path.join(root, '.venv-aep',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const inspect = `
import sys, py_aep
from py_aep.enums import TrackMatteType
p = py_aep.parse(sys.argv[1]).project
items = list(p.items.values())
grade, = [c for c in items if hasattr(c, 'layers') and c.name.startswith('图片调色 · ')]
control, result = grade.layers
labels = ['曝光','对比度','饱和度','白平衡','着色','高光','阴影']
assert grade.motion_graphics_template_controller_names == labels
assert grade.duration == 2 and grade.frame_rate == 24
assert result.track_matte_type == TrackMatteType.ALPHA
effects = list(control['ADBE Effect Parade'])
assert [e.name for e in effects] == labels
for e, value in zip(effects, [-17,5,18,-26,21,-21,13]):
    assert e.match_name == 'ADBE Slider Control'
    s = e['ADBE Slider Control-0001']
    assert abs(s.value-value) < .00001
    assert (s._tdb4._value_hint_flag, s._tdb4._cvot_flags) == (255, 255)
assert sum(type(i).__name__ == 'FootageItem' for i in items) == 1
stages = [c for c in items if hasattr(c, 'layers') and c.name in labels]
assert len(stages) == 7
for stage in stages:
    assert len(stage.layers) == 21
    assert all(grade.name in branch.transform.opacity.expression for branch in stage.layers)
    assert [e.match_name for e in stage.layers[0]['ADBE Effect Parade']] == ['ADBE Apply Color LUT2']
if len(sys.argv) == 3:
    main, = [i for i in items if hasattr(i, 'layers') and i.name == sys.argv[2]]
    assert main.layers[0].source.id == grade.id
`;
const run = promisify(execFile);

async function check() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'f2a-test-image-grade-'));
  try {
    const bytes = png(32, 18);
    const image = {name:'图片', x:0, y:0, w:32, h:18, scaleMode:'FIT', ext:'png',
      imageFilters:{exposure:-.17, contrast:.05, saturation:.18, temperature:-.26,
        tint:.21, highlights:-.21, shadows:.13}};
    const packet = {name:'Grade test', svg:'<svg width="32" height="18"></svg>', duration:2,
      frameRate:24, images:[{...image,data:bytes.toString('base64')}]};
    const direct = await exportAep(packet, directory);
    await run(python, ['-c', inspect, direct.project, packet.name], {windowsHide:true});
    const assets = path.join(directory, 'Assets');
    assert.deepEqual(await fs.readdir(assets), ['0000.png']);
    assert.deepEqual(await fs.readFile(path.join(assets, '0000.png')), bytes);

    const placed = {...image, file:'0000.png'};
    const cleanup = await new Promise((resolve, reject) =>
      prepareImport(root, [placed], assets, 2, 24, (error, release) => error ? reject(error) : resolve(release)));
    try {
      assert.match(placed.gradeComp, /^图片调色 · /);
      await run(python, ['-c', inspect, placed.gradeProject], {windowsHide:true});
    } finally { cleanup(); }
    assert.deepEqual(await fs.readdir(assets), ['0000.png']);
    await assert.rejects(fs.access(placed.gradeProject), {code:'ENOENT'});
    console.log('PASS: direct and panel grade projects, seven keyframeable controls, embedded LUTs, original asset and alpha matte');
  } finally { await fs.rm(directory, {recursive:true, force:true}); }
}

check().catch(error => { console.error(error); process.exitCode = 1; });
