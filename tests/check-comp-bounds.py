import json
import math
import sys
from pathlib import Path

import py_aep

fixture = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
model = fixture['model']
project = py_aep.parse(fixture['project']).project
definitions = {item['name']: item for item in model['containers']}


def close(a, b):
    assert math.isclose(a, b, abs_tol=1e-6), (a, b)


def find_main(folder):
    for item in folder.items:
        if hasattr(item, 'layers') and item.name == model['name'] and item.parent_folder.name == model['name']:
            return item
        if hasattr(item, 'items'):
            found = find_main(item)
            if found:
                return found


def inspect(comp, offset=(0, 0)):
    count = 0
    for layer in comp.layers:
        if hasattr(getattr(layer, 'source', None), 'layers'):
            expected = definitions[layer.name]
            source = layer.source
            assert (source.width, source.height) == (max(4, math.ceil(expected['w'])), max(4, math.ceil(expected['h'])))
            assert layer.collapse_transformation == (not bool(expected['clip']))
            anchor, position = layer.transform.anchor_point.value, layer.transform.position.value
            close(anchor[0], source.width / 2)
            close(anchor[1], source.height / 2)
            origin = (offset[0] + position[0] - anchor[0], offset[1] + position[1] - anchor[1])
            close(origin[0], expected['x'])
            close(origin[1], expected['y'])
            count += 1 + inspect(source, origin)
    return count


assert inspect(find_main(project.root_folder)) == len(definitions)
print('PASS: real AEP retains all 6 original boxes, centered anchors, exact nested placement and clipping flags')

if '--renders' in sys.argv[2:]:
    from PIL import Image, ImageChops

    directory = Path(fixture['directory'])
    reference = Image.open(directory / 'reference.png').convert('RGBA')
    for name in ('native', 'aep'):
        rendered = Image.open(directory / (name + '.png')).convert('RGBA')
        assert rendered.size == reference.size
        difference = ImageChops.difference(reference, rendered)
        extrema = difference.getextrema()
        assert max(high for low, high in extrema) <= 1, (name, extrema, difference.getbbox())
        print('PASS:', name, 'render matches the flat reference, including group opacity, visible overflow and clipping')
