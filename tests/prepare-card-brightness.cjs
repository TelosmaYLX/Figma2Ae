const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..'), dir = path.join(root, 'artifacts/card-brightness');
const project = JSON.parse(fs.readFileSync(path.join(dir, 'project-before.json'), 'utf8'));
const card = project.comps.find(c => c.name === 'pinball_game-card');
const verified = JSON.parse(fs.readFileSync(path.join(dir, 'verified-assets.json'), 'utf8'));
assert.ok(card, 'Run the read-only project probe against the supplied AE example first');
const bg = 'D:/Users/图片/temp/bg_s_img_36.png';
assert.ok(fs.existsSync(bg), 'Requires the existing Figma-exported whole-background PNG');
let id = 0, pngCalls = 0;
const box = {x: 0, y: 0, width: 88, height: 136};
function node(type, name, extra = {}) {
  const n = {id: String(++id), type, name, visible: true, opacity: 1, blendMode: 'NORMAL',
    fills: [], strokes: [], effects: [], width: 88, height: 136, cornerRadius: 0,
    absoluteBoundingBox: {...box}, absoluteRenderBounds: {...box}, absoluteTransform: [[1,0,0],[0,1,0]], ...extra};
  if (n.children) n.children.forEach(c => { c.parent = n; });
  n.exportAsync = async () => { pngCalls++; return fs.readFileSync(bg); };
  return n;
}
const group = (name, children) => node('GROUP', name, {blendMode: 'PASS_THROUGH', children});
const mask = node('RECTANGLE', 'rounded card mask', {isMask: true, cornerRadius: 16/3, fills: [{type:'SOLID',color:{r:1,g:1,b:1}}]});
const backing = node('RECTANGLE', 'gradient backing', {width:156.121,height:233.268,absoluteTransform:[[1,0,-32.0182],[0,1,-78.514]], fills:[{type:'GRADIENT_LINEAR',gradientStops:[{color:{a:1}},{color:{a:1}}]}]});
const background = group('bg_s_img', [mask, backing, node('VECTOR','pattern',{blendMode:'SOFT_LIGHT',opacity:.6}), node('RECTANGLE','photo',{blendMode:'LINEAR_BURN'}), node('RECTANGLE','photo detail',{blendMode:'COLOR_BURN'})]);
const text = node('TEXT', '×1', {characters:'×1',fontName:{family:'Arial',style:'Regular'},fontSize:16,textAlignHorizontal:'LEFT',textAutoResize:'WIDTH_AND_HEIGHT',getStyledTextSegments(){return [{characters:'×1',fontName:this.fontName,fontSize:16,fills:[]}];}});
const scene = group('pinball_game-card',[background,text]);
const messages = [];
const figma = {mixed:Symbol(),showUI(){},on(){},notify(){},currentPage:{selection:[scene]},
  ui:{postMessage(m){messages.push(JSON.parse(JSON.stringify(m)));}},base64Encode:b=>Buffer.from(b).toString('base64')};
const context = vm.createContext({figma,__html__:''});
vm.runInContext(fs.readFileSync(path.join(root,'figma-plugin/code.js'),'utf8'),context);
(async () => {
  await context.exportSelectionSVG(true,false,true,false,true,false,{});
  assert.equal(messages.find(m=>m.type==='error'),undefined);
  const ship = messages.find(m=>m.type==='ship');
  assert.equal(ship.texts.length,1,'The counter must remain editable');
  const chunks = messages.filter(m=>m.type==='image-chunk');
  assert.equal(chunks.filter(m=>m.seq===0).length,1,'Closed card backgrounds must export once');
  assert.equal(pngCalls,1);
  const im = {...chunks[0].meta,file:'background.png'};
  fs.writeFileSync(path.join(dir,im.file),Buffer.from(chunks.map(m=>m.dataPart).join(''),'base64'));
  assert.deepEqual(fs.readFileSync(path.join(dir,im.file)),fs.readFileSync(bg));
  const images = [im];
  // Reuse the supplied project's real Figma circle PNGs and geometry; only the background's
  // blend boundary changes. The native AE test preserves the original editable counter.
  for (const index of [4,3,2]) {
    const l = card.layers.find(l=>l.index===index), s=l.source, factor=l.scale[0]/100;
    const file='circle-'+index+'.png';fs.copyFileSync(verified.find(a=>a.index===index).file,path.join(dir,file));
    images.push({file,name:l.name,natW:s.width,natH:s.height,cx:l.position[0]-100,cy:l.position[1]-100,
      cw:s.width*factor,ch:s.height*factor,w:s.width*factor,h:s.height*factor,scaleMode:'FIT',opacity:1,
      blend:index===3?'LINEAR_DODGE':'NORMAL',rotation:0});
  }
  fs.writeFileSync(path.join(dir,'import-images.json'),JSON.stringify(images,null,2));
  fs.writeFileSync(path.join(dir,'export-report.json'),JSON.stringify({passed:true,backgroundExports:pngCalls,
    editableTexts:ship.texts.length,background:im,scope:'Actual exporter with simulated Figma nodes; PNG bytes are existing real Figma exports from the supplied example'},null,2));
  console.log('PASS: one background PNG, editable counter, original Figma bytes preserved');
})().catch(e=>{console.error(e);process.exitCode=1;});
