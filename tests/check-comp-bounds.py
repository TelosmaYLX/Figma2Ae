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
            if layer.name=='Unclipped frame': expected={**expected,'x':6,'y':186,'w':111,'h':71}
            if layer.name=='Faded frame': expected={**expected,'x':10,'y':10,'w':103,'h':83}
            source = layer.source
            left, top = math.floor(expected['x']), math.floor(expected['y'])
            assert (source.width, source.height) == (max(4, math.ceil(expected['x']+expected['w'])-left),
                                                    max(4, math.ceil(expected['y']+expected['h'])-top))
            assert not layer.collapse_transformation
            anchor, position = layer.transform.anchor_point.value, layer.transform.position.value
            close(anchor[0], source.width / 2)
            close(anchor[1], source.height / 2)
            origin = (offset[0] + position[0] - anchor[0], offset[1] + position[1] - anchor[1])
            close(origin[0], left)
            close(origin[1], top)
            count += 1 + inspect(source, origin)
    return count


assert inspect(find_main(project.root_folder)) == len(definitions)
print('PASS: real AEP keeps collapse off, expands unclipped content/stroke bounds and retains clipping/placement')

if '--renders' in sys.argv[2:]:
    from PIL import Image, ImageChops

    render_index = sys.argv.index('--renders')
    directory = Path(sys.argv[render_index + 1]) if len(sys.argv) > render_index + 1 else Path(fixture['directory'])
    reference = Image.open(directory / 'reference.png').convert('RGBA')
    regions = {'groupOpacity': (5, 5, 118, 100), 'overflowAndStroke': (3, 183, 118, 262),
               'explicitClip': (388, 188, 520, 280)}
    report = {}
    for name in ('native', 'aep'):
        rendered = Image.open(directory / (name + '.png')).convert('RGBA')
        assert rendered.size == reference.size
        report[name] = {}
        # These integer-aligned regions test compositing and clipping independently of
        # the fractional button's additional default precomp sampling at its edges.
        for label, box in regions.items():
            error = max(high for low, high in ImageChops.difference(reference.crop(box), rendered.crop(box)).getextrema())
            report[name][label] = error
            assert error <= 1, (name, label, error)
        print('PASS:', name, 'render retains overflow/stroke, group opacity and explicit clipping')
    if (directory / 'before.png').exists():
        previous = Image.open(directory / 'before.png').convert('RGBA')
        report['before'] = {label: max(high for low, high in ImageChops.difference(reference.crop(box), previous.crop(box)).getextrema()) for label, box in regions.items()}
        assert report['before']['overflowAndStroke'] > 32
    delta = ImageChops.difference(Image.open(directory / 'native.png').convert('RGBA'), Image.open(directory / 'aep.png').convert('RGBA'))
    assert max(high for low, high in delta.getextrema()) == 0
    (directory / 'render-report.json').write_text(json.dumps({'passed': True, 'errors': report}, indent=2), encoding='utf-8')
