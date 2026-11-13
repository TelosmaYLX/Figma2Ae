import sys
import py_aep
from py_aep.models import ShapeLayer
app=py_aep.parse(sys.argv[1])
layers={l.name:l for c in app.project.compositions for l in c.layers}
filled=layers['Rectangle 7']
assert isinstance(filled,ShapeLayer)
assert abs(filled.transform.opacity.value-60)<.001
groups=list(filled['ADBE Root Vectors Group'])
assert len(groups)==2
outline=groups[0]['ADBE Vectors Group']
assert len([p for p in outline if p.match_name=='ADBE Vector Shape - Group'])==10
paint=outline['ADBE Vector Graphic - Fill']
assert abs(paint['ADBE Vector Fill Opacity'].value-80)<.001
for name in ['Rectangle 7','Border only','Round line','Rotated','Masked dash','Thin inside','Thin outside','Thin text','Gradient dash']:
    assert isinstance(layers[name],ShapeLayer)
    for group in layers[name]['ADBE Root Vectors Group']:
        assert all(p.match_name!='ADBE Vector Graphic - Stroke' for p in group['ADBE Vectors Group'])
assert layers['Masked dash'].track_matte_layer is not None
assert layers['Solid style']['ADBE Layer Styles']['frameFX/enabled'].enabled
assert all('细描边' not in c.name for c in app.project.compositions)
print('PASS: real AEP keeps filled dash contours, paint order/alpha, masks and native solid Stroke')
