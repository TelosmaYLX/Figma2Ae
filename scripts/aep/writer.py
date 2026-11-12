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
from py_aep import ImportOptions
from py_aep.models.properties.gradient import Gradient, GradientAlphaStop, GradientColorStop
from py_aep.models.properties.shape import Shape
from py_aep.enums import BlendingMode, ParagraphJustification, TrackMatteType
from py_aep.svg.fonts import resolve_font, resolve_font_exact, resolve_postscript


class Writer:
    def __init__(self, packet: dict, output: Path):
        self.data, self.output = packet, output
        self.app = py_aep.new('26.0x67')
        self.project = self.app.project
        self.folder = self.project.root_folder.add_folder(packet['name'])
        self.assets = self.folder.add_folder('Assets')
        self.precomps = self.folder.add_folder('Precomps')
        self.main = self.comp(packet['name'], packet['width'], packet['height'], self.folder)
        self.contexts = {None: {'comp': self.main, 'x': 0, 'y': 0}}
        self.warnings = []
        self.counts = {'shapes': 0, 'texts': 0, 'images': 0, 'precomps': 0, 'mattes': 0}
        self.mask_defs = {}
        self.current_layer = packet['name']

    def fail(self, code, item, detail=''):
        raise ValueError('图层「' + (item.get('name') or self.current_layer) + '」无法导出：' + str(detail or code))

    def comp(self, name, width, height, folder):
        return folder.add_comp(name, max(4, math.ceil(width)), max(4, math.ceil(height)),
                               1.0, self.data['duration'], self.data['frameRate'])

    def parent(self, item):
        return next((self.contexts[key] for key in reversed(item.get('path') or [])
                     if key in self.contexts), self.contexts[None])

    def common(self, layer, item):
        layer.name = item.get('name') or 'Layer'
        layer.enabled = not item.get('hidden', False)
        layer.transform.opacity.value = item.get('opacity', 1) * 100
        blend = item.get('blend', 'NORMAL')
        if blend == 'PASS_THROUGH':
            # A precomp with pass-through contents needs collapse transformations.
            if item.get('id'):
                layer.collapse_transformation = True
        else:
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

    def paint(self, root, item, kind, color, gradient, opacity=1, width=None, white=False):
        group = root.add_property('ADBE Vector Group')
        group.name = 'Stroke' if kind == 'stroke' else 'Fill'
        contents = group['ADBE Vectors Group']
        self.geom(contents, item)
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
            p['ADBE Vector Fill Rule'].value = item.get('fillRule', 1)

    def shape(self, context, item, white=False):
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
        self.transform(layer, cx - context['x'], cy - context['y'])
        root = layer['ADBE Root Vectors Group']
        if white:
            self.paint(root, item, 'fill', [1, 1, 1], None)
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
                           paint.get('opacity', 1), paint.get('width'))
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

    def text(self, context, item):
        segments = item.get('segs') or []
        chars = ''.join(s['characters'] for s in segments) if segments else item.get('characters', '')
        if not chars:
            return None
        layer = context['comp'].add_box_text([item['w'], item['h']], chars) if item.get('box') else context['comp'].add_text(chars)
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
        if item.get('stroke'):
            stroke = item['stroke']
            doc.apply_stroke = True
            doc.stroke_color = stroke['color']
            doc.stroke_width = stroke['width']
            doc.stroke_over_fill = False
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
        if item.get('skewX'):
            animator = layer['ADBE Text Properties']['ADBE Text Animators'].add_property('ADBE Text Animator')
            animator.name = 'Figma skew'
            animator['ADBE Text Animator Properties'].add_property('ADBE Text Skew').value = item['skewX']
            animator['ADBE Text Selectors'].add_property('ADBE Text Selector')
        self.counts['texts'] += 1
        if item.get('grad'):
            g = item['grad']
            p0 = g.get('p0') or [item['x'] + g['h0']['x'] * item['w'], item['y'] + g['h0']['y'] * item['h']]
            p1 = g.get('p1') or [item['x'] + g['h1']['x'] * item['w'], item['y'] + g['h1']['y'] * item['h']]
            gradient = {**g, 'start': p0, 'end': p1}
            fill = self.shape(context, {'name': layer.name + ' gradient', 'subpaths': [],
                'prim': {'k': 'rect', 'cx': item['x'] + item['w'] / 2, 'cy': item['y'] + item['h'] / 2,
                         'w': item['w'] + 16, 'h': item['h'] + 16}, 'gradient': gradient,
                'opacity': item.get('opacity', 1), 'blend': item.get('blend', 'NORMAL'), 'hidden': item.get('hidden', False)})
            layer.transform.opacity.value = 100
            fill.set_track_matte(layer, TrackMatteType.ALPHA)
            self.counts['mattes'] += 1
            return fill
        return layer

    def image(self, context, item, index):
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
        scale = min(scales) if item.get('scaleMode') == 'FIT' else max(scales)
        cx, cy = item.get('cx', item['x'] + item['w'] / 2), item.get('cy', item['y'] + item['h'] / 2)
        layer.transform.anchor_point.value = [nw / 2, nh / 2, 0]
        layer.transform.position.value = [cx - context['x'], cy - context['y'], 0]
        layer.transform.scale.value = [scale * 100, scale * 100, 100]
        layer.transform.rotation.value = item.get('rotation', 0)
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
        if layer.track_matte_layer is not None:
            self.fail('combined-matte', item, '暂不支持该组合遮罩，请标记相关图层栅格化')
        layer.set_track_matte(matte, TrackMatteType.LUMA if luma else TrackMatteType.ALPHA)
        self.counts['mattes'] += 1

    def write(self):
        entries = []
        containers = sorted(self.data['containers'], key=lambda c: len(c.get('path') or []))
        for container in containers:
            bounds = container if container.get('clip') else container.get('cb') or container
            self.contexts[container['id']] = {'comp': self.comp(container['name'], bounds['w'], bounds['h'], self.precomps),
                                              'x': bounds['x'], 'y': bounds['y']}
            entries.append((container.get('z', 0), 'container', container, 0))
        for shape in self.data['shapes']:
            if shape.get('maskSource'):
                self.mask_defs.setdefault(shape['maskSource'], []).append(shape)
            else:
                entries.append((shape.get('z', 0), 'shape', shape, 0))
        entries.extend((t.get('z', 0), 'text', t, 0) for t in self.data['texts'])
        entries.extend((im.get('z', 0), 'image', im, i) for i, im in enumerate(self.data['images']))
        for _, kind, item, index in sorted(entries, key=lambda entry: entry[0]):
            self.current_layer = item.get('name', '')
            context = self.contexts[None] if item.get('reference') else self.parent(item)
            if kind == 'container':
                child = self.contexts[item['id']]
                layer = context['comp'].add(child['comp'])
                self.common(layer, item)
                # Clipping depends on the precomp's bounds, so do not collapse a clipping frame.
                if item.get('clip'):
                    layer.collapse_transformation = False
                self.transform(layer, child['x'] - context['x'], child['y'] - context['y'])
                if item.get('clip') and item.get('r'):
                    matte = self.shape(context, {'name': item['name'] + ' clip', 'subpaths': [],
                        'prim': {'k': 'rect', 'cx': item['x'] + item['w'] / 2, 'cy': item['y'] + item['h'] / 2,
                                 'w': item['w'], 'h': item['h'], 'r': item['r']}}, white=True)
                    layer.set_track_matte(matte, TrackMatteType.ALPHA)
                    self.counts['mattes'] += 1
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
        self.project.save(str(self.output / 'project.aep'))


def main():
    started = time.perf_counter()
    packet = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    output = Path(sys.argv[2]).resolve()
    writer = Writer(packet, output)
    writer.write()
    report = {'format': 'aep', 'writer': 'py-aep ' + py_aep.__version__, 'aeVersion': '26.0',
              'width': packet['width'], 'height': packet['height'], 'frameRate': packet['frameRate'],
              'duration': packet['duration'], 'counts': writer.counts, 'warnings': writer.warnings,
              'writeMs': round((time.perf_counter() - started) * 1000)}
    (output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
