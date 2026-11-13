import json
import sys
import py_aep

app = py_aep.parse(sys.argv[1])
model = json.load(open(sys.argv[2], encoding='utf-8'))
comp = next(c for c in app.project.compositions if c.name == model['name'])
layers = {layer.name: layer for layer in comp.layers}

def close(a, b):
    assert abs(a - b) < .001, (a, b)

for item in model['shapes'] + model['texts']:
    stroke = item.get('layerStroke') or (item.get('stroke') if 'characters' in item else None)
    if not stroke:
        continue
    layer = layers[item['name']]
    styles = layer['ADBE Layer Styles']
    style = styles['frameFX/enabled']
    assert styles.enabled and style.enabled and not style._tdsb.hidden
    close(style['frameFX/size'].value, stroke['width'])
    close(style['frameFX/style'].value, {'OUTSIDE': 1, 'INSIDE': 2, 'CENTER': 3}[stroke['align']])
    close(style['frameFX/opacity'].value, stroke.get('opacity', 1) * 100)
    for a, b in zip(style['frameFX/color'].value[:3], stroke['color']):
        close(a, b)
    fill_opacity = item.get('layerFillOpacity', item.get('fillOpacity', 1))
    close(styles['ADBE Blend Options Group']['ADBE Adv Blend Group']['ADBE Layer Fill Opacity2'].value, fill_opacity * 100)
    if 'characters' in item:
        assert not layer['ADBE Text Properties']['ADBE Text Document'].value.apply_stroke
print('PASS: binary AEP readback retains enabled native Stroke, all positions/colors/sizes/alpha and separate fill opacity')
