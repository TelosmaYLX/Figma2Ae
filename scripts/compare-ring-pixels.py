"""Compare actual AE renders with the untouched Figma reference."""
import json
import sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent.parent
directory = Path(sys.argv[1]) if len(sys.argv) > 1 else root/'artifacts/owcs-ring-pixels-20261116'
reference = Image.open(root/'artifacts/owcs-card-color-20261116/figma-live.png').convert('RGBA')
expected = np.asarray(reference, dtype=float)
regions = {'all': (2, 2, 86, 134), 'ring': (21, 33, 67, 79), 'lower-kv': (8, 92, 80, 126)}
metrics = {}
names = ['before', 'aligned', 'path-stroke', 'no-clip', 'fixed', 'host-fixed', 'fresh-export']
for name in names:
    file = directory/(name+'_00000.png')
    if not file.exists():
        continue
    actual = np.asarray(Image.open(file).convert('RGBA'), dtype=float)
    metrics[name] = {}
    for region, (x0, y0, x1, y1) in regions.items():
        delta = (actual-expected)[y0:y1, x0:x1, :3]
        metrics[name][region] = {'mae': float(np.abs(delta).mean()), 'bias': delta.mean(axis=(0, 1)).tolist()}

font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 19)
canvas = Image.new('RGB', (900, 535), '#292929')
draw = ImageDraw.Draw(canvas)
for index, (name, label) in enumerate([('figma', 'Figma 原稿'), ('before', '修复前 AEP'), ('fresh-export', '本次正常导出的 AEP')]):
    image = reference if name == 'figma' else Image.open(directory/(name+'_00000.png')).convert('RGBA')
    thumb = image.resize((264, 408), Image.Resampling.NEAREST)
    canvas.paste(thumb, (index*300+18, 50), thumb)
    draw.text((index*300+18, 12), label, font=font, fill='white')
    error = 0 if name == 'figma' else metrics[name]['ring']['mae']
    draw.text((index*300+18, 480), '圆环区误差 %.3f' % error, font=font, fill='white')
canvas.save(directory/'comparison-final.png')
(directory/'metrics.json').write_text(json.dumps(metrics, indent=2), encoding='utf-8')
for name, result in metrics.items():
    print(name, {key: round(value['mae'], 6) for key, value in result.items()})
