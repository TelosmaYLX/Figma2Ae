from pathlib import Path
import json
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parents[1]
out = root / 'artifacts/card-brightness'
card = next(c for c in json.loads((out/'project-before.json').read_text(encoding='utf8'))['comps'] if c['name']=='pinball_game-card')
paths = list(Path('D:/Users/图片/temp').glob('*.png'))
sizes = {}
for p in paths:
    try:
        with Image.open(p) as im: sizes.setdefault(im.size, []).append(p)
    except OSError: pass
matches = []
for i, layer in enumerate(reversed(card['layers'][1:])):
    s = layer['source']
    if not s: continue
    target = np.asarray(Image.open(out/f'source-{i:02}.png').convert('RGBA')).astype(float)
    best = None
    for p in sizes.get((s['width'],s['height']), []):
        im = Image.open(p).convert('RGBA')
        scale = layer['scale'][0]/100
        im = im.resize((round(im.width*scale),round(im.height*scale)),Image.Resampling.BICUBIC)
        x = round(layer['position'][0]-layer['anchor'][0]*scale-100)
        y = round(layer['position'][1]-layer['anchor'][1]*scale-100)
        canvas = Image.new('RGBA',(88,136));canvas.paste(im,(x,y))
        error = float(abs(np.asarray(canvas).astype(float)-target).mean())
        if best is None or error<best[0]: best=(error,p)
        if error==0: break
    if best is None or best[0] != 0: raise RuntimeError(f'Cannot recover exact rendered source: {layer["name"]}, {best}')
    dest=out/'verified-assets'/f'{i:02}.png';dest.parent.mkdir(exist_ok=True)
    dest.write_bytes(best[1].read_bytes())
    matches.append({'index':layer['index'],'name':layer['name'],'file':str(dest),'originalCandidate':str(best[1]),'renderedPixelError':best[0]})
(out/'verified-assets.json').write_text(json.dumps(matches,ensure_ascii=False,indent=2),encoding='utf8')
print(f'Recovered {len(matches)} assets with exact rendered pixel matches')
