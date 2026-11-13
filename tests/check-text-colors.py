import json
import math
import re
import sys
from pathlib import Path
import py_aep
from py_aep.models import TextLayer

data=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
app=py_aep.parse(data['project'])
layers={layer.name:layer for comp in app.project.compositions for layer in comp.layers if isinstance(layer,TextLayer)}
for item in data['texts']:
    document=layers[item['name']]['ADBE Text Properties']['ADBE Text Document'].value
    segments=item.get('segs') or [{'characters':item['characters'],'color':item['color']}]
    offset=0
    for segment in segments:
        end=offset+len(segment['characters'].encode('utf-16-le'))//2
        color=document.character_range(offset,end).fill_color
        assert all(math.isclose(a,b,abs_tol=1e-7) for a,b in zip(color,segment['color'])), (item['name'],color)
        offset=end
    paints=re.findall(rb'/99\s+/SimplePaint\s+/0\s+<<\s*/0\s+1\s*/1\s+\[([^\]]*)\]',document._btdk_body.data)
    assert paints,item['name']
    for paint in paints:
        tokens=paint.split()
        assert len(tokens)==4,(item['name'],tokens)
        assert all(b'e' not in token.lower() and len(token.partition(b'.')[2])<=8 for token in tokens),(item['name'],tokens)
print('PASS: text colors retain RGB with AE-compatible decimal tokens, no exponents, and at most eight fractional digits')
