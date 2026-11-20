"""Build an editable Figma image grade from stock After Effects effects."""
import hashlib
import io
import json
import struct
import uuid
from copy import deepcopy
from functools import lru_cache
from pathlib import Path

from py_aep.binary.chunk import ListChunk, read_chunks
from py_aep.binary.property_chunks import TdmnChunk
from py_aep.binary.scalar_chunks import Utf8Chunk
from py_aep.binary.utils import find_by_list_type, find_by_type, index_by_identity
from py_aep.enums import BlendingMode


CONTROLS = {
    'exposure': '曝光', 'contrast': '对比度', 'saturation': '饱和度', 'temperature': '白平衡',
    'tint': '着色', 'highlights': '高光', 'shadows': '阴影',
}
STAGES = ('contrast', 'temperature', 'tint', 'highlights', 'shadows', 'exposure', 'saturation')
COLOR_LUT = 'ADBE Apply Color LUT2'
LEVELS = 'ADBE Pro Levels2'
INPUT_PREFIX = '输入 · '


def lut_payload(original, table, size, precision):
    """Resize the sampled CLUT in AE's native ICC device link."""
    header, profile = bytearray(original[:28]), bytearray(original[28:])
    tags = struct.unpack_from('>I', profile, 128)[0]
    entry = next(i for i in range(132, 132 + 12 * tags, 12) if profile[i:i+4] == b'A2B0')
    ab, tag_size = struct.unpack_from('>II', profile, entry + 4)
    grid = ab + struct.unpack_from('>I', profile, ab + 24)[0]
    old_size = profile[grid] ** 3 * 3 * profile[grid + 16]
    if len(table) != size ** 3 * 3 * precision:
        raise ValueError('图片调色查找表尺寸错误')
    table += bytes(-len(table) % 4)
    old_size += -old_size % 4
    delta = len(table) - old_size
    profile[grid:grid+3] = bytes([size]) * 3
    profile[grid+16] = precision
    profile[grid+20:grid+20+old_size] = table
    for field in range(ab + 12, ab + 32, 4):
        offset = struct.unpack_from('>I', profile, field)[0]
        if ab + offset > grid:
            struct.pack_into('>I', profile, field, offset + delta)
    struct.pack_into('>I', profile, entry + 8, tag_size + delta)
    struct.pack_into('>I', profile, 0, len(profile))
    struct.pack_into('>I', header, 16, len(profile))
    digest_input = profile.copy()
    for start, length in ((44, 4), (64, 4), (84, 16)):
        digest_input[start:start+length] = bytes(length)
    digest = hashlib.md5(digest_input).digest()
    profile[84:100] = digest
    return bytes(header + profile), digest


@lru_cache(maxsize=1)
def templates():
    raw = Path(__file__).with_name('image-grade-effects.bin').read_bytes()
    lut, levels = read_chunks(io.BytesIO(raw), len(raw))
    return {COLOR_LUT: lut, LEVELS: levels}


def stock_effect(layer, key):
    parade = layer['ADBE Effect Parade']
    return parade._add_installed_effect(key, key, templates()[key])


@lru_cache(maxsize=145)
def sampled_effect(path, size, precision):
    original = find_by_type(templates()[COLOR_LUT].chunks, 'sdat').data
    return lut_payload(original, path.read_bytes(), size, precision)


def apply_lut(layer, path, size, precision):
    effect = stock_effect(layer, COLOR_LUT)
    data, identity = sampled_effect(path, size, precision)
    siblings = layer['ADBE Effect Parade']._tdgp.chunks
    instance = siblings[index_by_identity(siblings, effect._tdmn) + 1]
    find_by_type(instance.chunks, 'sdat').data = data
    find_by_type(instance.chunks, 'pgui').guid = identity


def add_slider(layer, label, value):
    control = layer['ADBE Effect Parade'].add_property('ADBE Slider Control')
    control.name = label
    slider = control['ADBE Slider Control-0001']
    slider.value = value
    # The AE-native static Slider Control has FF FF, required for keyframing.
    slider._tdb4._value_hint_flag = 255
    slider._tdb4._cvot_flags = 255
    return slider


def publish_inputs(comp, layer):
    for label in CONTROLS.values():
        slider = layer['ADBE Effect Parade'][label]['ADBE Slider Control-0001']
        if not slider.add_to_motion_graphics_template_as(comp, INPUT_PREFIX + label):
            raise ValueError('无法连接图片调色属性 ' + label)


def bind_grade_controls(layer, filters):
    """Put the animator's sliders on this instance and drive its source overrides."""
    refs = find_by_list_type(layer._tdgp.chunks, 'OvG2')
    values = layer['ADBE Layer Overrides']._tdgp.chunks
    sliders = {INPUT_PREFIX + label: add_slider(layer, label, filters.get(key, 0) * 100)
               for key, label in CONTROLS.items()}
    # AE uses the controller UUIDs and corresponding value streams in the same
    # order. py-aep 0.19 writes the empty groups, but does not populate them.
    for controller in layer.source.motion_graphics_controllers:
        slider = sliders[controller.name]
        label = controller.name[len(INPUT_PREFIX):]
        slider.expression = 'thisLayer.effect(' + json.dumps(label, ensure_ascii=False) + ')(1);'
        override = deepcopy(slider._tdbs)
        slider.expression = ''
        find_by_type(override.chunks, 'tdsn').chunks[0].value = controller.name
        values[-1:-1] = [TdmnChunk(value=slider.match_name), override]
        refs.chunks.append(ListChunk(list_type='CPrp', chunks=[Utf8Chunk(value=controller.uuid)]))
    # OvG2's CprC count is little-endian inside the big-endian RIFX file.
    find_by_type(refs.chunks, 'CprC').value = int.from_bytes(len(sliders).to_bytes(4, 'little'), 'big')


def near_design_expression(authored, radius):
    # Interpolate actual joint grades around the design. A one-point adjustment
    # then has a first-order response even when several controls are already on.
    return (
        'var ctl=thisComp.layer("Figma 设计值"), labels=' + json.dumps(list(CONTROLS.values()), ensure_ascii=False) +
        ', a=' + json.dumps(authored) + ', r=' + str(radius) + ';\n'
        'var w=[0], distance=0;\n'
        'for(var i=0;i<a.length;i++){\n'
        '  var d=clamp(ctl.effect(labels[i])(1),-100,100)-a[i];\n'
        '  var minus=d<0 ? -d/Math.min(r,100+a[i]) : 0;\n'
        '  var plus=d>0 ? d/Math.min(r,100-a[i]) : 0;\n'
        '  w.push(minus,plus); distance+=minus+plus;\n'
        '}\n'
        'var local=clamp(2-distance,0,1);\n'
        'w[0]=local*Math.max(0,1-distance);\n'
        'for(var j=1;j<w.length;j++) w[j]*=local/Math.max(1,distance);\n'
    )


def build_grade(folder, footage, filters, grade_id, tables, duration, fps):
    # Each group owns its controls. An imported second F2A project can contain
    # identically named Figma artwork without its expressions reading the first.
    name = '图片调色 · ' + uuid.uuid4().hex[:12]
    group = folder.add_folder(name)

    def comp(label):
        return group.add_comp(label, max(4, footage.width), max(4, footage.height), 1, duration, fps)

    output = comp(name)
    target = 'comp(' + json.dumps(name, ensure_ascii=False) + ').layer("Figma 设计值")'

    coverage = comp('混色输入')
    levels = stock_effect(coverage.add(footage), LEVELS)
    levels.name = '混色用 Alpha'
    # Keep empty pixels transparent. Nonzero coverage becomes opaque during RGB
    # interpolation, and the original antialiased coverage is restored once below.
    levels['ADBE Pro Levels2-0033'].value = 1 / 65535  # Alpha Input White.
    previous = coverage
    for key in STAGES:
        stage = comp(CONTROLS[key])
        slider = target + '.effect(' + json.dumps(CONTROLS[key], ensure_ascii=False) + ')(1)'
        for value in range(-100, 101, 10):
            branch = stage.add(previous)
            branch.name = str(value)
            if value:
                apply_lut(branch, tables / f'{key}_{value}.lut', 24, 1)
            # The lower knot is opaque. The one above it fades in across ten units.
            branch.transform.opacity.expression = (
                'var d=clamp(' + slider + ',-100,100)-(' + str(value) + ');\n'
                'd < -10 || d >= 10 ? 0 : d < 0 ? (d+10)*10 : 100;')
        previous = stage

    output.add(previous).name = '全范围调色'
    authored = [filters.get(key, 0) * 100 for key in CONTROLS]
    radius = min(10, sum(abs(v) for v in authored) / 2)
    weights = near_design_expression(authored, radius or 1)
    samples = [(0, 'Figma 设计值', grade_id, 64, 2)]
    for i, (key, label) in enumerate(CONTROLS.items()):
        for offset, direction in enumerate((-1, 1), 1):
            if radius and direction * authored[i] < 100:
                direction_label = '减小' if direction < 0 else '增大'
                samples.append((2*i + offset, label + ' · ' + direction_label, f'{grade_id}_{key}_{direction}', 32, 1))
    for index, label, filename, size, precision in samples:
        layer = output.add(coverage)
        layer.name = label
        apply_lut(layer, tables / (filename + '.lut'), size, precision)
        if index == 0:
            for key, control_label in CONTROLS.items():
                add_slider(layer, control_label, filters.get(key, 0) * 100)
            publish_inputs(output, layer)
        # AE's normal compositing uses opacity relative to the layers below.
        layer.transform.opacity.expression = weights + (
            f'var slot={index}, below=1-local;\n'
            'for(var k=0;k<=slot;k++) below+=w[k];\n'
            'below>0 ? 100*w[slot]/below : 0;')
    stencil = output.add(footage)
    stencil.name = '原图 Alpha'
    stencil.blending_mode = BlendingMode.STENCIL_ALPHA
    return output


def write_import_project(manifest, destination):
    """The CEP importer uses the same native graph as the direct AEP writer."""
    import py_aep
    from py_aep import ImportOptions

    job = json.loads(manifest.read_text(encoding='utf-8'))
    project = py_aep.new('24.0x0').project
    folder = project.root_folder.add_folder('图片调色')
    comps = []
    for image in job['images']:
        footage = project.import_file(ImportOptions(image['source']))
        footage.parent_folder = folder
        comp = build_grade(folder, footage, image['imageFilters'], image['gradeId'], manifest.parent,
                           job['duration'], job['frameRate'])
        comps.append(comp.name)
    project.save(str(destination))
    print(json.dumps(comps, ensure_ascii=True))


if __name__ == '__main__':
    import sys

    write_import_project(Path(sys.argv[1]), Path(sys.argv[2]))
