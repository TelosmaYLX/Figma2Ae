import json
import math
import sys
from pathlib import Path
import py_aep

app=py_aep.parse(sys.argv[1])
model=json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
def comps(folder):
    for item in folder.items:
        if hasattr(item,'layers'): yield item
        elif hasattr(item,'items'): yield from comps(item)
layers={layer.name:layer for comp in comps(app.project.root_folder) for layer in comp.layers}
def close(a,b):
    assert math.isclose(a,b,abs_tol=1e-6),(a,b)
def point(layer,x,y):
    anchor,position,scale=layer.transform.anchor_point.value,layer.transform.position.value,layer.transform.scale.value
    dx,dy=(x-anchor[0])*scale[0]/100,(y-anchor[1])*scale[1]/100
    angle=math.radians(layer.transform.rotation.value)
    return [position[0]+dx*math.cos(angle)-dy*math.sin(angle),position[1]+dx*math.sin(angle)+dy*math.cos(angle)]
contexts={item['id']:item for item in model['containers']}
def origin(item):
    return next(([contexts[key]['x'],contexts[key]['y']] for key in reversed(item.get('path') or []) if key in contexts),[0,0])
for layer in layers.values():
    if layer.name=='Outside stroke':
        # Offset Paths is not supported by the library's sourceRect implementation.
        close(layer.transform.anchor_point.value[0],0);close(layer.transform.anchor_point.value[1],0)
        continue
    rect=layer.source_rect_at_time(0,False)
    close(layer.transform.anchor_point.value[0],rect['left']+rect['width']/2)
    close(layer.transform.anchor_point.value[1],rect['top']+rect['height']/2)
for item in model['containers']:
    layer=layers[item['name']];bounds=contexts[item['id']];ox,oy=origin(item)
    assert layer.source.width==max(4,math.ceil(item['w']))
    assert layer.source.height==max(4,math.ceil(item['h']))
    assert layer.collapse_transformation == (not bool(item.get('clip')))
    top_left=point(layer,0,0)
    close(top_left[0],bounds['x']-ox);close(top_left[1],bounds['y']-oy)
curve=layers['Bezier shape']
ox,oy=origin(next(item for item in model['shapes'] if item['name']=='Bezier shape'))
close(curve.transform.anchor_point.value[0],90.25)
close(curve.transform.anchor_point.value[1],80.25)
close(point(curve,40.25,50.25)[0],40.25-ox)
close(point(curve,40.25,50.25)[1],50.25-oy)
for item in model['images']:
    layer=layers[item['name']];ox,oy=[0,0] if item.get('reference') else origin(item)
    scales=[item.get('cw',item['w'])/layer.source.width,item.get('ch',item['h'])/layer.source.height]
    wanted=1/item['rasterScale'] if item.get('rasterScale') else (min(scales) if item['scaleMode']=='FIT' else max(scales))
    for value in layer.transform.scale.value[:2]:close(value,wanted*100)
    close(layer.transform.position.value[0],item['cx']-ox);close(layer.transform.position.value[1],item['cy']-oy)
for item in model['texts']:
    layer=layers[item['name']];rect=layer.source_rect_at_time(0,False);box=item.get('ink') or item;ox,oy=origin(item)
    assert layer.collapse_transformation,'Native text must retain continuous rasterization'
    close(layer.transform.rotation.value,item.get('rotation',0))
    if item.get('rotation'):
        wanted=[box['x']+box['w']/2-ox,box['y']+box['h']/2-oy]
        for a,b in zip(layer.transform.position.value,wanted):close(a,b)
    else:
        left=box['x']+({'CENTER':.5,'RIGHT':1}.get(item.get('align'),0))*(box['w']-rect['width'])
        mapped=point(layer,rect['left'],rect['top']+rect['height']/2)
        close(mapped[0],left-ox);close(mapped[1],box['y']+box['h']/2-oy)
print('PASS: parsed AEP anchors centered for Bezier/primitive/text/gradient/mattes/precomps/images; original placement retained; baked PNG follows export scale, photo FIT/FILL unchanged')
