const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {node, group, harness} = require('./export-options.cjs');
const SVGParser = require('../host/figma/svgParser.js');

const plain = value => JSON.parse(JSON.stringify(value));
const rect = (x, y, width, height) => ({x, y, width, height});
const checked = [];
async function check(name, fn) {
  try { await fn(); checked.push({name, passed: true}); }
  catch (e) { checked.push({name, passed: false, error: e.message}); }
}

(async () => {
  await check('node mode rebases fractional coordinates once and ignores SVG shift', async () => {
    const shape = node('RECTANGLE', 'shape', {
      width: 20, height: 10, cornerRadius: 0,
      fills: [{type: 'SOLID', color: {r: 1, g: 0, b: 0}}],
      fillGeometry: [{data:'M 0 0 L 20 0 L 20 10 L 0 10 Z',windingRule:'NONZERO'}],
      absoluteTransform: [[1,0,510.875],[0,1,220.875]],
      absoluteBoundingBox: rect(510.875,220.875,20,10)
    });
    const text = node('TEXT', 'text', {absoluteBoundingBox: rect(518.5,225.25,20,10), absoluteRenderBounds: rect(518.5,225.25,20,10)});
    const image = node('RECTANGLE', '*image', {absoluteBoundingBox: rect(528.75,222.25,20,10), absoluteRenderBounds: rect(528.75,222.25,20,10)});
    const scene = node('FRAME', 'scene', {children: [shape,text,image],
      absoluteBoundingBox: rect(500.125,200.375,100.25,60.5),
      absoluteRenderBounds: rect(487.625,192.125,140,90)});
    const h = harness(scene);
    const result = await h.run(true,false,false);
    assert.equal(h.calls.svg, 0);
    assert.deepEqual(result.ship.shift, {x:0,y:0});
    assert.deepEqual(result.ship.nodes[0].matrix.slice(4), [10.75,20.5]);
    assert.deepEqual([result.ship.texts[0].x,result.ship.texts[0].y], [18.375,24.875]);
    assert.deepEqual([result.images[0].x,result.images[0].y], [28.625,21.875]);
    class CompItem { constructor() { this.width=300;this.height=300; } }
    const files = {nodes: JSON.stringify(result.ship.nodes)};
    function File(name) { this.exists=name in files;this.open=()=>{};this.close=()=>{};this.read=()=>files[name]; }
    const models=[];
    const c=vm.createContext({CompItem, File, app:{project:{activeItem:new CompItem()}},
      SVGParser, AEShapeBuilder:{build(model){models.push(plain(model));return [];},getDiag(){return '';}}});
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../host/figma/figmaRunner.jsx'),'utf8'),c);
    c._mkShiftModel=()=>{throw new Error('Node import must not apply the SVG canvas shift');};
    assert.doesNotMatch(c.runImport('', '', '', '', 0, 0, 'nodes', ''), /error/i);
    assert.doesNotMatch(c.runImport('', '', '', '', 137.625, -43.25, 'nodes', ''), /error/i);
    assert.deepEqual(models[0],models[1]);
    assert.deepEqual(models[0].shapes[0].subpaths[0].verts[0], [10.75,20.5]);
  });

  await check('crop-bound changes preserve the scene origin across repeated measurements', async () => {
    const old = rect(600.25,348.375,206.5,107.25);
    const raster=group('raster',[],{absoluteBoundingBox:old,absoluteRenderBounds:old});
    const h=harness(raster),im=h.context._rasterMeta(raster,raster,false);
    im.x-=500.125;im.y-=300.5;
    raster.absoluteRenderBounds=rect(620.75,360.875,100.5,60.25);
    h.context._updateRasterBounds(im);
    const expected=[120.625,60.375,100.5,60.25,170.875,90.5];
    const values=()=>[im.x,im.y,im.w,im.h,im.cx,im.cy];
    assert.deepEqual(values(),expected);
    h.context._updateRasterBounds(im);
    assert.deepEqual(values(),expected,'Measuring the same crop twice must not move the image');
    raster.absoluteRenderBounds=old;
    h.context._updateRasterBounds(im);
    assert.deepEqual(values(),[100.125,47.875,206.5,107.25,203.375,101.5]);
  });

  await check('blend-pass export keeps auto-layout children at their original positions', async () => {
    const lead=node('RECTANGLE','leading artwork',{width:.25,height:10,opacity:.6});
    const glow=node('RECTANGLE','glow',{blendMode:'SOFT_LIGHT',width:20,height:10});
    // Simulate a transparent horizontal auto-layout frame. Hidden children leave the
    // layout; zero-opacity children retain their size and the following item spacing.
    const layout=node('FRAME','transparent layout',{children:[lead,glow],layoutMode:'HORIZONTAL',blendMode:'PASS_THROUGH',
      absoluteBoundingBox:rect(600.25,348.375,20.375,10)});
    Object.defineProperty(lead,'absoluteRenderBounds',{get:()=>rect(600.25,348.375,.25,10)});
    Object.defineProperty(glow,'absoluteRenderBounds',{get:()=>rect(600.25+(lead.visible ? .375 : 0),348.375,20,10)});
    Object.defineProperty(layout,'absoluteRenderBounds',{get(){
      const visible=layout.children.filter(n=>n.visible&&n.opacity>0).map(n=>n.absoluteRenderBounds);
      const left=Math.min(...visible.map(b=>b.x)),right=Math.max(...visible.map(b=>b.x+b.width));
      return rect(left,348.375,right-left,10);
    }});
    const h=harness(layout),passes=h.context._rasterBlendPasses(layout);
    assert.equal(passes.length,2);
    const im=h.context._rasterMeta(layout,layout,false);im.x-=600.125;im.y-=300.5;im.rasterPass=passes[1];
    let renderedX;
    layout.exportAsync=async()=>{renderedX=glow.absoluteRenderBounds.x;return new Uint8Array([1]);};
    await h.context._exportRasterPass(im);
    assert.equal(renderedX,600.625,'Rendering a separate glow must not reflow it into the preceding slot');
    assert.deepEqual([im.x,im.y,im.cx,im.cy],[.5,47.875,10.5,52.875]);
    assert.equal(lead.visible,true);assert.equal(lead.opacity,.6);assert.equal(glow.blendMode,'SOFT_LIGHT');
    layout.exportAsync=async()=>{throw new Error('forced PNG failure');};
    await assert.rejects(()=>h.context._exportRasterPass(im),/forced PNG failure/);
    assert.equal(lead.visible,true);assert.equal(lead.opacity,.6);assert.equal(glow.blendMode,'SOFT_LIGHT');
  });
  for(const result of checked) console.log((result.passed?'PASS: ':'FAIL: ')+result.name+(result.error?'\n'+result.error:''));
  if(process.argv[2]) {
    const crypto=require('node:crypto'),file=path.resolve(process.argv[2]);
    const report={passed:checked.every(r=>r.passed),checks:checked,
      scope:'Actual exporter, SVG parser and host runner with simulated Figma scene behavior; native AE and live Figma rendering were not run',
      exporterSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,'../figma-plugin/code.js'))).digest('hex')};
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(report,null,2));
  }
  if(checked.some(r=>!r.passed))process.exitCode=1;
})();
