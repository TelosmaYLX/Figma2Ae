"""Dump the Figma 调色 effect definition out of a saved AEP.

The direct AEP writer (``scripts/aep/figma_grade.py``) can only add effects that
are already defined in the project, so it stores the effect's serialized
``LIST:sspc`` definition in ``scripts/aep/figma-image-grade-effect.bin``. The
definition mirrors the first applied instance, which is why it has to come from a
project where ``F2A Figma Image Grade`` is applied (the demo projects built by
``build_grade_demo.jsx`` do that).

Usage:
    python ae-plugin/tests/extract_figma_grade_effect.py <project.aep> [out.bin]

After Effects rewrites the parameter table from the installed plug-in when it
opens a project, so the stored definition keeps working across AE releases.
"""

import io
import sys
from pathlib import Path

from py_aep.binary.chunk import ListChunk, read_aep, write_chunk
from py_aep.binary.utils import find_by_type

MATCH_NAME = "F2A Figma Image Grade"


def lists(chunk, list_type):
    """Yield every LIST of ``list_type`` in the chunk tree."""
    if isinstance(chunk, ListChunk):
        if chunk.list_type == list_type:
            yield chunk
        for child in chunk.chunks:
            yield from lists(child, list_type)


def extract(project_path):
    """Return the raw ``LIST:sspc`` bytes of the Figma 调色 effect definition."""
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
                  Path(__file__).resolve().parents[2] / "scripts/aep/figma-image-grade-effect.bin")
    target.write_bytes(data)
    print("wrote", target, len(data), "bytes")


if __name__ == "__main__":
    main()
