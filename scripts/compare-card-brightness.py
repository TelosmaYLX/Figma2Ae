from pathlib import Path
import json
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageChops

out = Path(__file__).resolve().parents[1] / 'artifacts/card-brightness'
target = Image.open(out / 'reference.png').convert('RGB')
before = Image.open(out / 'before.png').convert('RGB').crop((100, 100, 188, 236))
after = Image.open(out / 'after.png').convert('RGB').crop((100, 100, 188, 236))
before.save(out / 'before-card.png')
after.save(out / 'after-card.png')
b = np.asarray(target).astype(float)
y, x = np.mgrid[:136, :88]
interior = (x >= 3) & (x < 85) & (y >= 3) & (y < 133)
background = interior & (((x - 43.29)**2 + (y - 56.13)**2) > 42**2) & ~((x > 52) & (y < 25))

def metrics(image, mask):
    values = np.asarray(image).astype(float)
    d = values[mask] - b[mask]
    return {'mean_absolute_rgb_error': float(abs(d).mean()), 'rgb_bias': d.mean(axis=0).tolist(),
            'luma_bias': float((d @ np.array([.2126, .7152, .0722])).mean())}

report = {'range': '0-255 per RGB channel', 'card_pixels': int(interior.sum()), 'background_pixels': int(background.sum()),
          'before': {'card': metrics(before, interior), 'background': metrics(before, background)},
          'after': {'card': metrics(after, interior), 'background': metrics(after, background)}}
for region in ['card', 'background']:
    report[region + '_error_reduction_percent'] = 100 * (1 - report['after'][region]['mean_absolute_rgb_error'] / report['before'][region]['mean_absolute_rgb_error'])
report['verification'] = json.loads((out / 'ae-report.json').read_text(encoding='utf8'))
(out / 'metrics.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 21)
sheet = Image.new('RGB', (840, 464), '#eceff3'); draw = ImageDraw.Draw(sheet)
for i, (label, im) in enumerate([('修复前 · AE', before), ('修复后 · AE', after), ('Figma 原图', target)]):
    draw.text((i * 280 + 10, 10), label, fill='#25313d', font=font)
    sheet.paste(im.resize((264, 408), Image.Resampling.NEAREST), (i * 280 + 8, 47))
sheet.save(out / 'comparison.png')
ImageChops.difference(after, target).save(out / 'difference-after.png')
print(json.dumps(report, ensure_ascii=False, indent=2))
