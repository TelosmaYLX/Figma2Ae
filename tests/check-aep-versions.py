import json
import struct
import sys
from pathlib import Path
import py_aep


def chunks(data, start=12, end=None):
    end = len(data) if end is None else end
    while start + 8 <= end:
        tag, size = struct.unpack_from('>4sI', data, start)
        body = start + 8
        assert body + size <= end, (tag, size)
        yield tag, data[body:body + size]
        if tag == b'LIST':
            yield from chunks(data, body + 4, body + size)
        start = body + size + (size & 1)


cases = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
formats = {'24.0': (95, 6), '25.0': (96, 9), '26.0': (97, 2)}
signatures = {}
for case in cases:
    data = Path(case['project']).read_bytes()
    assert data[:4] == b'RIFX'
    head = next(body for tag, body in chunks(data) if tag == b'head')
    assert (head[1], head[3]) == formats[case['aeVersion']]
    word = struct.unpack_from('>I', head, 4)[0]
    major = ((word >> 26) & 31) * 8 + ((word >> 19) & 7)
    assert major == int(case['aeVersion'].split('.')[0]), case
    app = py_aep.parse(case['project'])
    main = app.project.active_item
    assert isinstance(main, py_aep.CompItem), case['name']
    assert main.parent_folder.name == main.name, 'The top-level composition must be active'
    assert main._viewer and main._viewer.active and app.active_viewer is main._viewer
    assert len(main._viewer.views) == 1
    assert main._viewer.views[0].options._fips.zoom_type == 2
    assert all(comp._viewer is None for comp in app.project.compositions if comp is not main)
    signature = []
    for comp in app.project.compositions:
        layers = []
        for layer in comp.layers:
            layers.append((layer.name, type(layer).__name__, layer.transform.position.value,
                           layer.transform.anchor_point.value, layer.transform.scale.value,
                           layer.transform.opacity.value, str(layer.blending_mode),
                           getattr(layer.track_matte_layer, 'name', None), str(layer.track_matte_type)))
        signature.append((comp.name, comp.width, comp.height, layers))
    signature.sort(key=lambda c: c[0])
    if case['kind'] in signatures:
        assert signature == signatures[case['kind']], case['name']
    signatures[case['kind']] = signature
print('PASS: raw AEP headers use 95.6/96.9/97.2 and 24/25/26 application versions; layer transforms, names, hierarchy, opacity and mattes match across targets')
