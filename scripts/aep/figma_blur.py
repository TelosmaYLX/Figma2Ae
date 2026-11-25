"""Build the adjustment layer using the plug-in definition captured from AE."""

import io
import math
from functools import lru_cache
from pathlib import Path

from py_aep.binary.chunk import read_chunks
from py_aep.enums import MaskMode
from py_aep.models.properties.shape import Shape

MATCH_NAME = 'F2A Figma Background Blur'


@lru_cache(maxsize=1)
def effect_definition():
    raw = Path(__file__).with_name('figma-background-blur-effect.bin').read_bytes()
    definition, = read_chunks(io.BytesIO(raw), len(raw))
    return definition


def add_adjustment(source, request):
    comp = source.containing_comp
    width, height = (max(1, math.ceil(v)) for v in request['size'])
    layer = comp.add_solid([0, 0, 0], request['name'], width, height)
    layer.adjustment_layer = True
    layer.enabled = request['enabled']
    layer.transform.anchor_point.value = [0, 0, 0]
    layer.transform.position.value = [*request['position'], 0]
    layer.transform.rotation.value = request['rotation']
    layer.transform.scale.value = [*request['scale'], 100]
    layer.transform.opacity.value = request['opacity'] * 100

    atom = layer['ADBE Mask Parade'].add_property('ADBE Mask Atom')
    atom.name = '背景模糊区域'
    atom.mask_mode = MaskMode.ADD
    path = request['maskPath']
    atom['ADBE Mask Shape'].value = Shape(path['verts'], path['inT'], path['outT'], closed=True)

    for values in request['effects']:
        effect = layer['ADBE Effect Parade']._add_installed_effect(
            MATCH_NAME, 'Figma 背景模糊', effect_definition())
        for control, value in zip(effect.properties, values):
            control.value = value

    layer.move_after(source)
    layer.parent = source
