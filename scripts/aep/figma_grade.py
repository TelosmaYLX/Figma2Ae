"""Write Figma's native image-fill grade as the Figma 调色 effect.

The direct AEP writer does not run inside After Effects, so it cannot ask the
installed plug-in for its parameter table. Instead
``figma-image-grade-effect.bin`` holds the serialized ``LIST:sspc`` definition
of the effect (captured from a project where it is applied, see
``ae-plugin/tests/extract_figma_grade_effect.py``); cloning that definition is
the same path py-aep uses when re-applying an effect a project already defines.

After Effects rewrites the parameter definitions from the installed plug-in when
it opens the project, so the stored copy keeps working across AE releases.
"""

import io
from functools import lru_cache
from pathlib import Path

from py_aep.binary.chunk import read_chunks

MATCH_NAME = 'F2A Figma Image Grade'
DISPLAY_NAME = 'Figma 调色'

# Figma `ImagePaint.filters` key -> the plug-in's slider label. Figma's panel
# value is the stored -1..1 fraction times 100, which is exactly the slider range.
CONTROLS = (
    ('exposure', '曝光'),
    ('contrast', '对比度'),
    ('saturation', '饱和度'),
    ('temperature', '白平衡'),
    ('tint', '着色'),
    ('highlights', '高光'),
    ('shadows', '阴影'),
)


@lru_cache(maxsize=1)
def effect_definition():
    raw = Path(__file__).with_name('figma-image-grade-effect.bin').read_bytes()
    definition, = read_chunks(io.BytesIO(raw), len(raw))
    return definition


def add(layer, filters):
    """Add Figma 调色 to a layer and restore Figma's seven values."""
    effect = layer['ADBE Effect Parade']._add_installed_effect(
        MATCH_NAME, DISPLAY_NAME, effect_definition())
    for key, label in CONTROLS:
        effect[label].value = (filters.get(key) or 0) * 100
    return effect
