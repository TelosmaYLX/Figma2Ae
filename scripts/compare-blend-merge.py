from pathlib import Path
import json
import numpy as np
from PIL import Image, ImageDraw, ImageFont

out = Path(__file__).resolve().parents[1] / 'artifacts/blend-merge'
native = json.loads((out / 'native-report.json').read_text(encoding='utf-8'))
assert native['passed'], native
target = Image.open(out / 'reference.png').convert('RGB')
before = Image.open(out / 'before.png').convert('RGB')
after = Image.open(out / 'after.png').convert('RGB')
assert target.size == before.size == after.size == (88, 136)
y, x = np.mgrid[:136, :88]
mask = (x >= 3) & (x < 85) & (y >= 3) & (y < 133) & (((x - 43.29)**2 + (y - 56.13)**2) > 42**2) & ~((x > 52) & (y < 25))
def error(image):
    delta = np.asarray(image).astype(float)[mask] - np.asarray(target).astype(float)[mask]
    return {'mean_absolute_rgb_error': float(abs(delta).mean()), 'luma_bias': float((delta @ np.array([.2126, .7152, .0722])).mean())}
report = {'scope': native['scope'], 'background_pixels': int(mask.sum()), 'before': error(before), 'after': error(after), 'native': native}
report['error_reduction_percent'] = 100 * (1 - report['after']['mean_absolute_rgb_error'] / report['before']['mean_absolute_rgb_error'])
assert report['after']['mean_absolute_rgb_error'] < report['before']['mean_absolute_rgb_error'], report
(out / 'metrics.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
sheet = Image.new('RGB', (840, 464), '#eceff3')
draw = ImageDraw.Draw(sheet)
font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 21)
for i, (label, im) in enumerate([('独立叠加 · AE', before), ('合并背景 · AE', after), ('Figma 原图', target)]):
    draw.text((i * 280 + 10, 10), label, fill='#25313d', font=font)
    sheet.paste(im.resize((264, 408), Image.Resampling.NEAREST), (i * 280 + 8, 47))
sheet.save(out / 'comparison.png')
print(json.dumps({k: v for k, v in report.items() if k != 'native'}, ensure_ascii=False, indent=2))
