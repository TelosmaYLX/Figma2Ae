import sys
import py_aep
from py_aep.enums import TrackMatteType

app=py_aep.parse(sys.argv[1])
def comps(folder):
    for item in folder.items:
        if hasattr(item,'layers'):yield item
        elif hasattr(item,'items'):yield from comps(item)

all_comps=list(comps(app.project.root_folder))
layers=[layer for comp in all_comps for layer in comp.layers]
outer=[layer for layer in layers if layer.track_matte_layer is not None and layer.track_matte_layer.name=='image_381']
assert len(outer)==1,len(outer)
scope=outer[0]
assert scope.name=='image 381 内容'
assert scope.track_matte_type==TrackMatteType.ALPHA
assert not scope.collapse_transformation
assert not scope.track_matte_layer.enabled
# The writer retains a non-painting image-slot shape next to its real footage.
assert sorted(layer.name for layer in scope.source.layers)==['image 383 angle','image_383_angle','point 0','point 1','point 2','point 3'],[(layer.name,str(layer.track_matte_layer)) for layer in scope.source.layers]
for i in range(4):
    point=next(layer for layer in scope.source.layers if layer.name=='point '+str(i))
    assert point.track_matte_layer is None
    photo=next(layer for layer in point.source.layers if layer.name=='image_379_'+str(i))
    assert (photo.source.width,photo.source.height)==(160,80)
    assert photo.track_matte_layer is not None
    assert photo.track_matte_type==(TrackMatteType.LUMA if i==3 else TrackMatteType.ALPHA)
    assert not photo.track_matte_layer.enabled
angle=next(layer for layer in scope.source.layers if layer.name=='image_383_angle')
assert angle.track_matte_layer is None
kv=next(comp for comp in all_comps if comp.name=='KV')
assert 'unmasked background' in [layer.name for layer in kv.layers]
assert 'next_photo' in [layer.name for layer in kv.layers]
assert 'image 381 内容' in [layer.name for layer in kv.layers]
kv_layer=next(layer for layer in layers if layer.name=='KV')
assert abs(kv_layer.transform.opacity.value-80)<.001
print('PASS: AEP has one shared outer matte, four original-image inner mattes, independent next scope, group opacity and nested geometry')
