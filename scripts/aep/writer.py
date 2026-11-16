"""Write a real binary AEP without loading AE. Input geometry comes from F2A's parser."""
from __future__ import annotations

import base64
import copy
import json
import math
import re
import sys
import time
from functools import lru_cache
from pathlib import Path

import py_aep
from fontTools.ttLib import TTFont
from fontTools.misc.bezierTools import calcCubicBounds
from py_aep import ImportOptions
from py_aep.binary.chunk import Chunk
from py_aep.binary.misc_chunks import FipsChunk
from py_aep.binary.scalar_chunks import AsciiChunk, S2Chunk, U1Chunk, U4Chunk
from py_aep.binary.utils import find_by_type
from py_aep.models import TextLayer
from py_aep.cos import serializer as cos_serializer
from py_aep.models.properties.gradient import Gradient, GradientAlphaStop, GradientColorStop
from py_aep.models.properties.shape import Shape
from py_aep.enums import BlendingMode, MaskMode, ParagraphJustification, TrackMatteType
from py_aep.svg.fonts import resolve_font, resolve_font_exact, resolve_postscript

AE_VERSIONS = {'24.0': '24.0x0', '25.0': '25.0x0', '26.0': '26.0x67'}


def open_main_composition(project, comp):
    """Save the main comp's open timeline, composition panel and active item."""
    # Folder-level viewer state is separate from the comp's viewer pseudo-layers.
    view = FipsChunk(
        preview_flags=96, view_flags=15, display_flags=63, guide_flags=5,
        pad_18=bytes.fromhex('ffff8001ffff800180ff0000ffff00ff'),
        pad_30=bytes.fromhex('000000000000000000050100ffffffff0100000000'),
        zoom_type=2, pad_46=b'\xff\xff', zoom=1.0, resolution_flags=1)
    view._trailing = bytes.fromhex('000024000000000000')
    block = [
        U4Chunk(chunk_type='fvdv', value=3), U1Chunk(chunk_type='fiop', value=1),
        U4Chunk(chunk_type='ftts', value=1), U1Chunk(chunk_type='foac', value=1),
        Chunk(chunk_type='fots', data=b'\x00\x0b'),
        Chunk(chunk_type='fott', data=b'AE Timeline'),
        Chunk(chunk_type='fovc', data=b'\x00\x01'), U4Chunk(chunk_type='fovi'),
        U1Chunk(chunk_type='fiac', value=1), Chunk(chunk_type='fits', data=b'\x00\x0e'),
        AsciiChunk(chunk_type='fitt', value='AE Composition'),
        S2Chunk(chunk_type='fivc', value=1), U4Chunk(chunk_type='fivi'),
        S2Chunk(chunk_type='fipc', value=1), Chunk(chunk_type='fidi', data=b'\x00' * 4),
        Chunk(chunk_type='fipl', data=b'\x00' * 2), Chunk(chunk_type='fmpl', data=b'\x00' * 2),
        Chunk(chunk_type='fimr', data=b'\x00' * 2),
        *[copy.deepcopy(view) for _ in range(4)], U4Chunk(chunk_type='fifl'),
    ]
    chunks = comp.parent_folder._children_container
    start, end = chunks.index(comp._view_data[1]), chunks.index(comp._view_data[-1]) + 1
    chunks[start:end] = block
    comp._view_data = [comp._view_data[0], *block]
    find_by_type(project._rifx.chunks, 'fcid').value = comp.id
    project._active_item = comp


def serialize_text_colors(document):
    """Keep text color tokens within AE's decimal parser limits."""
    colors = set()

    def collect(value):
        if isinstance(value, dict):
            if getattr(value.get('99'), 'value', None) == 'SimplePaint':
                colors.update(id(channel) for channel in value['0']['1'])
            for child in value.values():
                collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)

    collect(document._cos_data)
    original = cos_serializer._format_float

    def color_float(value):
        if id(value) not in colors:
            return original(value)
        # Long fractions spill into the next channel; exponent notation can
        # make AE reject the text layer. Keep other document values unchanged.
        text = f'{value:.8f}'.rstrip('0').rstrip('.')
        if '.' not in text:
            text += '.0'
        if text.startswith('0.') and text != '0.0':
            text = text[1:]
        return text.encode('ascii')

    cos_serializer._format_float = color_float
    try:
        document._propagate_cos()
    finally:
        cos_serializer._format_float = original


class Writer:
    def __init__(self, packet: dict, output: Path):
        self.data, self.output = packet, output
        self.ae_version = packet.get('aeVersion', '26.0')
        self.app = py_aep.new(AE_VERSIONS[self.ae_version])
        self.project = self.app.project
        self.folder = self.project.root_folder.add_folder(packet['name'])
        self.assets = self.folder.add_folder('Assets')
        self.precomps = self.folder.add_folder('Precomps')
        self.main = self.comp(packet['name'], packet['width'], packet['height'], self.folder)
        self.contexts = {None: {'comp': self.main, 'x': 0, 'y': 0}}
        self.warnings = []
        self.counts = {'shapes': 0, 'texts': 0, 'images': 0, 'precomps': 0, 'mattes': 0}
        self.mask_defs = {}
        self.image_mask_defs = {}
        self.current_layer = packet['name']
        self.current_item = {}

    def fail(self, code, item, detail=''):
        error = ValueError('图层「' + (item.get('name') or self.current_layer) + '」无法导出：' + str(detail or code))
        error.node_id = item.get('sourceId') or self.current_item.get('sourceId')
        raise error

    def comp(self, name, width, height, folder):
        return folder.add_comp(name, max(4, math.ceil(width)), max(4, math.ceil(height)),
                               1.0, self.data['duration'], self.data['frameRate'])

    @staticmethod
    def comp_bounds(item):
        x, y, right, bottom = item['x'], item['y'], item['x'] + item['w'], item['y'] + item['h']
        content = item.get('cb')
        if not item.get('clip') and content:
            x, y = min(x, content['x']), min(y, content['y'])
            right, bottom = max(right, content['x'] + content['w']), max(bottom, content['y'] + content['h'])
        # Every precomp uses the export pixel grid. Fractional artwork stays fractional,
        # but entering/leaving an uncollapsed comp must not filter that artwork again.
        left, top = math.floor(x + 1e-6), math.floor(y + 1e-6)
        return {'x': left, 'y': top, 'w': math.ceil(right - 1e-6) - left, 'h': math.ceil(bottom - 1e-6) - top}

    @staticmethod
    def rounded_rect(x, y, width, height, radius):
        r = max(0, min(radius, width / 2, height / 2))
        if not r:
            return Shape([[x, y], [x + width, y], [x + width, y + height], [x, y + height]], closed=True)
        k = 0.5522847498 * r
        return Shape([[x+r,y],[x+width-r,y],[x+width,y+r],[x+width,y+height-r],
                      [x+width-r,y+height],[x+r,y+height],[x,y+height-r],[x,y+r]],
                     [[-k,0],[0,0],[0,-k],[0,0],[k,0],[0,0],[0,k],[0,0]],
                     [[0,0],[k,0],[0,0],[0,k],[0,0],[-k,0],[0,0],[0,-k]], closed=True)

    def parent(self, item):
        return next((self.contexts[key] for key in reversed(item.get('path') or [])
                     if key in self.contexts), self.contexts[None])

    def common(self, layer, item):
        layer.name = item.get('name') or 'Layer'
        layer.enabled = not item.get('hidden', False)
        layer.transform.opacity.value = item.get('opacity', 1) * 100
        blend = item.get('blend', 'NORMAL')
        if blend != 'PASS_THROUGH':
            aliases = {'LINEAR_DODGE': 'ADD'}
            mode = getattr(BlendingMode, aliases.get(blend, blend), None)
            if mode is None:
                self.fail('blend', item, '不支持的混合模式 ' + blend)
            else:
                layer.blending_mode = mode
        if item.get('blur') or item.get('fx'):
            self.fail('effects', item, '暂不支持该模糊或图层效果，请标记该层栅格化')

    @staticmethod
    def transform(layer, x=0, y=0):
        layer.transform.anchor_point.value = [0, 0, 0]
        layer.transform.position.value = [x, y, 0]

    @staticmethod
    def center_anchor(layer, rect):
        anchor = [rect['left'] + rect['width'] / 2, rect['top'] + rect['height'] / 2, 0]
        old, position, scale = layer.transform.anchor_point.value, layer.transform.position.value, layer.transform.scale.value
        dx, dy = (anchor[0] - old[0]) * scale[0] / 100, (anchor[1] - old[1]) * scale[1] / 100
        angle = math.radians(layer.transform.rotation.value)
        layer.transform.anchor_point.value = anchor
        layer.transform.position.value = [position[0] + dx * math.cos(angle) - dy * math.sin(angle),
                                          position[1] + dx * math.sin(angle) + dy * math.cos(angle), position[2]]

    @staticmethod
    def shape_rect(item):
        outlined = [paint for paint in item.get('extraPaints') or [] if paint.get('subpaths')]
        if outlined:
            boxes = [Writer.shape_rect(paint) for paint in outlined]
            if item.get('fill') is not None or item.get('gradient') or item.get('stroke') or item.get('strokeGradient'):
                boxes.append(Writer.shape_rect({**item, 'extraPaints': None}))
            left, top = min(b['left'] for b in boxes), min(b['top'] for b in boxes)
            return {'left': left, 'top': top, 'width': max(b['left'] + b['width'] for b in boxes) - left,
                    'height': max(b['top'] + b['height'] for b in boxes) - top}
        primitive = item.get('prim')
        if primitive:
            width = primitive['w'] if primitive['k'] == 'rect' else primitive['rx'] * 2
            height = primitive['h'] if primitive['k'] == 'rect' else primitive['ry'] * 2
            return {'left': primitive['cx'] - width / 2, 'top': primitive['cy'] - height / 2, 'width': width, 'height': height}
        boxes = []
        for sub in item.get('subpaths') or []:
            vertices = sub['verts']
            boxes.extend((x, y, x, y) for x, y in vertices)
            for i in range(len(vertices) if sub['closed'] else max(0, len(vertices) - 1)):
                j = (i + 1) % len(vertices)
                p0, p3 = vertices[i], vertices[j]
                p1 = tuple(p0[k] + sub['outT'][i][k] for k in (0, 1))
                p2 = tuple(p3[k] + sub['inT'][j][k] for k in (0, 1))
                boxes.append(calcCubicBounds(tuple(p0), p1, p2, tuple(p3)))
        left, top = min((b[0] for b in boxes), default=0), min((b[1] for b in boxes), default=0)
        return {'left': left, 'top': top, 'width': max((b[2] for b in boxes), default=0) - left,
                'height': max((b[3] for b in boxes), default=0) - top}

    def geom(self, contents, item):
        primitive = item.get('prim')
        if primitive:
            if primitive['k'] == 'rect':
                p = contents.add_property('ADBE Vector Shape - Rect')
                p['ADBE Vector Rect Size'].value = [primitive['w'], primitive['h']]
                p['ADBE Vector Rect Position'].value = [primitive['cx'], primitive['cy']]
                p['ADBE Vector Rect Roundness'].value = primitive.get('r', 0)
            else:
                p = contents.add_property('ADBE Vector Shape - Ellipse')
                p['ADBE Vector Ellipse Size'].value = [primitive['rx'] * 2, primitive['ry'] * 2]
                p['ADBE Vector Ellipse Position'].value = [primitive['cx'], primitive['cy']]
            return
        for sub in item['subpaths']:
            p = contents.add_property('ADBE Vector Shape - Group')
            p['ADBE Vector Shape'].value = Shape(sub['verts'], sub['inT'], sub['outT'], closed=bool(sub['closed']))

    def paint(self, root, item, kind, color, gradient, opacity=1, width=None, white=False, geometry=None):
        group = root.add_property('ADBE Vector Group')
        group.name = 'Stroke' if kind == 'stroke' else 'Fill'
        contents = group['ADBE Vectors Group']
        self.geom(contents, geometry if geometry is not None else item)
        stroke = kind == 'stroke'
        width = item.get('strokeWidth', 1) if width is None else width
        if stroke and item.get('strokeAlign', 'CENTER') != 'CENTER':
            offset = contents.add_property('ADBE Vector Filter - Offset')
            offset['ADBE Vector Offset Amount'].value = width / 2 * (-1 if item['strokeAlign'] == 'INSIDE' else 1)
        name = 'ADBE Vector Graphic - ' + ('G-' if gradient and not white else '') + ('Stroke' if stroke else 'Fill')
        p = contents.add_property(name)
        p['ADBE Vector Stroke Opacity' if stroke else 'ADBE Vector Fill Opacity'].value = opacity * 100
        if gradient and not white:
            stops = gradient['stops']
            p['ADBE Vector Grad Colors'].value = Gradient(
                [GradientColorStop(s['offset'], 0.5, tuple(s['color'])) for s in stops],
                [GradientAlphaStop(s['offset'], 0.5, s.get('opacity', 1)) for s in stops])
            p['ADBE Vector Grad Type'].value = 2 if gradient.get('type') == 'radial' else 1
            p['ADBE Vector Grad Start Pt'].value = gradient['start']
            p['ADBE Vector Grad End Pt'].value = gradient['end']
        else:
            p['ADBE Vector Stroke Color' if stroke else 'ADBE Vector Fill Color'].value = [*(color or [1, 1, 1]), 1]
        if stroke:
            p['ADBE Vector Stroke Width'].value = width
            p['ADBE Vector Stroke Line Cap'].value = {1: 1, 2: 2, 3: 3, 'ROUND': 2, 'SQUARE': 3}.get(item.get('strokeCap'), 1)
            p['ADBE Vector Stroke Line Join'].value = {1: 1, 2: 2, 3: 3, 'ROUND': 2, 'BEVEL': 3}.get(item.get('strokeJoin'), 1)
            if item.get('strokeMiter') is not None:
                p['ADBE Vector Stroke Miter Limit'].value = item['strokeMiter']
            if item.get('strokeDash'):
                self.fail('stroke-dash', item, '暂不支持虚线描边')
        else:
            p['ADBE Vector Fill Rule'].value = (geometry if geometry is not None else item).get('fillRule', 1)
        if geometry is not None:
            group.move_to(0)

    @staticmethod
    def stroke_style(layer, stroke, fill_opacity=None):
        if not stroke or not stroke.get('width', 0) > 0:
            return 1
        scale = max(1, math.ceil(1 / stroke['width']))
        styles = layer['ADBE Layer Styles']
        style = styles['frameFX/enabled']
        style['frameFX/mode2'].value = 1
        style['frameFX/color'].value = [*stroke['color'], 1]
        style['frameFX/size'].value = stroke['width'] * scale
        style['frameFX/opacity'].value = stroke.get('opacity', 1) * 100
        style['frameFX/style'].value = {'OUTSIDE': 1, 'INSIDE': 2, 'CENTER': 3}.get(stroke.get('align'), 3)
        if fill_opacity is not None:
            styles['ADBE Blend Options Group']['ADBE Adv Blend Group']['ADBE Layer Fill Opacity2'].value = fill_opacity * 100
        # py-aep exposes inert style placeholders; materialize their enable flags
        # after writing leaves, matching an applied native AE Layer Style.
        for group in (style, styles):
            group._tdsb.enabled = True
            group._tdsb.hidden = False
            group._tdsb.synthetic = False
            group.__dict__['enabled'] = True
        return scale

    def scale_stroke_layer(self, layer, scale):
        if scale == 1:
            return layer
        # Native Layer Style Stroke starts at 1 px. Render the editable layer at
        # a larger local size, then scale its precomp down to retain a subpixel border.
        rect = layer.source_rect_at_time(0, False)
        pad = layer['ADBE Layer Styles']['frameFX/enabled']['frameFX/size'].value / scale + 1
        left, top = rect['left'] - pad, rect['top'] - pad
        anchor, position = list(layer.transform.anchor_point.value), list(layer.transform.position.value)
        size, rotation = list(layer.transform.scale.value), layer.transform.rotation.value
        opacity, blend, enabled, name = layer.transform.opacity.value, layer.blending_mode, layer.enabled, layer.name
        parent = layer.containing_comp
        source = self.comp(name + ' 细描边', (rect['width'] + 2 * pad) * scale,
                           (rect['height'] + 2 * pad) * scale, self.precomps)
        inner = layer.copy_to_comp(source)
        inner.transform.anchor_point.value = [left, top, 0]
        inner.transform.position.value = [0, 0, 0]
        inner.transform.scale.value = [100 * scale, 100 * scale, 100]
        inner.transform.rotation.value = 0
        inner.transform.opacity.value = 100
        inner.blending_mode = BlendingMode.NORMAL
        inner.enabled = True
        outer = parent.add(source)
        outer.name = name
        outer.transform.anchor_point.value = [(anchor[0] - left) * scale, (anchor[1] - top) * scale, anchor[2]]
        outer.transform.position.value = position
        outer.transform.scale.value = [size[0] / scale, size[1] / scale, size[2]]
        outer.transform.rotation.value = rotation
        outer.transform.opacity.value = opacity
        outer.blending_mode = blend
        outer.enabled = enabled
        outer.move_before(layer)
        layer.remove()
        self.counts['precomps'] += 1
        return outer

    def shape(self, context, item, white=False):
        # A Layer Style follows the already-matted alpha silhouette in AE. Figma
        # clips the original border instead; keep that border as a path paint.
        if item.get('layerStroke') and item.get('maskId'):
            stroke = item['layerStroke']
            opacity = item.get('layerFillOpacity', 1)
            item = {**item, 'fill': item.get('fill') if opacity else None, 'fillOpacity': opacity,
                    'stroke': stroke['color'], 'strokeWidth': stroke['width'],
                    'strokeOpacity': stroke.get('opacity', 1), 'strokeAlign': stroke.get('align', 'CENTER'),
                    'layerStroke': None}
        layer = context['comp'].add_shape()
        self.common(layer, item)
        # AE 26 ignores py-aep 0.19's nonzero parametric Rect/Ellipse Position.
        # A layer position reads correctly. Keep each primitive centered locally and
        # translate its gradient handles into that same space (verified in real AE).
        primitive = item.get('prim')
        cx, cy = (primitive['cx'], primitive['cy']) if primitive else (0, 0)
        if primitive:
            item = copy.deepcopy(item)
            item['prim']['cx'] = item['prim']['cy'] = 0
            paints = [item.get('gradient'), item.get('strokeGradient')]
            paints.extend(p.get('gradient') for p in item.get('extraPaints') or [])
            for gradient in paints:
                if gradient:
                    gradient['start'] = [gradient['start'][0] - cx, gradient['start'][1] - cy]
                    gradient['end'] = [gradient['end'][0] - cx, gradient['end'][1] - cy]
            for paint in item.get('extraPaints') or []:
                for sub in paint.get('subpaths') or []:
                    sub['verts'] = [[x - cx, y - cy] for x, y in sub['verts']]
        self.transform(layer, cx - context['x'], cy - context['y'])
        root = layer['ADBE Root Vectors Group']
        if white:
            self.paint(root, item, 'fill', [1, 1, 1], None)
            self.center_anchor(layer, self.shape_rect(item))
            return layer
        for paint in item.get('extraPaints') or []:
            if paint.get('under'):
                self.paint(root, item, paint['kind'], paint.get('color'), paint.get('gradient'), paint.get('opacity', 1))
        if item.get('fill') is not None or item.get('gradient'):
            self.paint(root, item, 'fill', item.get('fill'), item.get('gradient'), item.get('fillOpacity', 1))
        if (item.get('stroke') is not None or item.get('strokeGradient')) and item.get('strokeWidth', 1) > 0:
            self.paint(root, item, 'stroke', item.get('stroke'), item.get('strokeGradient'), item.get('strokeOpacity', 1))
        for paint in item.get('extraPaints') or []:
            if not paint.get('under'):
                self.paint(root, item, paint['kind'], paint.get('color'), paint.get('gradient'),
                           paint.get('opacity', 1), paint.get('width'), geometry=paint if paint.get('subpaths') else None)
        stroke_scale = self.stroke_style(layer, item.get('layerStroke'), item.get('layerFillOpacity'))
        self.center_anchor(layer, self.shape_rect(item))
        layer = self.scale_stroke_layer(layer, stroke_scale)
        self.counts['shapes'] += 1
        return layer

    @lru_cache(maxsize=128)
    def font(self, family, style):
        requested = resolve_font_exact(family)
        if requested is None:
            self.fail('font-substitution', {}, '找不到字体 ' + family)
        bold = bool(re.search('bold|heavy|black', style, re.I))
        italic = bool(re.search('italic|oblique', style, re.I))
        face = resolve_postscript(family.replace(' ', '') + '-' + style.replace(' ', '')) or resolve_font_exact(family + ' ' + style) or resolve_font(
            family, bold=bold, italic=italic)
        if face is None:
            raise ValueError('找不到字体：' + family + ' ' + style)
        with TTFont(str(face[0]), fontNumber=face[1], lazy=True) as font:
            actual_style = font['name'].getDebugName(17) or font['name'].getDebugName(2)
            if actual_style and actual_style.lower().replace(' ', '') != style.lower().replace(' ', ''):
                self.fail('font-style', {}, '找不到字体 ' + family + ' 的样式 ' + style)
            return font['name'].getDebugName(6)

    def text_style(self, doc, style):
        family, variant = style.get('family', 'Arial'), style.get('style', 'Regular')
        if resolve_font_exact(family) is None:
            self.fail('font-substitution', style, '找不到字体 ' + family)
        doc.font = self.font(family, variant)
        doc.font_size = style.get('fontSize', 16)
        doc.apply_fill = True
        doc.fill_color = style.get('color') or [0, 0, 0]
        doc.tracking = round(style.get('tracking', 0))
        if style.get('leading') is not None:
            doc.auto_leading = False
            doc.leading = style['leading']

    def text_fill_opacity(self, layer, segments):
        start = 0
        for segment in segments:
            selector_text = re.sub(r'[\r\n\u0003\u2028\u2029\u000b\u000c\u0085]', '', segment['characters'])
            end = start + len(selector_text.encode('utf-16-le')) // 2
            opacity = segment.get('opacity', 1)
            if end > start and opacity < 1:
                animator = layer['ADBE Text Properties']['ADBE Text Animators'].add_property('ADBE Text Animator')
                animator.name = 'Figma fill opacity'
                animator['ADBE Text Animator Properties'].add_property('ADBE Text Fill Opacity').value = opacity * 100
                selector = animator['ADBE Text Selectors'].add_property('ADBE Text Selector')
                advanced = selector['ADBE Text Range Advanced']
                advanced['ADBE Text Range Units'].value = 2
                advanced['ADBE Text Selector Smoothness'].value = 0
                selector['ADBE Text Index Start'].value = start
                selector['ADBE Text Index End'].value = end
            start = end

    def text(self, context, item):
        segments = item.get('segs') or []
        chars = ''.join(s['characters'] for s in segments) if segments else item.get('characters', '')
        if not chars:
            return None
        layer = context['comp'].add_box_text([item['w'], item['h']], chars) if item.get('box') else context['comp'].add_text(chars)
        # AE text always rasterizes continuously. py-aep 0.19's text factory omits this
        # read-only flag, making AE report the entire comp as the text's source rectangle.
        layer._ldta.collapse_transformation = True
        self.common(layer, item)
        prop = layer['ADBE Text Properties']['ADBE Text Document']
        doc = prop.value
        self.text_style(doc, segments[0] if segments else item)
        doc.justification = {'LEFT': ParagraphJustification.LEFT_JUSTIFY, 'CENTER': ParagraphJustification.CENTER_JUSTIFY,
                             'RIGHT': ParagraphJustification.RIGHT_JUSTIFY}.get(item.get('align'), ParagraphJustification.LEFT_JUSTIFY)
        if item.get('paragraphSpacing') is not None:
            doc.space_after = item['paragraphSpacing']
        if item.get('paragraphIndent') is not None:
            doc.first_line_indent = item['paragraphIndent']
        doc.apply_stroke = False
        start = 0
        for segment in segments:
            end = start + len(segment['characters'].encode('utf-16-le')) // 2
            if end > start:
                self.text_style(doc.character_range(start, end), segment)
            start = end
        prop.value = doc
        self.transform(layer)
        box = item.get('ink') or item
        try:
            rect = layer.source_rect_at_time(0, False)
            x = box['x'] - rect['left']
            if item.get('align') == 'CENTER':
                x += (box['w'] - rect['width']) / 2
            elif item.get('align') == 'RIGHT':
                x += box['w'] - rect['width']
            y = box['y'] + box['h'] / 2 - rect['top'] - rect['height'] / 2
            if item.get('rotation'):
                layer.transform.anchor_point.value = [rect['left'] + rect['width'] / 2, rect['top'] + rect['height'] / 2, 0]
                x, y = box['x'] + box['w'] / 2, box['y'] + box['h'] / 2
        except NotImplementedError as error:
            self.fail('text-metrics', item, '无法计算文字排版：' + str(error))
        layer.transform.position.value = [x - context['x'], y - context['y'], 0]
        layer.transform.rotation.value = item.get('rotation', 0)
        self.center_anchor(layer, rect)
        # Alpha does not change glyph geometry. Measure before adding text animators,
        # which the library's text-metrics implementation does not model.
        fills = segments or [{'characters': chars, 'opacity': item.get('fillOpacity', 1)}]
        fill_opacity = fills[0].get('opacity', 1)
        if item.get('stroke') and all(s.get('opacity', 1) == fill_opacity for s in fills):
            stroke_scale = self.stroke_style(layer, item['stroke'], fill_opacity)
        else:
            self.text_fill_opacity(layer, fills)
            stroke_scale = self.stroke_style(layer, item.get('stroke'))
        if item.get('skewX'):
            animator = layer['ADBE Text Properties']['ADBE Text Animators'].add_property('ADBE Text Animator')
            animator.name = 'Figma skew'
            animator['ADBE Text Animator Properties'].add_property('ADBE Text Skew').value = item['skewX']
            animator['ADBE Text Selectors'].add_property('ADBE Text Selector')
        self.counts['texts'] += 1
        layer = self.scale_stroke_layer(layer, stroke_scale)
        if item.get('grad'):
            g = item['grad']
            p0 = g.get('p0') or [item['x'] + g['h0']['x'] * item['w'], item['y'] + g['h0']['y'] * item['h']]
            p1 = g.get('p1') or [item['x'] + g['h1']['x'] * item['w'], item['y'] + g['h1']['y'] * item['h']]
            gradient = {**g, 'start': p0, 'end': p1}
            fill = self.shape(context, {'name': layer.name + ' gradient', 'subpaths': [],
                'prim': {'k': 'rect', 'cx': item['x'] + item['w'] / 2, 'cy': item['y'] + item['h'] / 2,
                         'w': item['w'] + 16, 'h': item['h'] + 16}, 'gradient': gradient, 'fillOpacity': g.get('opacity', 1),
                'opacity': item.get('opacity', 1), 'blend': item.get('blend', 'NORMAL'), 'hidden': item.get('hidden', False)})
            layer.transform.opacity.value = 100
            fill.set_track_matte(layer, TrackMatteType.ALPHA)
            self.counts['mattes'] += 1
            return fill
        return layer

    def image(self, context, item, index):
        if item.get('matte') and (item.get('maskId') or item.get('maskSource')):
            crop_comp = self.comp(item['name'] + ' crop', context['comp'].width, context['comp'].height, self.precomps)
            self.image({**context, 'comp': crop_comp}, {**item, 'maskId': None, 'maskSource': None, 'blend': 'NORMAL'}, index)
            layer = context['comp'].add(crop_comp)
            self.transform(layer)
            self.common(layer, {**item, 'opacity': 1})
            self.counts['precomps'] += 1
            return layer
        ext = item.get('ext', 'png').lower()
        if ext not in ('png', 'jpg', 'jpeg', 'gif', 'webp'):
            raise ValueError('不支持的图片格式：' + ext)
        asset = self.output / 'Assets' / f'{index:04d}.{ext}'
        asset.parent.mkdir(exist_ok=True)
        asset.write_bytes(base64.b64decode(item['data'], validate=True))
        footage = self.project.import_file(ImportOptions(str(asset)))
        footage.parent_folder = self.assets
        layer = context['comp'].add(footage)
        self.common(layer, item)
        nw, nh = footage.width, footage.height
        width, height = item.get('cw', item['w']), item.get('ch', item['h'])
        scales = [width / nw, height / nh]
        scale = 1 / item['rasterScale'] if item.get('rasterScale') else min(scales) if item.get('scaleMode') == 'FIT' else max(scales)
        cx, cy = item.get('cx', item['x'] + item['w'] / 2), item.get('cy', item['y'] + item['h'] / 2)
        layer.transform.anchor_point.value = [nw / 2, nh / 2, 0]
        layer.transform.position.value = [cx - context['x'], cy - context['y'], 0]
        layer.transform.scale.value = [scale * 100, scale * 100, 100]
        layer.transform.rotation.value = item.get('rotation', 0)
        if item.get('imageMatrix'):
            m = item['imageMatrix']
            a, b, c, d = m[0] / nw, m[1] / nw, m[2] / nh, m[3] / nh
            sx = math.hypot(a, b)
            sy = (a * d - b * c) / sx
            if abs(a * c + b * d) > 1e-5 * max(sx * abs(sy), 1e-8):
                self.fail('image-skew', item, '暂不支持该图片裁剪倾斜')
            layer.transform.scale.value = [sx * 100, sy * 100, 100]
            layer.transform.rotation.value = math.degrees(math.atan2(b, a))
            layer.transform.position.value = [m[4] + (m[0] + m[2]) / 2 - context['x'],
                                               m[5] + (m[1] + m[3]) / 2 - context['y'], 0]
        if item.get('reference'):
            layer.enabled = False
            layer.guide_layer = True
        if item.get('shadowBase'):
            self.fail('shadow-image', item, '投影图片未完成处理')
        if item.get('matte'):
            matte = item['matte']
            primitive = {'k': matte.get('kind', 'rect'), 'cx': 0, 'cy': 0, 'w': width, 'h': height,
                         'r': matte.get('r', 0), 'rx': width / 2, 'ry': height / 2}
            mask = self.shape(context, {'name': layer.name + ' matte', 'prim': primitive, 'subpaths': []}, white=True)
            mask.transform.position.value = [cx - context['x'], cy - context['y'], 0]
            mask.transform.rotation.value = item.get('rotation', 0)
            layer.set_track_matte(mask, TrackMatteType.ALPHA)
            self.counts['mattes'] += 1
        self.counts['images'] += 1
        return layer

    def apply_mask(self, context, layer, item):
        if not layer or not item.get('maskId'):
            return
        if layer.track_matte_layer is not None:
            self.fail('combined-matte', item, '暂不支持该组合遮罩，请标记相关图层栅格化')
        image_mask = self.image_mask_defs.get(item['maskId'])
        if image_mask:
            mask_item, index = image_mask
            matte = self.image(context, mask_item, index)
            matte.name = mask_item['name']
            layer.set_track_matte(matte, TrackMatteType.LUMA if mask_item.get('maskType') == 'LUMINANCE' else TrackMatteType.ALPHA)
            self.counts['mattes'] += 1
            return
        definitions = self.mask_defs.get(item['maskId'], [])
        if not definitions:
            self.fail('missing-mask', item, '缺少 Figma 蒙版：' + item['maskId'])
        matte = context['comp'].add_shape()
        self.transform(matte, -context['x'], -context['y'])
        matte.name = layer.name + ' Figma matte'
        root = matte['ADBE Root Vectors Group']
        luma = definitions[0].get('maskType') == 'LUMINANCE'
        for definition in definitions:
            definition = {**definition, 'prim': None}  # Multiple mask regions share global paths.
            self.paint(root, definition, 'fill', definition.get('fill') if luma else [1, 1, 1],
                       definition.get('gradient') if luma else None, definition.get('fillOpacity', 1))
        matte.transform.opacity.value = definitions[0].get('opacity', 1) * 100
        self.center_anchor(matte, self.shape_rect({'subpaths': [sub for definition in definitions for sub in definition['subpaths']]}))
        layer.set_track_matte(matte, TrackMatteType.LUMA if luma else TrackMatteType.ALPHA)
        self.counts['mattes'] += 1

    def write(self):
        entries = []
        containers = sorted(self.data['containers'], key=lambda c: len(c.get('path') or []))
        for container in containers:
            bounds = self.comp_bounds(container)
            self.contexts[container['id']] = {'comp': self.comp(container['name'], bounds['w'], bounds['h'], self.precomps),
                                              'x': bounds['x'], 'y': bounds['y']}
            entries.append((container.get('z', 0), 'container', container, 0))
        for shape in self.data['shapes']:
            if shape.get('maskSource'):
                self.mask_defs.setdefault(shape['maskSource'], []).append(shape)
            else:
                entries.append((shape.get('z', 0), 'shape', shape, 0))
        entries.extend((t.get('z', 0), 'text', t, 0) for t in self.data['texts'])
        for i, image in enumerate(self.data['images']):
            if image.get('maskSource'):
                self.image_mask_defs[image['maskSource']] = (image, i)
            else:
                entries.append((image.get('z', 0), 'image', image, i))
        for _, kind, item, index in sorted(entries, key=lambda entry: entry[0]):
            self.current_layer = item.get('name', '')
            self.current_item = item
            context = self.contexts[None] if item.get('reference') else self.parent(item)
            if kind == 'container':
                child = self.contexts[item['id']]
                layer = context['comp'].add(child['comp'])
                self.common(layer, item)
                layer.collapse_transformation = item.get('collapseForBlends', False)
                self.transform(layer, child['x'] - context['x'], child['y'] - context['y'])
                self.center_anchor(layer, layer.source_rect_at_time(0, False))
                if item.get('clip'):
                    mask = layer['ADBE Mask Parade'].add_property('ADBE Mask Atom')
                    mask.name = 'Clip content'
                    mask.mask_mode = MaskMode.ADD
                    mask['ADBE Mask Shape'].value = self.rounded_rect(
                        item['x'] - child['x'], item['y'] - child['y'], item['w'], item['h'], item.get('r', 0))
                self.counts['precomps'] += 1
            elif kind == 'shape':
                layer = self.shape(context, item)
            elif kind == 'text':
                layer = self.text(context, item)
            else:
                layer = self.image(context, item, index)
            self.apply_mask(context, layer, item)
        for layer in self.main.layers:
            if getattr(layer, 'guide_layer', False):
                layer.move_to_beginning()
        self.current_item = {}
        for comp in self.project.compositions:
            for layer in comp.layers:
                # py-aep 0.19 omits this on static layer transforms. AE keeps the
                # zero when keys are added, making even linear motion nonuniform.
                for prop in (layer.transform.position, layer.transform.anchor_point):
                    prop._tdb4._pad2a = 3
                if isinstance(layer, TextLayer):
                    serialize_text_colors(layer['ADBE Text Properties']['ADBE Text Document'].value)
        open_main_composition(self.project, self.main)
        self.project.save(str(self.output / 'project.aep'))


def main():
    started = time.perf_counter()
    packet = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    output = Path(sys.argv[2]).resolve()
    writer = Writer(packet, output)
    try:
        writer.write()
    except Exception as error:
        print(json.dumps({'error': str(error), 'nodeId': getattr(error, 'node_id', None) or writer.current_item.get('sourceId')}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
    report = {'format': 'aep', 'writer': 'py-aep ' + py_aep.__version__, 'aeVersion': writer.ae_version,
              'width': packet['width'], 'height': packet['height'], 'frameRate': packet['frameRate'],
              'duration': packet['duration'], 'counts': writer.counts, 'warnings': writer.warnings,
              'writeMs': round((time.perf_counter() - started) * 1000)}
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
