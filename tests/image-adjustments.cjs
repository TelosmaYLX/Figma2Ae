const assert = require('node:assert/strict');
const {node, group, harness} = require('./export-options.cjs');

const adjustmentNames = ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows'];
const gradient = [{type:'GRADIENT_LINEAR', gradientStops:[
  {position:0, color:{r:1,g:1,b:1,a:1}},
  {position:1, color:{r:1,g:1,b:1,a:0}}
]}];
function photo(name, filters, extra={}) {
  return node('RECTANGLE', name, {fillGeometry:[{data:'M0 0H100V60H0Z',windingRule:'NONZERO'}],
    fills:[{type:'IMAGE', imageHash:'photo', scaleMode:'FILL', opacity:.84, filters}], ...extra});
}
function maskedFixture(filters) {
  const mask = node('RECTANGLE', '字标渐隐', {isMask:true, maskType:'ALPHA', fills:gradient,
    fillGeometry:[{data:'M0 0H100V60H0Z',windingRule:'NONZERO'}]});
  const image = photo('ANANTA字标', filters);
  const outer = node('RECTANGLE', '开服场景', {isMask:true, maskType:'LUMINANCE',
    fills:[{type:'SOLID',color:{r:.28,g:.28,b:.28}}], fillGeometry:[{data:'M0 0H100V60H0Z',windingRule:'NONZERO'}]});
  const dark = node('RECTANGLE', '开服压暗层', {fills:[{type:'SOLID',color:{r:0,g:0,b:0}}],
    fillGeometry:[{data:'M0 0H100V60H0Z',windingRule:'NONZERO'}]});
  const root = group('开服场景组', [outer, dark, group('ANANTA字标组', [mask, image])]);
  const h = harness(root);
  let sourceReads = 0, photoRenders = 0;
  h.figma.getImageByHash = () => ({getBytesAsync:async() => { sourceReads++; return Buffer.from([0x89,0x50,0,0]); },
    getSizeAsync:async() => ({width:100,height:60})});
  const render = image.exportAsync;
  image.exportAsync = async options => { photoRenders++; return render.call(image, options); };
  return {h, mask, image, reads:() => sourceReads, renders:() => photoRenders};
}
async function check() {
  const zero = Object.fromEntries(adjustmentNames.map(name => [name, 0]));
  const adjusted = adjustmentNames.map((name, index) => photo(name, {...zero, [name]:index % 2 ? -.1 : .3}));
  const plain = photo('default image', zero), missing = photo('missing filters', undefined);
  const all = harness(group('all adjustments', [...adjusted, plain, missing]));
  all.figma.getImageByHash = () => ({getBytesAsync:async() => Buffer.from([0x89,0x50,0,0]), getSizeAsync:async() => ({width:100,height:60})});
  const result = await all.run(true, true, true, false, {nativeImageMasks:true});
  for (const image of adjusted) {
    const output = result.images.find(item => item.sourceId === image.id);
    assert.ok(output && output.rasterScale === 1, image.name + ' must be rendered by Figma');
  }
  for (const image of [plain, missing]) {
    const output = result.images.find(item => item.sourceId === image.id);
    assert.ok(output && output.rasterScale === null, image.name + ' must retain its original source');
  }

  const separate = maskedFixture({...zero, exposure:-.1, contrast:.3});
  const baked = await separate.h.run(true, true, true, false, {nativeImageMasks:true});
  const raster = baked.images.find(item => item.sourceId === separate.image.id);
  const matte = baked.images.find(item => item.maskSource);
  assert.ok(raster && raster.rasterScale === 1 && raster.maskId && matte && raster.maskId === matte.maskSource,
    'Adjustments bake only the photo and retain its independent mask');
  assert.ok(matte && matte.rasterScale === 1 && !matte.maskId, 'The gradient matte remains a separate PNG');
  assert.ok(baked.ship.containers.some(container => container.maskScope && raster.path.includes(container.id)),
    'The adjusted photo stays inside the outer scene-mask precomposition');
  assert.ok(baked.ship.nodes.some(item => item.maskSource && item.maskType === 'LUMINANCE'),
    'The simple outer mask remains a native vector matte');
  assert.equal(separate.reads(), 0, 'Adjusted artwork no longer uses ungraded original bytes');
  assert.ok(separate.renders() > 0, 'Figma renders the adjusted photo, including paint opacity and filters');

  const untouched = maskedFixture(zero);
  const original = await untouched.h.run(true, true, true, false, {nativeImageMasks:true});
  const source = original.images.find(item => item.sourceId === untouched.image.id);
  const sourceMatte = original.images.find(item => item.maskSource && item.maskSource === source.maskId);
  assert.ok(source && source.rasterScale === null && source.maskId && sourceMatte);
  assert.equal(untouched.reads(), 1, 'Default filters preserve the exact original image');
  assert.equal(untouched.renders(), 0, 'Default filters do not re-render the photo');

  const rejected = maskedFixture({...zero, saturation:.2});
  await rejected.h.context.exportSelectionSVG(true, true, true, false, true, false, {
    target:'aep', nativeImageMasks:true,
    rasterize:{effects:false, paints:true, imageCrops:true, masks:true, booleans:true}
  });
  const error = rejected.h.messages.find(message => message.type === 'error');
  assert.ok(error && error.message.includes('图片调色') && error.message.includes('模糊、阴影和特殊效果'));
  assert.equal(error.nodeId, rejected.image.id, 'The error locates the adjusted source photo');
  assert.equal(rejected.h.messages.some(message => message.type === 'ship'), false);

  console.log('PASS: all seven image adjustments rasterize; defaults preserve originals; independent masks stay separate; disabled permission reports the source layer');
}
check().catch(error => { console.error(error); process.exitCode = 1; });
