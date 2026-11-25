"""Write Figma's backdrop blur as the Figma 背景模糊 effect.

The direct AEP writer does not run inside After Effects, so it cannot ask the
installed plug-in for its parameter table. Instead
``figma-background-blur-effect.bin`` holds the serialized ``LIST:sspc``
definition of the ``F2A Figma Background Blur`` effect (captured from a project
where it is applied, see ``ae-plugin/tests/extract_figma_background_blur_effect.py``);
cloning that definition is the same path py-aep uses when re-applying an effect
a project already defines.

After Effects rewrites the parameter definitions from the installed plug-in when
it opens the project, so the stored copy keeps working across AE releases.

The effect belongs on an adjustment layer above the artwork it blurs, with a
mask standing in for Figma's fill silhouette (``mask mode``; ``Alpha源`` stays
the default *none*). ``scripts/aep/writer.py`` builds that layer.
"""

import io
from functools import lru_cache
from pathlib import Path

from py_aep.binary.chunk import read_chunks

MATCH_NAME = 'F2A Figma Background Blur'
DISPLAY_NAME = 'Figma 背景模糊'

# The plug-in declares its user parameters in this order (0-based as py-aep
# lists them; the trailing ADBE Effect Built In Params group is not stored
# here). 渐变 offsets are Figma's 0..1 node-box fractions, shown as percentages.
CONTROLS = (
    (0, '模式'),                 # 1 均匀 / 2 渐变
    (1, '背景模糊半径 (px)'),
    (2, '开始半径 (px)'),
    (3, '结束半径 (px)'),
    (4, '渐变起点 X (%)'),
    (5, '渐变起点 Y (%)'),
    (6, '渐变终点 X (%)'),
    (7, '渐变终点 Y (%)'),
    (8, '柔化边缘 (AA)'),
    (9, 'Alpha源'),              # mask mode keeps this at its default: none (0)
)
MODE_UNIFORM = 1
MODE_PROGRESSIVE = 2


@lru_cache(maxsize=1)
def effect_definition():
    raw = Path(__file__).with_name('figma-background-blur-effect.bin').read_bytes()
    definition, = read_chunks(io.BytesIO(raw), len(raw))
    return definition


def parameter_values(blur):
    """The nine driven plug-in values for one ``backgroundBlurs`` request.

    ``blur`` follows scripts/aep/background-blur-export.md: ``mode`` (uniform /
    progressive), ``radius`` and the progressive ring (``startRadius``,
    ``endRadius``, ``startOffset`` / ``endOffset`` as 0..1 box fractions).
    """
    start = blur.get('startOffset') or [0.5, 0]
    end = blur.get('endOffset') or [0.5, 1]
    return [
        MODE_UNIFORM if blur.get('mode') == 'uniform' else MODE_PROGRESSIVE,
        float(blur.get('radius') or 0),
        float(blur.get('startRadius') or 0),
        float(blur.get('endRadius') or 0),
        float(start[0]) * 100,
        float(start[1]) * 100,
        float(end[0]) * 100,
        float(end[1]) * 100,
        # 柔化边缘 (AA) stays hard: the AE mask supplies Figma's anti-aliased edge.
        0.0,
        # 9 (Alpha源) keeps the plug-in default: mask mode, no alpha source layer.
    ]


def add(layer, blur):
    """Add Figma 背景模糊 to an adjustment layer and restore Figma's values."""
    effect = layer['ADBE Effect Parade']._add_installed_effect(
        MATCH_NAME, DISPLAY_NAME, effect_definition())
    for index, value in enumerate(parameter_values(blur)):
        effect.properties[index].value = value
    return effect
