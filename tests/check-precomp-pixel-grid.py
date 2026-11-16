import json
import sys
from pathlib import Path

if sys.argv[1] == '--renders':
    from PIL import Image, ImageChops
    directory = Path(sys.argv[2])
    flat = Image.open(directory/'grid-flat_00000.png').convert('RGBA')
    nested = Image.open(directory/'grid-nested_00000.png').convert('RGBA')
    assert ImageChops.difference(flat, nested).getbbox(alpha_only=False) is None
    print('PASS: real AE flat and three-level nested bitmap renders are pixel-identical RGBA')
    raise SystemExit

import py_aep

fixture = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
app = py_aep.parse(fixture['nested']['project'])
main = next(c for c in app.project.compositions if c.name == 'Pixel grid nested')
seen = []

def inspect(comp, offset=(0, 0)):
    for layer in comp.layers:
        p, a, s = layer.transform.position.value, layer.transform.anchor_point.value, layer.transform.scale.value
        origin = [offset[i] + p[i] - a[i] * s[i] / 100 for i in (0, 1)]
        if hasattr(getattr(layer, 'source', None), 'layers'):
            assert all(abs(v-round(v)) < 1e-6 for v in origin), (layer.name, origin)
            assert not layer.collapse_transformation
            inspect(layer.source, origin)
        elif layer.name == 'Sharp alpha edge':
            assert origin == [8, 8], origin
            assert s[:2] == [100, 100]
            seen.append(layer.name)

inspect(main)
assert len(seen) == 1
print('PASS: precomp origins are integral; actual image origin is still [8,8] at 100%')
