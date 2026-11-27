const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../figma-plugin/code.js'), 'utf8');
let nextId = 0;
function node(type, name, extra = {}) {
  const n = {
    id: String(++nextId), type, name, visible: true, opacity: 1, blendMode: 'NORMAL',
    fills: [], strokes: [], effects: [], width: 100, height: 60,
    absoluteBoundingBox: {x: 20, y: 30, width: 100, height: 60},
    absoluteRenderBounds: {x: 20, y: 30, width: 100, height: 60},
    absoluteTransform: [[1, 0, 20], [0, 1, 30]],
    ...extra
  };
  if (type === 'TEXT') Object.assign(n, {
    characters: 'Editable text', fontName: {family: 'Arial', style: 'Regular'}, fontSize: 16,
    textAlignHorizontal: 'LEFT', textAutoResize: 'WIDTH_AND_HEIGHT',
    getStyledTextSegments() { return [{characters: n.characters, fontName: n.fontName, fontSize: n.fontSize, fills: n.fills}]; }
  }, extra);
  if (n.children) n.children.forEach(c => { c.parent = n; });
  if(type==='INSTANCE'&&!n.detachInstance)n.detachInstance=mockDetachInstance;
  return n;
}
function mockDetachInstance(){
  assert.equal(this.type,'INSTANCE');
  const parent=this.parent,index=parent.children.indexOf(this),frame=mockClone(this);
  frame.type='FRAME';delete frame.detachInstance;frame.parent=parent;
  parent.children.splice(index,1,frame);this.remove();return frame;
}
const group = (name, children, extra = {}) => node('GROUP', name, {children, blendMode: 'PASS_THROUGH', ...extra});
function mockClone(n) {
  const copy = {};
  for (const key of Reflect.ownKeys(n)) {
    if (['id','parent','children','removed'].includes(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(n,key);
    if ('value' in descriptor && descriptor.value && typeof descriptor.value === 'object') descriptor.value=JSON.parse(JSON.stringify(descriptor.value));
    Object.defineProperty(copy,key,descriptor);
  }
  copy.id=String(++nextId);
  if(n.children) {copy.children=n.children.map(mockClone);copy.children.forEach(c=>c.parent=copy);}
  copy.clone=function(){return mockClone(this);};
  copy.remove=function(){this.removed=true;if(this.parent?.children)this.parent.children=this.parent.children.filter(n=>n!==this);if(this.children)this.children.forEach(c=>c.remove());};
  // Preserve native-like sealed Group fixtures when the exporter clones them.
  if(!Object.isExtensible(n)) {
    if(!Object.hasOwn(copy,'parent'))copy.parent=null;
    copy.removed=undefined;
    Object.preventExtensions(copy);
  }
  return copy;
}
function mockFigma(root) {
  const messages = [], calls = {svg: 0, png: 0, fonts: 0, undo: 0};
  function attach(n) {
    n.exportAsync = async options => {
      if (options.format === 'SVG') { calls.svg++; return Buffer.from('<svg width="100" height="60" viewBox="0 0 100 60"></svg>'); }
      calls.png++;
      const png = Buffer.alloc(24); png[0] = 0x89; png[1] = 0x50; png.writeUInt32BE(200, 16); png.writeUInt32BE(120, 20);
      return png;
    };
    if (n.children) n.children.forEach(attach);
    n.clone=function(){return mockClone(this);};
  }
  attach(root);
  const figma = {
    mixed: Symbol(), showUI() {}, on() {}, notify() {}, commitUndo() { calls.undo++; },
    currentPage: {selection: [root]}, ui: {postMessage(m) { messages.push(JSON.parse(JSON.stringify(m))); }},
    loadFontAsync() { calls.fonts++; return Promise.resolve(); }, base64Encode: b => Buffer.from(b).toString('base64'),
    createFrame() {
      const frame=node('FRAME','temporary',{children:[],parent:{type:'PAGE'}});
      frame.appendChild=function(n){n.parent=this;this.children.push(n);};
      frame.remove=function(){this.children.slice().forEach(c=>c.remove());this.removed=true;};
      frame.x=frame.y=0;
      frame.resizeWithoutConstraints=function(w,h){this.width=w;this.height=h;};
      Object.defineProperty(frame,'absoluteTransform',{get(){return [[1,0,this.x],[0,1,this.y]];}});
      Object.defineProperty(frame,'absoluteBoundingBox',{get(){return {x:this.x,y:this.y,width:this.width,height:this.height};}});
      Object.defineProperty(frame,'absoluteRenderBounds',{get(){return this.absoluteBoundingBox;}});
      frame.exportAsync=function(options){return this.children[0].exportAsync.call(this,options);};
      return frame;
    },
    group(nodes,parent) {const g=group('temporary selection',nodes);g.exportAsync=root.exportAsync;g.clone=function(){return mockClone(this);};g.remove=function(){this.removed=true;this.children.slice().forEach(c=>c.remove());};parent.appendChild(g);return g;},
    // Vector text is flattened to glyph outlines in the real plugin API; the exporter now takes
    // that path for text nodes that carry no fillGeometry (OpenPencil compatibility), so the mock
    // must provide it instead of failing every vector-mode export.
    flatten(nodes, parent) {
      const text = nodes[0];
      const vector = node('VECTOR', 'glyph vector', {
        fillGeometry: [{data: 'M0 0H10V10H0Z', windingRule: 'NONZERO'}],
        fills: text.fills, strokes: [], absoluteTransform: text.absoluteTransform
      });
      vector.remove = function () { this.removed = true; };
      if (parent && typeof parent.appendChild === 'function') parent.appendChild(vector);
      if (text.parent && text.parent.children) text.parent.children = text.parent.children.filter(c => c !== text);
      return vector;
    }
  };
  return {figma, messages, calls};
}

function harness(root, code = source) {
  const {figma, messages, calls} = mockFigma(root);
  const context = vm.createContext({__html__: '', figma});
  vm.runInContext(code, context);
  return {context, figma, messages, calls, async run(useNodes = true, rasterGroups = true, organize = true, rasterTexts = false, options = {}) {
    messages.length = 0;
    await context.exportSelectionSVG(useNodes, organize, true, false, rasterGroups, rasterTexts, options);
    const error = messages.find(m => m.type === 'error');
    assert.equal(error, undefined, error?.message);
    const all=messages.filter(m => m.type === 'image-chunk' && m.seq === 0).map(m => m.meta);
    return {ship: messages.find(m => m.type === 'ship'), images: all.filter(m=>!m.reference), references: all.filter(m=>m.reference)};
  }};
}

async function check() {
  const title = node('TEXT', '标题'), marked = group('*卡片', [node('TEXT', '组内文字'), node('RECTANGLE', '底图')]);
  const root = group('页面', [title, marked]);
  const h = harness(root);
  const originalName = title.name;
  h.figma.currentPage.selection = [title, marked];
  h.figma.ui.onmessage({type: 'mark-raster'});
  h.figma.ui.onmessage({type: 'mark-raster'});
  assert.equal(title.name, '*' + originalName); assert.equal(marked.name, '*卡片'); assert.equal(h.calls.undo, 1);
  h.figma.ui.onmessage({type: 'unmark-raster'});
  assert.equal(title.name, originalName); assert.equal(marked.name, '卡片');
  assert.equal(h.calls.undo, 2);
  marked.name = '*卡片'; h.figma.currentPage.selection = [root];
  const result = await h.run(true, false);
  assert.equal(result.ship.texts.length, 1, 'Text outside a marked group stays editable');
  assert.equal(result.ship.texts[0].name, '标题');
  assert.equal(result.images.length, 1, 'The marked group exports once, even with automatic rasterization off');
  assert.equal(result.ship.containers.some(c => c.id === marked.id), false, 'Do not recreate the rasterized subtree as precomps');
  assert.equal(h.calls.svg, 0, 'Editable export must not render a redundant SVG');
  assert.equal(h.calls.fonts, 0, 'Reading text does not require loading its fonts');
  assert.ok(result.ship.svg.length < 200); assert.equal(result.ship.imageBatch, true);
  assert.equal(h.messages.filter(m => m.type === 'images-done').length, 1);
  assert.equal(h.messages.at(-1).busy, false);
  const again = await h.run(true, false);
  const stable = value => JSON.parse(JSON.stringify(value,(key,v)=>['id','path'].includes(key)?undefined:v));
  assert.deepEqual(stable(again), stable(result), 'Repeated exports must not retain modified coordinates or stale caches');
  assert.equal(title.opacity, 1); assert.equal(marked.visible, true);
  const rasterTextResult = await h.run(true, false, true, true);
  assert.equal(rasterTextResult.ship.texts.length, 0);
  assert.equal(rasterTextResult.images.length, 2, 'One text PNG plus one marked group; no duplicate group text');
  assert.equal(title.name, originalName, 'Automatic text rasterization does not rename Figma layers');
  const editableAgain = await h.run(true, false);
  assert.deepEqual(stable(editableAgain), stable(result), 'Turning off the option restores editable text on the next export');

  const plainText = node('TEXT', '单独选中的文字'), textHarness = harness(plainText);
  const onlyText = await textHarness.run(false, false, false, true);
  assert.equal(onlyText.images.length, 1); assert.equal(onlyText.ship.texts.length, 0);
  assert.deepEqual(onlyText.images[0].path, []); assert.equal(textHarness.calls.svg, 0);
  const mixedFont = node('TEXT', '分享', {characters: '挂牌须知', fontSize: 28,
    getStyledTextSegments() {
      return [{characters: this.characters, fontName: {family: 'MiSans', style: 'Medium'}, fontSize: this.fontSize}];
    }});
  const mixedFontHarness = harness(node('FRAME', '按钮', {children: [mixedFont]}));
  mixedFont.fontName = mixedFontHarness.figma.mixed;
  const mixedFontResult = await mixedFontHarness.run(true, false, true, false, {target: 'aep'});
  const exportedFont = mixedFontResult.ship.texts[0];
  assert.equal(exportedFont.characters, '挂牌须知');
  assert.equal(exportedFont.family, 'MiSans');
  assert.equal(exportedFont.style, 'Medium');
  const masked = group('蒙版文字', [node('RECTANGLE', '遮罩', {isMask: true}), node('TEXT', '组内文字')]);
  const maskHarness = harness(group('画框', [masked]));
  const maskTextResult = await maskHarness.run(true, true, true, true);
  assert.equal(maskTextResult.images.length, 1, 'An automatically rasterized mask group includes its text once');
  assert.match(maskTextResult.images[0].name, /遮罩/);
  const clippedText = node('TEXT', '部分超出画框的文字');
  const clipRoot = node('FRAME', '裁剪画框', {clipsContent: true, children: [clippedText]});
  Object.defineProperty(clippedText, 'absoluteRenderBounds', {get() {
    return {x: 110, y: 40, width: this.parent.clipsContent ? 10 : 50, height: 20};
  }});
  const clipHarness = harness(clipRoot), clippedResult = await clipHarness.run(true, false, true, true);
  assert.deepEqual([clippedResult.images[0].x, clippedResult.images[0].y, clippedResult.images[0].w, clippedResult.images[0].h], [90, 10, 50, 20], 'Text PNG placement uses its actual export bounds, before AE reapplies the frame clip');
  assert.equal(clipRoot.clipsContent, true);
  const plainGroup = group('普通组', [node('TEXT', '组文字')]);
  const instance = node('INSTANCE', '实例', {children: [node('TEXT', '实例文字')]});
  const policyRoot = node('FRAME', '画框', {children: [plainGroup, instance, node('TEXT', '独立文字')]});
  const policy = harness(policyRoot);
  const groupsOnly = await policy.run(true, false, true, false, {rasterAllGroups: true});
  assert.equal(groupsOnly.images.length, 1); assert.equal(groupsOnly.ship.texts.length, 2);
  const instancesOnly = await policy.run(true, false, true, false, {rasterInstances: true});
  assert.equal(instancesOnly.images.length, 1); assert.equal(instancesOnly.ship.texts.length, 2);
  assert.equal(instancesOnly.images[0].name, '实例');
  const both = await policy.run(true, false, true, false, {rasterAllGroups: true, rasterInstances: true});
  assert.equal(both.images.length, 2); assert.equal(both.ship.texts.length, 1);
  const nestedClip = node('FRAME', '内裁剪', {clipsContent: true, children: [node('TEXT', '文字')]});
  const clipScene = node('FRAME', '根裁剪', {clipsContent: true, children: [nestedClip]});
  const outsideClip = node('FRAME', '祖先裁剪', {clipsContent: true, children: [clipScene]});
  const noClip = harness(clipScene);
  nestedClip.children[0].exportAsync = async function() {
    assert.equal(this.parent.clipsContent, false); assert.equal(this.parent.parent.clipsContent, false);
    assert.equal(clipScene.clipsContent,true);assert.equal(nestedClip.clipsContent,true);assert.equal(outsideClip.clipsContent,true);
    return Buffer.from([0x89, 0x50, 0, 0]);
  };
  const unclipped = await noClip.run(true, false, true, true, {enableClip: false});
  assert.ok(unclipped.ship.containers.every(c => !c.clip));
  assert.ok([clipScene, nestedClip, outsideClip].every(n => n.clipsContent));
  const pathText = harness(node('TEXT_PATH', '沿路径文字'));
  const pathResult = await pathText.run(false, false, false);
  assert.equal(pathResult.images.length, 1); assert.equal(pathResult.ship.nodes.length, 0);
  const rootGroupPolicy = harness(group('根 Group', [node('TEXT', '文字')]));
  assert.equal((await rootGroupPolicy.run(false, false, false, false, {rasterAllGroups: true})).images.length, 1);
  assert.equal(rootGroupPolicy.calls.svg, 0);
  const a = node('FRAME', 'A', {children: [group('A 组', [node('TEXT', 'A 文字')])]}), b = node('FRAME', 'B', {children: [group('B 组', [node('TEXT', 'B 文字')])]});
  const multiRoot = node('FRAME', '未选中外层', {children: [a, b]}), multi = harness(multiRoot);
  multi.figma.currentPage.selection = [a, b];
  multi.figma.group = nodes => { const temp = group('临时组', nodes); temp.exportAsync = async () => Buffer.from('<svg/>'); return temp; };
  multi.figma.ungroup = temp => { temp.children.forEach(n => { n.parent = multiRoot; }); };
  const multiResult = await multi.run(true, false, true, false, {rasterAllGroups: true});
  assert.equal(multiResult.images.length, 2, 'The synthetic multi-selection wrapper must not flatten separate frames');
  assert.equal(multi.context._temporaryExportRoot, null);
  const failChild = node('FRAME', '只读裁剪', {children: []});
  Object.defineProperty(failChild, 'clipsContent', {get() { return true; }, set() { throw new Error('read only'); }});
  const failClipRoot = node('FRAME', '恢复裁剪', {clipsContent: true, children: [failChild]}), failClip = harness(failClipRoot);
  await failClip.context.exportSelectionSVG(true, true, true, false, false, false, {enableClip: false});
  assert.ok(failClip.messages.some(m => m.type === 'error'));
  assert.equal(failClipRoot.clipsContent, true, 'Clipping must restore after a rejected mutation');
  assert.equal(failClip.context._exporting, false);
  const paragraph = node('TEXT', '段落', {fontSize: 20, lineHeight: {unit: 'PERCENT', value: 150}, paragraphSpacing: 8, paragraphIndent: 6});
  const paragraphHarness = harness(paragraph), paragraphResult = await paragraphHarness.run();
  assert.equal(paragraphResult.ship.texts[0].leading, 30); assert.equal(paragraphResult.ship.texts[0].paragraphSpacing, 8); assert.equal(paragraphResult.ship.texts[0].paragraphIndent, 6);
  paragraph.lineHeight = {unit: 'PIXELS', value: 28};
  assert.equal((await paragraphHarness.run()).ship.texts[0].leading, 28);
  paragraph.lineHeight = {unit: 'AUTO'};
  assert.equal((await paragraphHarness.run()).ship.texts[0].leading, null);

  const nested = group('自动复杂组', [group('*手动边界', [node('TEXT', '已栅格化')]), node('VECTOR', '柔光', {blendMode: 'SOFT_LIGHT'})]);
  const nh = harness(group('画框', [nested]));
  const nr = await nh.run();
  assert.equal(nr.images.length, 1); assert.match(nr.images[0].name, /手动边界/);
  assert.equal(nr.ship.texts.length, 0);

  for (const type of ['GROUP', 'TEXT', 'RECTANGLE']) {
    const selected = type === 'GROUP' ? group('*整组', [node('TEXT', '*嵌套')], {clipsContent: true, opacity: 0.4}) : node(type, '*单层');
    const parent = group('未选中的外部父组', [selected]);
    const sh = harness(selected), sr = await sh.run();
    assert.equal(sr.images.length, 1); assert.equal(sr.ship.texts.length, 0); assert.equal(sr.ship.nodes.length, 0);
    assert.equal(sr.ship.containers.length, 0); assert.deepEqual(sr.images[0].path, []);
    assert.equal(sr.images[0].opacity, 1, 'Do not apply baked opacity twice');
    assert.equal(selected.clipsContent, type === 'GROUP' ? true : undefined);
    assert.equal(selected.parent, parent);
    const legacySelected = await sh.run(false, false, false);
    assert.equal(legacySelected.images.length, 1); assert.equal(legacySelected.ship.nodes.length, 0);
    assert.equal(sh.calls.svg, 0, 'A whole marked selection never needs SVG rendering');
  }

  const raw = node('RECTANGLE', '原图', {fills: [{type: 'IMAGE', imageHash: 'photo', scaleMode: 'FIT'}], cornerRadius: 0});
  let fillWrites = 0, fills = raw.fills;
  Object.defineProperty(raw, 'fills', {get() { return fills; }, set(v) { fillWrites++; fills = v; }});
  const rawHarness = harness(group('图片画框', [raw]));
  rawHarness.figma.getImageByHash = () => ({getBytesAsync: async () => Buffer.from([0x89, 0x50, 0, 0]), getSizeAsync: async () => ({width: 100, height: 60})});
  await rawHarness.run(true, false);
  assert.equal(fillWrites, 0, 'Node mode must not replace image fills just to export unused SVG');
  assert.equal(fills[0].imageHash, 'photo');

  const legacy = harness(group('旧 SVG 模式', [node('TEXT', '文字'), group('*位图组', [node('RECTANGLE', '形状')])]));
  const legacyRoot = legacy.figma.currentPage.selection[0];
  const legacyExport = legacyRoot.exportAsync;
  legacyRoot.exportAsync = async function(options) { if(options.format==='PNG')return legacyExport(options);legacy.calls.svg++;assert.equal(this.children[1].visible,false);return Buffer.from('<svg width="100" height="60"></svg>'); };
  const lr = await legacy.run(false, false, false);
  assert.equal(legacy.calls.svg, 1); assert.equal(legacy.calls.fonts, 1); assert.equal(lr.images.length, 1);
  assert.equal(legacyRoot.children[1].visible, true); assert.equal(legacyRoot.children[0].opacity, 1);

  const failed = harness(group('失败恢复', [group('*坏素材', [node('TEXT', '内容')])]));
  failed.figma.currentPage.selection[0].children[0].exportAsync = async () => { throw new Error('render failed'); };
  await failed.context.exportSelectionSVG(true,true,true,false,true,false,{});
  assert.match(failed.messages.find(m=>m.type==='error').message,/坏素材.*render failed/);
  assert.equal(failed.messages.filter(m => m.type === 'images-done').length, 0, 'A failed PNG must abort the batch');
  assert.equal(failed.context._exporting, false);

  const overflow = node('RECTANGLE', '溢出', {absoluteBoundingBox: {x: 150, y: 120, width: 30, height: 30}});
  const raster = group('*位图边界', [node('RECTANGLE', '位图内部溢出', {absoluteBoundingBox: {x: -5000, y: -5000, width: 9000, height: 9000}})]);
  const boundsRoot = group('边界', [overflow, raster, node('RECTANGLE', '隐藏', {visible: false, absoluteBoundingBox: {x: -1000, y: -1000, width: 4000, height: 4000}})]);
  const bh = harness(boundsRoot); bh.context._collectRasterCandidates(boundsRoot); bh.context._contentBoundsByNode = {};
  const bounds = bh.context._contentBounds(boundsRoot);
  assert.deepEqual(JSON.parse(JSON.stringify(bounds)), {x: 20, y: 30, w: 160, h: 120});
  bounds.x = -9999;
  assert.equal(bh.context._contentBounds(boundsRoot).x, 20, 'Origin rebasing must not mutate cached bounds');
  console.log('PASS: marking, clearing, raster boundaries, selected root, legacy mode, repeated export, no redundant SVG/font/fill work, image completion');
}
module.exports = {node, group, mockFigma, harness};
if (require.main === module) check().catch(e => { console.error(e); process.exitCode = 1; });
