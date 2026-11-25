"""Dump the Figma 背景模糊 effect definition out of a saved AEP.

The direct AEP writer (``scripts/aep/figma_blur.py``) can only add effects that
are already defined in the project, so it stores the effect's serialized
``LIST:sspc`` definition in ``scripts/aep/figma-background-blur-effect.bin``.
The definition mirrors the first applied instance, which is why it has to come
from a project where ``F2A Figma Background Blur`` is applied (the demo projects
built by the FigmaBackgroundBlur plug-in tests do that, e.g.
``FigmaBackgroundBlurPlugin_Demo.aep``, composite ``DEMO_Progressive``).

Usage:
    python ae-plugin/tests/extract_figma_background_blur_effect.py <project.aep> [out.bin]

After Effects rewrites the parameter table from the installed plug-in when it
opens a project, so the stored definition keeps working across AE releases.
"""

import io
import sys
from pathlib import Path

from py_aep.binary.chunk import ListChunk, read_aep, write_chunk
from py_aep.binary.utils import find_by_type

MATCH_NAME = "F2A Figma Background Blur"


def lists(chunk, list_type):
    """Yield every LIST of ``list_type`` in the chunk tree."""
    if isinstance(chunk, ListChunk):
        if chunk.list_type == list_type:
            yield chunk
        for child in chunk.chunks:
            yield from lists(child, list_type)


def extract(project_path):
    """Return the raw ``LIST:sspc`` bytes of the Figma 背景模糊 effect definition."""
    rifx, _xmp = read_aep(io.BytesIO(Path(project_path).read_bytes()))
    definition = None
    for efdg in lists(rifx, "EfdG"):
        for efd in lists(efdg, "EfDf"):
            tdmn = find_by_type(efd.chunks, "tdmn")
            if tdmn is not None and tdmn.value == MATCH_NAME:
                definition = efd
    if definition is None:
        raise SystemExit(f"no {MATCH_NAME} effect in {project_path}")
    sspc = next(chunk for chunk in definition.chunks
                if isinstance(chunk, ListChunk) and chunk.list_type == "sspc")
    buffer = io.BytesIO()
    write_chunk(buffer, sspc)
    return buffer.getvalue()


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    data = extract(sys.argv[1])
    target = Path(sys.argv[2] if len(sys.argv) > 2 else
                  Path(__file__).resolve().parents[2] / "scripts/aep/figma-background-blur-effect.bin")
    target.write_bytes(data)
    print("wrote", target, len(data), "bytes")


if __name__ == "__main__":
    main()
