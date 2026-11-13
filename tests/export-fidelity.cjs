const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../figma-plugin/code.js'), 'utf8');
const context = vm.createContext({__html__: '', figma: {mixed: Symbol(), showUI() {}, on() {}, currentPage: {selection: []}, ui: {postMessage() {}}}});
vm.runInContext(source, context);
let id = 0;
function node(type, name, extra = {}) {
  return {id: String(++id), type, name, visible: true, opacity: 1, blendMode: 'NORMAL', fills: [], strokes: [], effects: [], ...extra};
}
function group(name, children, extra = {}) {
  const n = node('GROUP', name, {blendMode: 'PASS_THROUGH', children, ...extra});
  children.forEach(c => {c.parent = n;});
  return n;
}
(async () => {
  const mask = node('RECTANGLE', 'mask', {isMask: true});
  const texture = node('RECTANGLE', 'light texture');
  const soft = node('VECTOR', 'soft glow', {blendMode: 'SOFT_LIGHT'});
  const front = node('RECTANGLE', 'normal artwork above glow');
  const isolated = group('isolated', [node('VECTOR', 'internal multiply', {blendMode: 'MULTIPLY'})], {blendMode: 'NORMAL'});
  const root = group('lights', [mask, texture, soft, front, isolated], {
    absoluteBoundingBox: {x: 600, y: 348, width: 206, height: 107},
    absoluteRenderBounds: {x: 600, y: 348, width: 206, height: 107},
    absoluteTransform: [[0.965926, -0.258819, 600], [0.258819, 0.965926, 348]]
  });
  const passes = context._rasterBlendPasses(root);
  assert.deepEqual(Array.from(passes, p => p.blend), ['NORMAL', 'SOFT_LIGHT', 'NORMAL']);
  assert.deepEqual(Array.from(passes[2].keep, n => n.name), ['normal artwork above glow', 'isolated']);
  assert.equal(passes.flatMap(p => Array.from(p.keep)).some(n => n === mask), false);
  const snapshots = [];
  root.exportAsync = async () => {
    snapshots.push({visible: [texture, soft, front, isolated].filter(n => n.visible && n.opacity > 0).map(n => n.name), mask: mask.visible, softBlend: soft.blendMode});
    return new Uint8Array([1, 2, 3]);
  };
  for (const pass of passes) {
    const meta = context._rasterMeta(root, root, true);
    assert.equal(meta.rotation, 0, 'A rendered PNG must not rotate a second time');
    meta.rasterPass = pass;meta.rasterBounds = root.absoluteRenderBounds;
    await context._exportRasterPass(meta);
    assert.equal(soft.blendMode, 'SOFT_LIGHT');
    assert.ok(root.children.every(n => n.visible));
  }
  assert.deepEqual(snapshots.map(s => s.visible), [['light texture'], ['soft glow'], ['normal artwork above glow', 'isolated']]);
  assert.ok(snapshots.every(s => s.mask));
  assert.equal(snapshots[1].softBlend, 'NORMAL');
  root.exportAsync = async () => {throw new Error('export failed');};
  const meta = context._rasterMeta(root, root, true);meta.rasterPass = passes[1];meta.rasterBounds = root.absoluteRenderBounds;
  await assert.rejects(() => context._exportRasterPass(meta), /export failed/);
  assert.ok(root.children.every(n => n.visible));assert.equal(soft.blendMode, 'SOFT_LIGHT');
  assert.equal(context._rasterBlendPasses(isolated).length, 1, 'An isolated group must stay isolated');
  const cardBox = {x: 0, y: 0, width: 88, height: 136};
  const backing = node('RECTANGLE', 'opaque card backdrop', {
    width: 156, height: 234, cornerRadius: 0, absoluteTransform: [[1, 0, -32], [0, 1, -78]],
    fills: [{type: 'GRADIENT_LINEAR', gradientStops: [{color: {a: 1}}, {color: {a: 1}}]}]
  });
  const pattern = node('VECTOR', 'translucent pattern', {blendMode: 'SOFT_LIGHT', opacity: 0.6});
  const burn = node('RECTANGLE', 'photo', {blendMode: 'COLOR_BURN'});
  const card = group('card background', [backing, pattern, burn], {absoluteBoundingBox: cardBox, absoluteRenderBounds: cardBox});
  assert.equal(context._rasterBlendPasses(card).length, 1, 'An opaque card background must blend in Figma, not again in AE');
  let exports = 0;
  card.exportAsync = async () => { exports++; assert.ok(card.children.every(n => n.visible)); assert.equal(pattern.blendMode, 'SOFT_LIGHT'); return new Uint8Array([1]); };
  await context._exportRasterPass(context._rasterMeta(card, card, true));
  assert.equal(exports, 1, 'The closed background needs only one PNG export');
  backing.fills[0].gradientStops[1].color.a = 0.5;
  assert.deepEqual(Array.from(context._rasterBlendPasses(card), p => p.blend), ['NORMAL', 'SOFT_LIGHT', 'COLOR_BURN']);
  backing.fills[0].gradientStops[1].color.a = 1;
  backing.opacity = 0.5;
  assert.equal(context._rasterBlendPasses(card).length, 3, 'A faded backdrop still depends on artwork outside the group');
  backing.opacity = 1;
  backing.fills[0].blendMode = 'OVERLAY';
  assert.equal(context._rasterBlendPasses(card).length, 3, 'An opaque paint that itself blends still needs the external backdrop');
  backing.fills[0].blendMode = 'NORMAL';
  backing.width = 50;
  assert.equal(context._rasterBlendPasses(card).length, 3, 'A backdrop covering only part of the group cannot close it');
  backing.width = 156;
  backing.absoluteTransform = [[0.707, -0.707, 44], [0.707, 0.707, -78]];
  assert.equal(context._rasterBlendPasses(card).length, 3, 'A rotated rectangle must cover actual corners, not just its axis-aligned bounding box');
  backing.absoluteTransform = [[1, 0, -32], [0, 1, -78]];
  const fadeMask = node('RECTANGLE', 'gradient alpha mask', {isMask: true, width: 88, height: 136, absoluteTransform: [[1,0,0],[0,1,0]], fills: [{type: 'GRADIENT_LINEAR', gradientStops: [{color: {a: 0}}, {color: {a: 1}}]}]});
  const maskedCard = group('faded card', [fadeMask, backing, pattern, burn], {absoluteBoundingBox: cardBox, absoluteRenderBounds: cardBox});
  assert.equal(context._rasterBlendPasses(maskedCard).length, 3, 'A gradient mask prevents an otherwise opaque backdrop from closing the group');
  fadeMask.fills = [{type: 'SOLID', color: {r:1,g:1,b:1}}];
  assert.equal(context._rasterBlendPasses(maskedCard).length, 1, 'The card rounded-rect alpha mask keeps its opaque backdrop');
  fadeMask.maskType = 'LUMINANCE';
  assert.equal(context._rasterBlendPasses(maskedCard).length, 3, 'Opaque paint alpha alone does not make a luminance mask opaque');
  const oldBounds = root.absoluteRenderBounds;
  const cropped = context._rasterMeta(root, root, true);cropped.rasterPass = passes[1];cropped.rasterBounds = oldBounds;
  cropped.x -= 500;cropped.y -= 300;
  root.absoluteRenderBounds = {x: 620, y: 360, width: 100, height: 60};
  root.exportAsync = async () => new Uint8Array([1]);
  await context._exportRasterPass(cropped);
  assert.deepEqual([cropped.x,cropped.y,cropped.w,cropped.h,cropped.cx,cropped.cy],[120,60,100,60,170,90]);
  root.absoluteRenderBounds = oldBounds;
  const raw = node('RECTANGLE', 'raw bitmap', {fills:[{type:'IMAGE',imageHash:'raw',scaleMode:'FIT'}],width:64,height:32,cornerRadius:0,absoluteBoundingBox:root.absoluteBoundingBox,absoluteTransform:root.absoluteTransform});
  const rawScene = group('scene',[raw]);
  const rawMeta = await context.collectImages(rawScene,rawScene.id,true);
  assert.ok(rawMeta[0].rotation > 14 && rawMeta[0].rotation < 16, 'Raw bitmaps still need their node rotation');
  const stroke = context._textStroke({strokes:[{type:'SOLID',visible:false,color:{r:0,g:0,b:0}},{type:'SOLID',color:{r:1,g:1,b:1}}],strokeWeight:4/3,strokeAlign:'OUTSIDE'});
  assert.equal(stroke.width,4/3);assert.equal(stroke.align,'OUTSIDE');assert.deepEqual(Array.from(stroke.color),[1,1,1]);
  const strokedText=node('TEXT','stroke ink',{strokes:[{type:'SOLID',opacity:.4,color:{r:1,g:1,b:1}}],strokeWeight:2,strokeAlign:'OUTSIDE',
    absoluteTransform:[[1,0,0],[0,1,0]],absoluteBoundingBox:{x:10,y:20,width:100,height:40},absoluteRenderBounds:{x:8,y:18,width:104,height:44}});
  assert.equal(context._textStroke(strokedText).opacity,.4);
  assert.deepEqual({...context._inkBounds(strokedText,{x:0,y:0})},{x:10,y:20,w:100,h:40});
  console.log('PASS: rendered rotation, backdrop blending, paint order, masks, state restoration');
})().catch(e => {console.error(e); process.exitCode = 1;});
