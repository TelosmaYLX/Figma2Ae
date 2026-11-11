const fs = require('node:fs');
const path = require('node:path');
const {node, group, harness} = require('./export-options.cjs');
const root = path.join(__dirname, '..'), output = path.join(root, 'artifacts/export-smoke');
const png = fs.readFileSync(path.join(root, 'SampleProject/pinball_game_container.png'));
(async () => {
  const rect = node('RECTANGLE', 'Editable shape', {fills: [{type: 'SOLID', color: {r: 1, g: 0.6, b: 0}}], fillGeometry: [{data: 'M 0 0 L 100 0 L 100 60 L 0 60 Z', windingRule: 'NONZERO'}], cornerRadius: 0});
  const card = group('*Raster card', [node('TEXT', 'Baked title')]);
  const groupRaster = group('Whole group', [node('TEXT', 'Group title')]);
  const instanceRaster = node('INSTANCE', 'Whole instance', {children: [node('TEXT', 'Instance title')]});
  const clippedRaster = group('*Clip image', [node('TEXT', 'Clip title')]);
  const unclippedRaster = group('*Unclip image', [node('TEXT', 'Unclip title')]);
  const cases = [
    {name: 'mixed', scene: group('Scene', [rect, node('TEXT', 'Live title'), card]), raster: card, expected: {shapes: 1, texts: 1, images: 1}},
    {name: 'root', scene: group('*Whole scene', [node('TEXT', 'Baked title')]), expected: {shapes: 0, texts: 0, images: 1}},
    {name: 'auto-text', scene: group('Text scene', [node('TEXT', 'Text A'), group('Nested text', [node('TEXT', 'Text B')])]), rasterTexts: true, expected: {shapes: 0, texts: 0, images: 2}},
    {name: 'whole-group', scene: node('FRAME', 'Group scene', {children: [groupRaster, node('TEXT', 'Live text')]}), raster: groupRaster, options: {rasterAllGroups: true}, expected: {shapes: 0, texts: 1, images: 1}},
    {name: 'whole-instance', scene: node('FRAME', 'Instance scene', {children: [instanceRaster, node('TEXT', 'Live text')]}), raster: instanceRaster, options: {rasterInstances: true}, expected: {shapes: 0, texts: 1, images: 1}},
    {name: 'clip-on', scene: node('FRAME', 'Clipped scene', {clipsContent: true, children: [clippedRaster]}), raster: clippedRaster, expected: {shapes: 0, texts: 0, images: 1, masks: 1}},
    {name: 'clip-off', scene: node('FRAME', 'Unclipped scene', {clipsContent: true, children: [unclippedRaster]}), raster: unclippedRaster, options: {enableClip: false}, expected: {shapes: 0, texts: 0, images: 1, masks: 0}}
  ];
  for (const c of cases) {
    const h = harness(c.scene); (c.raster || c.scene).exportAsync = async () => png;
    if (c.rasterTexts) (function visit(n) {
      if (n.type === 'TEXT') n.exportAsync = async () => png;
      if (n.children) n.children.forEach(visit);
    })(c.scene);
    const result = await h.run(true, false, true, !!c.rasterTexts, c.options);
    const dir = path.join(output, c.name); fs.mkdirSync(dir, {recursive: true});
    const chunks = h.messages.filter(m => m.type === 'image-chunk');
    const images = result.images.map((meta, i) => {
      const file = 'image-' + i + '.png';
      fs.writeFileSync(path.join(dir, file), Buffer.from(chunks.filter(m => m.index === i).map(m => m.dataPart).join(''), 'base64'));
      return {...meta, file};
    });
    fs.writeFileSync(path.join(dir, 'source.svg'), result.ship.svg);
    for (const key of ['nodes', 'texts', 'effects', 'containers']) fs.writeFileSync(path.join(dir, key + '.json'), JSON.stringify(result.ship[key]));
    fs.writeFileSync(path.join(dir, 'images.json'), JSON.stringify(images));
  }
  fs.writeFileSync(path.join(output, 'cases.json'), JSON.stringify(cases.map(c => ({name: c.name, expected: c.expected}))));
  console.log('Prepared production exporter packets with mocked Figma rendering; no manual packet corrections');
})().catch(e => { console.error(e); process.exitCode = 1; });
