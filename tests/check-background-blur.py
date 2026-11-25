import sys

import py_aep
from py_aep.enums import MaskMode

project = py_aep.parse(sys.argv[1]).project
adjustment, = [layer for comp in project.compositions for layer in comp.layers if layer.adjustment_layer]
card = adjustment.parent
assert card.name == 'Card'
assert adjustment.index == card.index + 1
assert (adjustment.source.width, adjustment.source.height) == (120, 80)
mask, = adjustment['ADBE Mask Parade'].properties
assert mask.mask_mode == MaskMode.ADD
shape = mask['ADBE Mask Shape'].value
assert shape.closed and [list(v) for v in shape.vertices] == [[0, 0], [120, 0], [120, 80], [0, 80]]
effect = adjustment['ADBE Effect Parade']['F2A Figma Background Blur']
assert [p.value for p in effect.properties[:8]] == [2, 0, 0, 36, 20, 10, 80, 90]
assert effect.properties[9].value == 0
expected = (63.75, 52.5) if sys.argv[2] == 'flat' else (32.75, 22.5)
assert tuple(adjustment.source_point_to_comp([0, 0])) == expected
x, y, z = card.transform.position.value
card.transform.position.value = [x + 20, y + 12, z]
assert tuple(adjustment.source_point_to_comp([0, 0])) == (expected[0] + 20, expected[1] + 12)
