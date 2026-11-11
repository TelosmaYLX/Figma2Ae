from pathlib import Path
import json
from PIL import Image, ImageChops, ImageDraw, ImageStat

root = Path(__file__).resolve().parents[1]
out = root / 'artifacts' / 'fidelity'
images = [Image.open(out / 'before.png').convert('RGB'),
          Image.open(out / 'after.png').convert('RGB'),
          Image.open(root / 'SampleProject' / 'pinball_game_container.png').convert('RGB')]
width, height = images[-1].size
sheet = Image.new('RGB', (width * 3, height + 36), 'white')
draw = ImageDraw.Draw(sheet)
for index, (label, image) in enumerate(zip(['Before (AE)', 'After (AE)', 'Figma reference'], images)):
    draw.text((index * width + 12, 10), label, fill='#202830')
    sheet.paste(image, (index * width, 36))
sheet.save(out / 'comparison.png')
ImageChops.difference(images[1], images[2]).save(out / 'difference-after.png')
regions = {'music': (747, 26, 807, 82), 'bonus4': (123, 723, 177, 750),
           'bonus10': (729, 840, 796, 883), 'limit1': (717, 417, 781, 444),
           'limit2': (717, 533, 781, 561), 'limit3': (717, 651, 781, 679),
           'limit4': (717, 768, 781, 796)}
stats = {}
for name, box in regions.items():
    errors = []
    target = images[2].crop(box)
    for image in images[:2]:
        errors.append(round(sum(ImageStat.Stat(ImageChops.difference(image.crop(box), target)).mean) / 3, 3))
    stats[name] = {'mean_error_before': errors[0], 'mean_error_after': errors[1],
                   'reduction_percent': round((1 - errors[1] / errors[0]) * 100, 1)}
(out / 'visual-metrics.json').write_text(json.dumps(stats, indent=2), encoding='utf8')
print(json.dumps(stats, indent=2))
