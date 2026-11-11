from pathlib import Path
import json
from PIL import Image,ImageChops,ImageStat
root=Path(__file__).resolve().parents[1]
folder=root/'artifacts/fidelity'
ref=Image.open(root/'SampleProject/pinball_game_container.png').convert('RGB')
renders={name:Image.open(folder/(name+'.png')).convert('RGB') for name in ['after','final']}
boxes={'subtitle':(120,73,480,105),'cards':(460,931,535,1018)}
for row,y in enumerate([348,465,582,700]):boxes['light'+str(row)]=(692,y,806,y+107)
result={}
for name,box in boxes.items():
    result[name]={stage:round(sum(ImageStat.Stat(ImageChops.difference(im.crop(box),ref.crop(box))).mean)/3,3) for stage,im in renders.items()}
(folder/'final-metrics.json').write_text(json.dumps(result,indent=2),encoding='utf8')
print(json.dumps(result,indent=2))
