"""Build the bundled Stroke style preset from F2A's existing style envelope."""
from io import BytesIO
from pathlib import Path
import sys

import py_aep
from py_aep.binary.chunk import Chunk, read_chunks, write_chunk
from py_aep.binary.registry import CHUNK_TYPES

sys.path.insert(0, str(Path(__file__).parent / 'aep'))
from writer import Writer

root = Path(__file__).resolve().parent.parent
data = (root / 'host/figma/innershadow-overlay-template.ffx').read_bytes()
# FFX has a 16-byte head (AEP's head is larger), followed by optional XMP.
CHUNK_TYPES['head'] = Chunk
chunks = read_chunks(BytesIO(data), 8 + int.from_bytes(data[4:8], 'big'))
app = py_aep.new('26.0x67')
layer = app.project.root_folder.add_comp('Stroke', 320, 200, 1, 1, 30).add_shape()
Writer.stroke_style(layer, {'color': [1, 1, 1], 'width': 2, 'align': 'CENTER'})

def replace(children):
    for i, chunk in enumerate(children):
        if chunk.chunk_type == 'tdmn' and chunk.value == 'frameFX/enabled':
            children[i + 1] = layer['ADBE Layer Styles']['frameFX/enabled']._tdgp
        elif chunk.chunk_type == 'tdmn' and chunk.value.endswith('/enabled'):
            flags = next(c for c in children[i + 1].chunks if c.chunk_type == 'tdsb')
            flags.enabled = False
        if hasattr(chunk, 'chunks'):
            replace(chunk.chunks)

replace(chunks)
with (root / 'host/figma/stroke-template.ffx').open('wb') as output:
    for chunk in chunks:
        write_chunk(output, chunk)
