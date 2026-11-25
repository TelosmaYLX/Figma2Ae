'use strict';

// Live-import fixture for 「保留背景模糊」: run the production Figma exporter against a mocked
// Figma tree (a frosted card over a two-colour backdrop), then write the exact job the AE host
// receives. tests/ae-background-blur.jsx imports it with runImportBatch and checks the
// adjustment layer, mask, parent link and plug-in values.
const fs = require('node:fs');
const path = require('node:path');
const {node, harness} = require('./export-options.cjs');

const rootDir = path.resolve(__dirname, '..');
const dir = path.join(rootDir, 'artifacts/background-blur-live');
const shoot = (name, x, y, w, h, color) => node('RECTANGLE', name, {
  width: w, height: h,
  absoluteBoundingBox: {x, y, width: w, height: h},
  absoluteRenderBounds: {x, y, width: w, height: h},
  absoluteTransform: [[1, 0, x], [0, 1, y]],
  fills: [{type: 'SOLID', color}],
  fillGeometry: [{data: 'M0 0H' + w + 'V' + h + 'H0Z', windingRule: 'NONZERO'}]
});

// 240 x 150 frame, colour boundary at x = 120, frosted card 60…180 x 40…110 crossing it.
const frame = node('FRAME', '背景模糊测试', {
  width: 240, height: 150,
  absoluteBoundingBox: {x: 0, y: 0, width: 240, height: 150},
  absoluteRenderBounds: {x: 0, y: 0, width: 240, height: 150},
  absoluteTransform: [[1, 0, 0], [0, 1, 0]],
  children: [
    shoot('左底图', 0, 0, 120, 150, {r: 0.95, g: 0.42, b: 0.12}),
    shoot('右底图', 120, 0, 120, 150, {r: 0.12, g: 0.35, b: 0.85}),
    node('FRAME', '玻璃卡片', {
      width: 120, height: 70,
      absoluteBoundingBox: {x: 60, y: 40, width: 120, height: 70},
      absoluteRenderBounds: {x: 60, y: 40, width: 120, height: 70},
      absoluteTransform: [[1, 0, 60], [0, 1, 40]],
      cornerRadius: 12,
      fills: [{type: 'SOLID', color: {r: 1, g: 1, b: 1}, opacity: 0.25}],
      fillGeometry: [{data: 'M0 0H120V70H0Z', windingRule: 'NONZERO'}],
      effects: [{type: 'BACKGROUND_BLUR', visible: true, radius: 12,
        blurType: 'PROGRESSIVE', startRadius: 0,
        startOffset: {x: 0.5, y: 0}, endOffset: {x: 0.5, y: 1}}]
    })
  ]
});

const realPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7d0AAAAASUVORK5CYII=',
  'base64');

(async () => {
  const h = harness(frame);
  // Reference/PNG exports need real bytes for an AE footage import.
  (function visit(n) { n.exportAsync = async () => realPng; if (n.children) n.children.forEach(visit); })(frame);
  const result = await h.run(true, true, true, false, {
    target: 'ae', precompLayers: true, preserveBackgroundBlur: true
  });
  if (!result.ship.backgroundBlurs || result.ship.backgroundBlurs.length !== 1)
    throw new Error('expected one backgroundBlurs request: ' + JSON.stringify(result.ship.backgroundBlurs));
  if (!result.ship.preserveBackgroundBlur) throw new Error('preserveBackgroundBlur was not set');

  fs.rmSync(dir, {recursive: true, force: true});
  fs.mkdirSync(path.join(dir, 'assets'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'source.svg'), result.ship.svg);
  for (const key of ['nodes', 'texts', 'effects', 'containers'])
    fs.writeFileSync(path.join(dir, key + '.json'), JSON.stringify(result.ship[key] || []));
  fs.writeFileSync(path.join(dir, 'background-blurs.json'), JSON.stringify(result.ship.backgroundBlurs));

  // Reassemble every exported PNG (the card itself must NOT be among the raster passes; the
  // reference layer is) so the host can import them as footage.
  const chunks = h.messages.filter(m => m.type === 'image-chunk');
  const images = result.images.concat(result.references).map((meta, i) => {
    const file = 'image-' + i + '.png';
    fs.writeFileSync(path.join(dir, 'assets', file),
      Buffer.from(chunks.filter(m => m.index === i).map(m => m.dataPart).join(''), 'base64'));
    return {...meta, file};
  });
  fs.writeFileSync(path.join(dir, 'images.json'), JSON.stringify(images));

  const job = {
    name: 'F2A background blur live test',
    svgPath: path.join(dir, 'source.svg').replace(/\\/g, '/'),
    nodesPath: path.join(dir, 'nodes.json').replace(/\\/g, '/'),
    textsPath: path.join(dir, 'texts.json').replace(/\\/g, '/'),
    effectsPath: path.join(dir, 'effects.json').replace(/\\/g, '/'),
    containersPath: path.join(dir, 'containers.json').replace(/\\/g, '/'),
    backgroundBlursPath: path.join(dir, 'background-blurs.json').replace(/\\/g, '/'),
    imagesPath: path.join(dir, 'images.json').replace(/\\/g, '/'),
    imageFolder: path.join(dir, 'assets').replace(/\\/g, '/'),
    shiftX: 0, shiftY: 0,
    compSize: {width: 240, height: 150}, compDuration: 2, compFrameRate: 24
  };
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job));
  console.log('PASS: background-blur live fixture written to', dir,
    '| requests=' + result.ship.backgroundBlurs.length, '| images=' + images.length);
})().catch(error => { console.error(error); process.exitCode = 1; });
