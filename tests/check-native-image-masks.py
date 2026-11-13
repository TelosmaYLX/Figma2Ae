import sys
import py_aep
from py_aep.enums import TrackMatteType

app=py_aep.parse(sys.argv[1])

def comps(folder):
    for item in folder.items:
        if hasattr(item,'layers'):yield item
        elif hasattr(item,'items'):yield from comps(item)

layers=[layer for comp in comps(app.project.root_folder) for layer in comp.layers]
for name in ['Vector_photo','Bitmap mask 内容','Luma_photo','Cropped_photo','Grouped content']:
    matching=[layer for layer in layers if layer.name==name and layer.track_matte_layer is not None
              and (layer.track_matte_layer.name.endswith('_mask') or layer.track_matte_layer.name.endswith(' Figma matte'))]
    assert len(matching)==1,(name,[(l.name,l.track_matte_layer) for l in layers if l.name==name])
    target=matching[0]
    assert target.track_matte_type==(TrackMatteType.LUMA if name=='Luma_photo' else TrackMatteType.ALPHA),name
    assert not target.track_matte_layer.enabled,name
shared=next(layer for layer in layers if layer.name=='Bitmap mask 内容')
assert not shared.collapse_transformation
assert all(layer.track_matte_layer is None for layer in shared.source.layers if layer.name in ['Bitmap_photo','Masked label'])
crop=next(layer for layer in layers if layer.name=='Cropped_photo' and layer.source and not hasattr(layer.source,'layers'))
for name in ['Vector_photo','Bitmap_photo','Luma_photo','Cropped_photo','Grouped_photo']:
    original=next(layer for layer in layers if layer.name==name and layer.source and not hasattr(layer.source,'layers'))
    assert (original.source.width,original.source.height)==(160,80),name
assert crop.transform.scale.value[:2]==[100,100]
assert crop.transform.position.value[:2]==[60,28],crop.transform.position.value
assert crop.track_matte_layer is not None
print('PASS: parsed AEP retains independent alpha/luma/vector mattes, masked text, original source dimensions and nested image crop')
