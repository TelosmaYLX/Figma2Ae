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
from py_aep.binary.utils import find_by_type, index_by_identity
from py_aep.enums import BlendingMode, TrackMatteType
p = py_aep.parse(sys.argv[1]).project
items = list(p.items.values())
grade, = [c for c in items if hasattr(c, 'layers') and c.name.startswith('图片调色 · ')]
labels = ['曝光','对比度','饱和度','白平衡','着色','高光','阴影']
inputs = ['输入 · ' + label for label in labels]
assert grade.motion_graphics_template_controller_names == inputs
assert grade.duration == 2 and grade.frame_rate == 24
stencil = grade.layers[0]
assert stencil.name == '原图 Alpha' and stencil.enabled
assert stencil.blending_mode == BlendingMode.STENCIL_ALPHA
assert not list(stencil['ADBE Effect Parade'])
assert all(layer.track_matte_type == TrackMatteType.NO_TRACK_MATTE for layer in grade.layers)
coverage, = [c for c in items if hasattr(c, 'layers') and c.name == '混色输入']
levels, = list(coverage.layers[0]['ADBE Effect Parade'])
assert levels.match_name == 'ADBE Pro Levels2' and levels['ADBE Pro Levels2-0033'].value == 1/65535
assert coverage.layers[0].source.id == stencil.source.id
design, = [layer for layer in grade.layers if layer.name == 'Figma 设计值']
assert design.source.id == coverage.id
parade = design['ADBE Effect Parade']
chunks = parade._tdgp.chunks
lut = chunks[index_by_identity(chunks, parade['ADBE Apply Color LUT2']._tdmn) + 1]
profile = find_by_type(lut.chunks, 'sdat').data[28:]
assert profile[36:40] == b'acsp' and int.from_bytes(profile[:4], 'big') == len(profile)
assert len(profile) >= 64**3 * 3 * 2
def check_sliders(layer, front=False):
    effects = [fx for fx in layer['ADBE Effect Parade'] if fx.match_name == 'ADBE Slider Control']
    assert [e.name for e in effects] == labels
    for e, value in zip(effects, [-17,5,18,-26,21,-21,13]):
        s = e['ADBE Slider Control-0001']
        assert abs(s.value-value) < .00001
        assert (s.expression or '') == ('clamp(value, -100, 100);' if front else '')
        assert find_by_type(s._tdbs.chunks,'tdum').values == [-100]
        assert find_by_type(s._tdbs.chunks,'tduM').values == [100]
        assert (s._tdb4._value_hint_flag, s._tdb4._cvot_flags) == (255, 255)
def check_instance(layer):
    check_sliders(layer, front=True)
    assert len(list(layer['ADBE Effect Parade'])) == 7
    assert layer.essential_property_uuids == [c.uuid for c in layer.source.motion_graphics_controllers]
    values = [b for b in layer['ADBE Layer Overrides']._tdgp.chunks if getattr(b, 'list_type', '') == 'tdbs']
    assert [find_by_type(v.chunks,'tdsn').chunks[0].value for v in values] == inputs
    for label, v in zip(labels, values):
        assert find_by_type(v.chunks,'Utf8').value.splitlines() == [
            'var control = thisLayer.effect("' + label + '");', 'control.active ? control(1).value : 0;']
check_sliders(design)
assert sum(type(i).__name__ == 'FootageItem' for i in items) == 1
stages = [c for c in items if hasattr(c, 'layers') and c.name in labels]
assert len(stages) == 7
for stage in stages:
    assert len(stage.layers) == 21
    assert all(grade.name in branch.transform.opacity.expression for branch in stage.layers)
    assert [e.match_name for e in stage.layers[0]['ADBE Effect Parade']] == ['ADBE Apply Color LUT2']
if len(sys.argv) >= 3:
    main, = [i for i in items if hasattr(i, 'layers') and i.name == sys.argv[2]]
    layer, = main.layers
    assert layer.enabled and layer.track_matte_type == TrackMatteType.NO_TRACK_MATTE
    check_instance(layer)
    if len(sys.argv) == 4:
        layer, = [l for l in layer.source.layers if l.track_matte_type == TrackMatteType.ALPHA]
        check_instance(layer)
    assert layer.source.id == grade.id
`;
const run = promisify(execFile);

function gradePacket() {
  const image = {name:'图片', x:0, y:0, w:32, h:18, scaleMode:'FIT', ext:'png',
    imageFilters:{exposure:-.17, contrast:.05, saturation:.18, temperature:-.26,
      tint:.21, highlights:-.21, shadows:.13}, data:png(32,18).toString('base64')};
  return {name:'Grade test', svg:'<svg width="32" height="18"></svg>', duration:2,
    frameRate:24, images:[image]};
}

async function check() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'f2a-test-image-grade-'));
  try {
    const packet = gradePacket();
    const {data, ...image} = packet.images[0];
    const direct = await exportAep(packet, directory);
    await run(python, ['-c', inspect, direct.project, packet.name], {windowsHide:true});
    const assets = path.join(directory, 'Assets');
    assert.deepEqual(await fs.readdir(assets), ['0000.png']);
    assert.deepEqual(await fs.readFile(path.join(assets, '0000.png')), Buffer.from(data,'base64'));
    const cropped = await exportAep({...packet, images:[{...packet.images[0], matte:{kind:'ellipse'}}]},
      path.join(directory, 'crop'));
    await run(python, ['-c', inspect, cropped.project, packet.name, 'crop'], {windowsHide:true});

    const placed = {...image, file:'0000.png'};
    const cleanup = await new Promise((resolve, reject) =>
      prepareImport(root, [placed], assets, 2, 24, (error, release) => error ? reject(error) : resolve(release)));
    try {
      assert.match(placed.gradeComp, /^图片调色 · /);
      await run(python, ['-c', inspect, placed.gradeProject], {windowsHide:true});
    } finally { cleanup(); }
    assert.deepEqual(await fs.readdir(assets), ['0000.png']);
    await assert.rejects(fs.access(placed.gradeProject), {code:'ENOENT'});
    console.log('PASS: direct and panel grades, per-layer sliders, original alpha stencil and cropped image controls');
  } finally { await fs.rm(directory, {recursive:true, force:true}); }
}

module.exports = {gradePacket, inspect};
if (require.main === module) check().catch(error => { console.error(error); process.exitCode = 1; });
