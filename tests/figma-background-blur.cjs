'use strict';

// Figma-side extraction for 「保留背景模糊」: a Figma BACKGROUND_BLUR must become a
// `backgroundBlurs` request (adjustment layer data) instead of a rasterised PNG, while every
// case that cannot be reproduced (no precomp layer, holes, no visible fill) keeps the old bake.
const assert = require('node:assert/strict');
const {node, group, harness} = require('./export-options.cjs');

const rect = (name, x, y, w, h, extra = {}) => node('RECTANGLE', name, {
  width: w, height: h,
  absoluteBoundingBox: {x, y, width: w, height: h},
  absoluteRenderBounds: {x, y, width: w, height: h},
  absoluteTransform: [[1, 0, x], [0, 1, y]],
  fills: [{type: 'SOLID', color: {r: 0.4, g: 0.5, b: 0.6}}],
  fillGeometry: [{data: 'M0 0H' + w + 'V' + h + 'H0Z', windingRule: 'NONZERO'}],
  ...extra
});

const blur = (extra = {}) => Object.assign({
  type: 'BACKGROUND_BLUR', visible: true, radius: 16,
  blurType: 'PROGRESSIVE', startRadius: 0,
  startOffset: {x: 0.5, y: 0}, endOffset: {x: 0.5, y: 1}
}, extra);

function scene(options = {}) {
  const backdrop = rect('底图', 0, 0, 240, 150);
  const card = node('FRAME', '卡片', {
    width: 160, height: 90,
    absoluteBoundingBox: {x: 40, y: 30, width: 160, height: 90},
    absoluteRenderBounds: {x: 40, y: 30, width: 160, height: 90},
    absoluteTransform: [[1, 0, 40], [0, 1, 30]],
    fills: [{type: 'SOLID', color: {r: 1, g: 1, b: 1}, opacity: 0.4}],
    fillGeometry: [{data: 'M0 0H160V90H0Z', windingRule: 'NONZERO'}],
    effects: [blur(options.effect || {})],
    children: [node('TEXT', '卡片标题')]
  });
  const root = node('FRAME', '页面', {
    width: 240, height: 150,
    absoluteBoundingBox: {x: 0, y: 0, width: 240, height: 150},
    absoluteRenderBounds: {x: 0, y: 0, width: 240, height: 150},
    absoluteTransform: [[1, 0, 0], [0, 1, 0]],
    children: [backdrop, card]
  });
  card.children.forEach(c => {
    c.absoluteTransform = [[1, 0, 60], [0, 1, 50]];
    c.absoluteBoundingBox = {x: 60, y: 50, width: 60, height: 20};
    c.absoluteRenderBounds = c.absoluteBoundingBox;
  });
  return {root, card, backdrop};
}

// The host/writer comp origin is the same formula: floor(min(x, content)) … ceil(max(…)).
function compOrigin(container) {
  const content = (!container.clip && container.cb) ? container.cb : container;
  return {
    x: Math.floor(Math.min(container.x, content.x) + 1e-6),
    y: Math.floor(Math.min(container.y, content.y) + 1e-6)
  };
}

async function check() {
  const {root, card} = scene();
  const h = harness(root);
  const result = await h.run(true, true, true, false, {
    target: 'ae', precompLayers: true, preserveBackgroundBlur: true
  });
  assert.equal(result.ship.preserveBackgroundBlur, true);
  assert.equal(result.ship.backgroundBlurs.length, 1, 'one background-blur adjustment layer');
  const request = result.ship.backgroundBlurs[0];
  // The exporter works on a cloned tree, so ids differ from the fixture; sourceId maps them back.
  const sourceContainer = result.ship.containers.find(c => c.sourceId === card.id && !c.singleLayer);
  assert.ok(sourceContainer, 'the painted frame kept its own precomp container');
  assert.equal(result.ship.containers.some(c => c.id === card.id), false);
  assert.equal(request.container, sourceContainer.id, 'the source container is the painted frame itself');
  assert.equal(request.sourceId, sourceContainer.id);
  assert.equal(request.name, '卡片 背景模糊');
  assert.deepEqual(request.size, [160, 90]);
  assert.equal(request.mode, 'progressive');
  assert.equal(request.radius, 16);
  assert.equal(request.startRadius, 0);
  assert.equal(request.endRadius, 16);
  assert.deepEqual(request.startOffset, [0.5, 0]);
  assert.deepEqual(request.endOffset, [0.5, 1]);
  assert.deepEqual(request.mask, {kind: 'path', d: 'M0 0H160V90H0Z', windingRule: 'NONZERO'});
  assert.deepEqual(request.scale, [100, 100]);
  assert.equal(request.rotation, 0);
  // Frame centre (40 + 80, 30 + 45) relative to the card's parent precomp origin.
  const cardContainer = result.ship.containers.find(c => c.id === sourceContainer.id);
  assert.ok(cardContainer, 'the card kept its precomp container');
  const parentContainer = cardContainer.path.length
    ? result.ship.containers.find(c => c.id === cardContainer.path.at(-1)) : null;
  const origin = parentContainer ? compOrigin(parentContainer) : {x: 0, y: 0};
  assert.deepEqual(request.position, [120 - origin.x, 75 - origin.y]);
  // Nothing of the card is baked into a PNG any more.
  assert.equal(result.images.length, 0, 'a preserved backdrop blur must not rasterise the node');
  assert.equal(result.ship.containers.some(c => c.id === sourceContainer.id), true);

  // Explicitly disabled (the old default): the same node is baked into one PNG and no request
  // is emitted.
  const plain = scene(), plainHarness = harness(plain.root);
  const plainResult = await plainHarness.run(true, true, true, false, {
    target: 'ae', precompLayers: true
  });
  assert.equal(plainResult.ship.backgroundBlurs.length, 0);
  assert.equal(plainResult.images.length, 1, 'without the option the background blur is baked');
  assert.equal(plainResult.images[0].name, '卡片');

  // `rasterize.effects` off + the option on still works: the adjustment layer needs no bake.
  const noBake = scene(), noBakeHarness = harness(noBake.root);
  const noBakeResult = await noBakeHarness.run(true, true, true, false, {
    target: 'ae', precompLayers: true, preserveBackgroundBlur: true,
    rasterize: {effects: false, paints: true, imageCrops: true, masks: true, booleans: true}
  });
  assert.equal(noBakeResult.ship.backgroundBlurs.length, 1);

  // Holes (several subpaths) cannot be a single AE mask: keep the old raster path.
  const holed = scene({effect: blur()});
  holed.card.fillGeometry = [{data: 'M0 0H160V90H0Z M40 20H120V70H40Z'}];
  const holedHarness = harness(holed.root);
  const holedResult = await holedHarness.run(true, true, true, false, {
    target: 'ae', precompLayers: true, preserveBackgroundBlur: true
  });
  assert.equal(holedResult.ship.backgroundBlurs.length, 0);
  assert.equal(holedResult.images.length, 1, 'a holed silhouette falls back to the Figma bake');

  // No visible fill: Figma paints no backdrop blur, so the node stays editable with no effect.
  const unfilled = scene();
  unfilled.card.fills = [{type: 'SOLID', color: {r: 1, g: 1, b: 1}, opacity: 0}];
  const unfilledHarness = harness(unfilled.root);
  const unfilledResult = await unfilledHarness.run(true, true, true, false, {
    target: 'ae', precompLayers: true, preserveBackgroundBlur: true
  });
  assert.equal(unfilledResult.ship.backgroundBlurs.length, 0);
  assert.equal(unfilledResult.images.length, 0, 'a fully transparent backdrop blur paints nothing');

  // The web exporter writes CSS backdrop-filter; the adjustment layer is AEP/live-import only.
  const web = scene(), webHarness = harness(web.root);
  const webResult = await webHarness.run(true, true, true, false, {
    target: 'web', precompLayers: true, preserveBackgroundBlur: true
  });
  assert.equal(webResult.ship.backgroundBlurs.length, 0);

  // Without 「单图层嵌套预合成」 a leaf has no precomp layer to parent to; a painted container
  // still does. This guards the feature gate so no orphan request reaches AE.
  const flat = scene(), flatHarness = harness(flat.root);
  const flatResult = await flatHarness.run(true, true, true, false, {
    target: 'ae', precompLayers: false, preserveBackgroundBlur: true
  });
  assert.equal(flatResult.ship.backgroundBlurs.length, 1, 'a container node is preserved without wrappers');

  console.log('PASS: Figma background blur extraction (request, fallbacks, web/global gates)');
}

if (require.main === module) {
  check().catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = {check};
