from pathlib import Path
import json, shutil
from PIL import Image
root=Path(__file__).resolve().parents[1]
folder=root/'artifacts/fidelity'
source=folder/'images-round2.json'
if not source.exists():shutil.copyfile(folder/'images.json',source)
images=json.loads(source.read_text(encoding='utf8'))
result=[];row=0
for image in images:
    if image['name']!='光效':result.append(image);continue
    for index,kind in enumerate(['base','soft0','soft1']):
        im=dict(image);im['file']=f'row{row}-{kind}.png'
        im['name']='光效' if index==0 else f'光效 柔光 {index}'
        im['blend']='NORMAL' if index==0 else 'SOFT_LIGHT'
        im['z']=image['z']+index/10
        src=folder/'light-passes'/im['file']
        shutil.copyfile(src,folder/'assets'/im['file'])
        im['natW'],im['natH']=Image.open(src).size
        result.append(im)
    row+=1
(folder/'images.json').write_text(json.dumps(result,ensure_ascii=False),encoding='utf8')
print('Prepared',row,'lights as separate normal and soft-light passes')
