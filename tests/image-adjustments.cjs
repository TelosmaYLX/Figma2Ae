const assert = require('node:assert/strict');
const {node, group, harness} = require('./export-options.cjs');
const {png} = require('./direct-aep.cjs');

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

function frameFixture(filters, wrap = false) {
  const title = node('TEXT', 'Editable title');
  const image = {type:'IMAGE', imageHash:'photo', scaleMode:'CROP', imageTransform:[[.5,0,.25],[0,.75,.1]], opacity:.64, filters};
  const base = {type:'SOLID', color:{r:.1,g:.3,b:.5}};
  const frame = node('FRAME', 'Graded frame', {
    children:[title], fills:[base, image], opacity:.65, layoutMode:'VERTICAL',
    topLeftRadius:8, topRightRadius:3, bottomRightRadius:0, bottomLeftRadius:5, cornerSmoothing:.6,
    fillGeometry:[{data:'M0 0H100V60H0Z',windingRule:'NONZERO'}],
    strokes:[{type:'SOLID',color:{r:1,g:1,b:1}}], strokeWeight:2,
    absoluteRenderBounds:{x:18,y:28,width:120,height:90}, clipsContent:!wrap,
    resolvedVariableModes:{palette:'dark'}
  });
  const mask = node('RECTANGLE', 'Frame matte', {isMask:true, maskType:'ALPHA', fills:[base], fillGeometry:frame.fillGeometry});
  const h = harness(wrap ? group('Mask scope',[mask,frame]) : frame);
  const renders = [], created = [];
  let reads = 0;
  h.figma.variables = {getVariableCollectionByIdAsync:async id => ({id})};
  h.figma.getImageByHash = () => ({getBytesAsync:async() => { reads++; return png(32,24); },
    getSizeAsync:async() => ({width:32,height:24})});
  h.figma.createRectangle = () => {
    const rect = node('RECTANGLE', 'Temporary fill');
    rect.resizeWithoutConstraints = function(width,height) { this.width = width; this.height = height; };
    rect.setExplicitVariableModeForCollection = function(collection,mode) { this.paletteMode = [collection.id,mode]; };
    rect.remove = function() { this.removed = true; };
    Object.defineProperty(rect, 'absoluteRenderBounds', {get() { return {x:this.relativeTransform[0][2],
      y:this.relativeTransform[1][2],width:this.width,height:this.height}; }});
    rect.exportAsync = async function(options) {
      const scale = options.constraint.value;
      renders.push({node:this, scale});
      return png(this.width * scale, this.height * scale);
    };
    created.push(rect);
    return rect;
  };
  return {h, frame, title, mask, renders, created, reads:() => reads};
}

async function checkFrameFills() {
  const filters = {contrast:.25, temperature:-.17, shadows:.3};
  const root = frameFixture(filters);
  const exported = await root.h.run(true,true,true,false,{target:'aep',rasterScale:2});
  assert.equal(root.reads(), 0, 'A graded frame background must not read the original image');
  assert.equal(exported.images.length, 1, 'The entire fill stack exports once');
  const background = exported.images[0], comp = exported.ship.containers.find(c => c.sourceId === root.frame.id);
  const border = exported.ship.nodes.find(n => n.sourceId === root.frame.id);
  const title = exported.ship.texts.find(n => n.sourceId === root.title.id);
  assert.equal(background.sourceId, root.frame.id);
  assert.deepEqual(background.path,[comp.id]);
  assert.deepEqual([background.x,background.y,background.w,background.h],[0,0,100,60]);
  assert.deepEqual([background.natW,background.natH,background.rasterScale],[200,120,2]);
  assert.equal(background.opacity,1);
  assert.equal(comp.opacity,.65);
  assert.equal(comp.clip,true);
  assert.ok(border.strokes.length === 1 && border.fills.length === 0 && !border.imageFill);
  assert.ok(background.z < border.z && border.z < title.z);
  assert.deepEqual(title.path,[comp.id]);
  assert.equal(root.renders.length,1);
  const {node:rendered,scale} = root.renders[0];
  assert.equal(scale,2);
  assert.deepEqual(rendered.fills,root.frame.fills,'Figma must render crop, filters and paint opacity over the other fills');
  assert.deepEqual(rendered.paletteMode,['palette','dark']);
  assert.deepEqual(rendered.relativeTransform,root.frame.absoluteTransform);
  assert.deepEqual([rendered.topLeftRadius,rendered.topRightRadius,rendered.bottomRightRadius,rendered.bottomLeftRadius,rendered.cornerSmoothing],[8,3,0,5,.6]);
  assert.ok(rendered.removed);
  assert.equal(root.frame.children[0],root.title);

  const nested = frameFixture(filters,true);
  const masked = await nested.h.run(true,true,true,false,{nativeImageMasks:true});
  const maskedComp = masked.ship.containers.find(c => c.sourceId === nested.frame.id);
  const matte = masked.ship.nodes.find(n => n.sourceId === nested.mask.id);
  assert.equal(maskedComp.maskId,matte.maskSource);
  assert.ok(masked.images[0].path.includes(maskedComp.id));
  assert.equal(masked.images[0].maskId,null,'Apply the independent matte to the precomp once');

  const flat = await root.h.run(true,true,false,false);
  assert.deepEqual(flat.images[0].path,[]);
  assert.equal(flat.images[0].opacity,.65);
  assert.equal(flat.ship.texts.length,1);

  let checkedSvg = false;
  const framePng = root.frame.exportAsync;
  root.frame.exportAsync = async function(options) {
    if (options.format === 'SVG') {
      checkedSvg = true;
      assert.equal(this.fills.length,0,'The baked fill must not be included in the legacy SVG');
      assert.equal(this.strokes.length,1);
      assert.equal(this.visible,true);
    }
    return framePng.call(this, options);
  };
  const legacy = await root.h.run(false,true,false,false);
  assert.ok(checkedSvg);
  assert.equal(legacy.images[0].rasterScale,1);

  const plain = frameFixture({contrast:0});
  plain.frame.fills.push({type:'IMAGE', imageHash:'photo', visible:false, filters});
  const untouched = await plain.h.run();
  assert.equal(untouched.images[0].rasterScale,null);
  assert.equal(plain.reads(),1);
  assert.deepEqual(plain.created,[]);

  await root.h.context.exportSelectionSVG(true,true,true,false,false,false,{target:'aep'});
  const error = root.h.messages.at(-2);
  assert.match(error.message,/Graded frame.*图片调色/);
  assert.equal(error.nodeId,root.frame.id);

  const failed = frameFixture(filters), create = failed.h.figma.createRectangle;
  failed.h.figma.createRectangle = () => {
    const rect = create();
    rect.exportAsync = async () => { throw Error('fill render failed'); };
    return rect;
  };
  await failed.h.context.exportSelectionSVG(true,true,true,false,true,false,{target:'aep'});
  const failure = failed.h.messages.find(m => m.type === 'error');
  assert.match(failure.message,/fill render failed/);
  assert.equal(failure.nodeId,failed.frame.id);
  assert.equal(failed.created[0].removed,true);
  assert.equal(failed.h.messages.some(m => m.type === 'images-done'),false);
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

  await checkFrameFills();
  console.log('PASS: image adjustments on layers and frame fills; editable children and borders; masks, scale, legacy SVG, permissions and cleanup');
}
check().catch(error => { console.error(error); process.exitCode = 1; });
