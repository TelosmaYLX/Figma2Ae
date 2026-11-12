import json
import math
import re
import sys
from pathlib import Path
import py_aep

app = py_aep.parse(sys.argv[1])
expected = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
def comps(folder):
    for item in folder.items:
        if hasattr(item, 'layers'):
            yield item
        elif hasattr(item, 'items'):
            yield from comps(item)

layers = {layer.name: layer for comp in comps(app.project.root_folder) for layer in comp.layers}

def close(actual, wanted):
    assert math.isclose(actual, wanted, abs_tol=1e-6), (actual, wanted)

for item in expected['containers']:
    close(layers[item['name']].transform.opacity.value, item['opacity'] * 100)
for item in expected['texts']:
    layer = layers[item['name']]
    close(layer.transform.opacity.value, 100 if item.get('grad') else item['opacity'] * 100)
    segments = item.get('segs') or [{'characters': item['characters'], 'opacity': item['fillOpacity']}]
    start, wanted = 0, []
    for segment in segments:
        visible = re.sub(r'[\r\n\u0003\u2028\u2029\u000b\u000c\u0085]', '', segment['characters'])
        end = start + len(visible.encode('utf-16-le')) // 2
        if segment.get('opacity', 1) < 1:
            wanted.append((segment['opacity'] * 100, start, end))
        start = end
    actual = []
    for animator in layer['ADBE Text Properties']['ADBE Text Animators']:
        properties = animator['ADBE Text Animator Properties']
        selector = list(animator['ADBE Text Selectors'])[0]
        advanced = selector['ADBE Text Range Advanced']
        close(advanced['ADBE Text Range Units'].value, 2)
        close(advanced['ADBE Text Selector Smoothness'].value, 0)
        actual.append((properties['ADBE Text Fill Opacity'].value, selector['ADBE Text Index Start'].value, selector['ADBE Text Index End'].value))
    assert len(actual) == len(wanted), (item['name'], actual, wanted)
    if item['name'] == 'Rich box':
        assert actual[1][1] == 2, 'The paragraph break must not shift the second run'
    for values, targets in zip(actual, wanted):
        for value, target in zip(values, targets):
            close(value, target)
    if item.get('grad'):
        fill = layers[item['name'] + ' gradient']
        close(fill.transform.opacity.value, item['opacity'] * 100)
        def walk(group):
            for prop in group:
                if prop.match_name == 'ADBE Vector Fill Opacity':
                    close(prop.value, item['grad']['opacity'] * 100)
                if hasattr(prop, 'num_properties'):
                    walk(prop)
        walk(fill['ADBE Root Vectors Group'])
print('PASS: parsed AEP stores separate layer/fill alpha, exact per-run selector ranges and gradient paint alpha')
