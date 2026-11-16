import json
from pathlib import Path
import numpy as np
from PIL import Image

root = Path(__file__).resolve().parent.parent / 'artifacts/aep-versions'
cases = json.loads((root / 'cases.json').read_text(encoding='utf-8'))
metrics = {}
for kind in {case['kind'] for case in cases}:
    baseline = next(case for case in cases if case['kind'] == kind and case['aeVersion'] == '26.0')
    pixels = np.asarray(Image.open(root / (baseline['name'] + '_00000.png')).convert('RGBA')).astype(int)
    for case in cases:
        if case['kind'] != kind or case['aeVersion'] == '26.0':
            continue
        other = np.asarray(Image.open(root / (case['name'] + '_00000.png')).convert('RGBA')).astype(int)
        diff = abs(pixels - other)
        metrics[case['name']] = {'maxRGBA': int(diff.max()), 'meanRGBA': float(diff.mean())}
        assert not np.any(diff), (case['name'], metrics[case['name']])
(root / 'render-metrics.json').write_text(json.dumps(metrics, indent=2), encoding='utf-8')
print('PASS: each 24.x/25.x render matches its 26.x baseline pixel for pixel')
