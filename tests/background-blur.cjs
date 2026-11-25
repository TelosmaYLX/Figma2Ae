const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {node, group, harness} = require('./export-options.cjs');
const {exportAep, AE_VERSIONS} = require('../scripts/export-aep.cjs');

function rect(name, x, y, width, height, extra = {}) {
  const bounds = {x, y, width, height};
  return node('RECTANGLE', name, {
    ...bounds, absoluteBoundingBox: bounds, absoluteRenderBounds: bounds,
    absoluteTransform: [[1, 0, x], [0, 1, y]],
    fills: [{type:'SOLID', color:{r:1, g:1, b:1}, opacity:.1}],
    fillGeometry: [{data:`M0 0H${width}V${height}H0Z`, windingRule:'NONZERO'}],
    ...extra,
  });
}

const gradient = {type:'BACKGROUND_BLUR', visible:true, blurType:'PROGRESSIVE', startRadius:0, radius:36,
  startOffset:{x:.2, y:.1}, endOffset:{x:.8, y:.9}};

async function check() {
  const card = rect('Card', 84, 68, 120, 80, {effects:[gradient]});
  const wrapper = group('Transparent group', [card], {absoluteBoundingBox:card.absoluteBoundingBox,
    absoluteRenderBounds:card.absoluteRenderBounds});
  const panel = rect('Panel', 52, 46, 200, 140, {type:'FRAME', children:[wrapper]});
  const root = rect('Blur test', 20.25, 15.5, 280, 200, {type:'FRAME', children:[panel]});
  const h = harness(root);
  const settings = {target:'aep', preserveBackgroundBlur:true};
  const flat = await h.run(true, false, false, false, settings);
  assert.equal(flat.images.length, 0);
  const shape = flat.ship.nodes.find(row => row.name === 'Card');
  assert.equal(shape.backgroundBlur.sourceId, card.id);
  assert.deepEqual(shape.backgroundBlur.position, [63.75, 52.5]);
  assert.deepEqual(shape.backgroundBlur.effects, [[2, 0, 0, 36, 20, 10, 80, 90]]);
  assert.equal(shape.inheritedBlur, 0);

  const nested = await h.run(true, false, true, false, {...settings, precompLayers:true});
  const owners = nested.ship.containers.filter(row => row.backgroundBlur);
  assert.equal(owners.length, 1);
  assert.equal(owners[0].name, 'Card');
  assert.deepEqual(owners[0].backgroundBlur.position, [32.75, 22.5]);
  assert.equal(nested.ship.nodes.some(row => row.backgroundBlur), false);
  assert.equal(nested.ship.containers.some(row => row.name === 'Transparent group'), false);

  const integerRoot = rect('Raster test', 20, 15, 280, 200, {type:'FRAME', children:[card]});
  const disabled = await harness(integerRoot).run(true, true, false, false, {target:'aep'});
  assert.equal(disabled.images[0].sourceId, card.id);
  assert.equal(disabled.ship.nodes.some(row => row.backgroundBlur), false);
  const hole = rect('Complex contour', 32, 24, 120, 80, {effects:[gradient],
    fillGeometry:[{data:'M0 0H120V80H0Z M20 20V60H80V20Z', windingRule:'EVENODD'}]});
  const fallback = await harness(hole).run(true, true, false, false, settings);
  assert.equal(fallback.images[0].sourceId, hole.id);
  assert.equal(fallback.ship.nodes.length, 0);
  const web = await harness(root).run(true, false, false, false, {...settings, target:'web'});
  assert.equal(web.ship.nodes.some(row => row.backgroundBlur), false);
  assert.equal(web.ship.effects.find(row => row.effects.some(e => e.kind === 'bgblur')).effects[0].radius, 36);

  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'f2a-background-blur-'));
  const python = process.env.F2A_PYTHON || path.resolve(__dirname, '../.venv-aep/Scripts/python.exe');
  try {
    for (const aeVersion of AE_VERSIONS) {
      for (const [name, fixture] of [['flat', flat], ['nested', nested]]) {
        const packet = {...fixture.ship, images:[], imageCount:0, aeVersion};
        const result = await exportAep(packet, path.join(output, aeVersion, name));
        execFileSync(python, [path.join(__dirname, 'check-background-blur.py'), result.project, name], {windowsHide:true});
      }
    }
  } finally {
    await fs.rm(output, {recursive:true, force:true});
  }
  console.log('PASS: opt-in background blur, flat and nested parenting, progressive parameters, AE 24–26 project round trips');
}

check().catch(error => { console.error(error); process.exitCode = 1; });
