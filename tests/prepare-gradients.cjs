const fs = require('node:fs');
const path = require('node:path');
const ffx = require('../client/ffxGradient.js');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'artifacts', 'gradient-test');
fs.mkdirSync(dir, {recursive: true});
const fixture = require('./fixtures/pinball-gradients.json');
const fill = fs.readFileSync(path.join(root, 'host/figma/grad-template.ffx'));
const stroke = fs.readFileSync(path.join(root, 'host/figma/gradstroke-template.ffx'));
function preset(paint, name, template = fill) {
  const file = path.join(dir, name + '.ffx');
  fs.writeFileSync(file, ffx.generate(template, {
    colorStops: paint.stops.map(s => ({loc: s.offset, rgb: s.color})),
    alphaStops: paint.stops.map(s => ({loc: s.offset, a: s.opacity ?? 1}))
  }));
  return file.replaceAll('\\', '/');
}
const presets = {};
fixture.nodes.forEach((node, i) => {
  const entry = {};
  const top = node.fills.at(-1);
  if (top?.kind === 'grad') entry.fill = preset(top, 'fill-' + i);
  if (node.strokes[0]?.kind === 'grad') entry.stroke = preset(node.strokes[0], 'stroke-' + i, stroke);
  presets[i] = entry;
});
fixture.texts.forEach((text, i) => {text.gradFfx = preset(text.grad, 'text-' + i);});
fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify({...fixture, presets}));
console.log('Prepared 7 shape gradients and 3 editable text gradients.');
