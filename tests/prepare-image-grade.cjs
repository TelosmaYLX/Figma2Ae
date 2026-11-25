'use strict';

// Fixtures for tests/ae-image-grade.jsx: one graded picture wrapped in its own single-layer
// precomp, exactly as the Figma plugin ships it when 「单图层嵌套预合成」 is on.
const fs = require('node:fs');
const path = require('node:path');
const {png} = require('./direct-aep.cjs');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'artifacts/image-grade-live');
fs.mkdirSync(path.join(dir, 'assets'), {recursive: true});
fs.writeFileSync(path.join(dir, 'assets', '0000.png'), png(32, 18));
fs.writeFileSync(path.join(dir, 'svg.svg'),
  '<svg width="200" height="120" xmlns="http://www.w3.org/2000/svg">' +
  '<rect x="0" y="0" width="10" height="10" fill="#ff0000"/></svg>');

const wrapper = {id: 'grade-wrapper', name: '图片', type: 'GROUP', singleLayer: true, root: false,
  path: [], z: 5, x: 20, y: 20, w: 32, h: 18, cb: {x: 20, y: 20, w: 32, h: 18}, opacity: 1,
  blend: 'PASS_THROUGH', maskId: null, clip: false, r: 0, hidden: false, blur: 0, fx: []};
fs.writeFileSync(path.join(dir, 'containers.json'), JSON.stringify([wrapper]));

const filters = {exposure: -0.17, contrast: 0.05, saturation: 0.18, temperature: -0.26,
  tint: 0.21, highlights: -0.21, shadows: 0.13};
const image = {file: '0000.png', name: '图片', x: 20, y: 20, w: 32, h: 18, natW: 32, natH: 18,
  scaleMode: 'FIT', rasterScale: null, imageMatrix: null, maskSource: null, maskType: null,
  imageFilters: filters, imageGradeEffect: true, opacity: 1, rotation: 0, matte: null,
  blend: 'NORMAL', path: ['grade-wrapper'], z: 5, maskId: null, cx: 36, cy: 29, cw: 32, ch: 18,
  hidden: false, reference: false, shadow: false, mergedBlend: false, external: false};
fs.writeFileSync(path.join(dir, 'images.json'), JSON.stringify([image]));

fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
  name: 'F2A grade effect live test', svgPath: path.join(dir, 'svg.svg').replace(/\\/g, '/'),
  textsPath: '', gradMapPath: '', effectsPath: '', nodesPath: '',
  containersPath: path.join(dir, 'containers.json').replace(/\\/g, '/'),
  imagesPath: path.join(dir, 'images.json').replace(/\\/g, '/'),
  imageFolder: path.join(dir, 'assets').replace(/\\/g, '/'),
  shiftX: 0, shiftY: 0, compSize: {width: 200, height: 120}, compDuration: 2, compFrameRate: 24,
}));
console.log('image-grade fixtures written to', dir);
