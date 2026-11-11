const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const {once} = require('node:events');
const {node, group, harness} = require('./export-options.cjs');
const {exportAep} = require('../scripts/export-aep.cjs');
const {start} = require('../scripts/aep-server.cjs');
const {normalize} = require('../scripts/aep/packet.cjs');

// A real, small RGBA PNG, generated independently of AE and untracked sample assets.
function png() {
  const crc = b => { let c = 0xffffffff; for (const v of b) { c ^= v; for (let j=0;j<8;j++) c = (c>>>1)^((c&1)?0xedb88320:0); } return (c^0xffffffff)>>>0; };
  const chunk = (name, bytes) => { const body=Buffer.concat([Buffer.from(name),bytes]), h=Buffer.alloc(4), t=Buffer.alloc(4);h.writeUInt32BE(bytes.length);t.writeUInt32BE(crc(body));return Buffer.concat([h,body,t]); };
  const h=Buffer.alloc(13);h.writeUInt32BE(64,0);h.writeUInt32BE(64,4);h[8]=8;h[9]=6;
  const pixels=Buffer.alloc(64*(64*4+1));
  for(let y=0;y<64;y++)for(let x=0;x<64;x++){const i=y*257+1+x*4;pixels[i]=30;pixels[i+1]=160;pixels[i+2]=240;pixels[i+3]=x<32?255:128;}
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',zlib.deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}

async function fixture() {
  const rectangle = (name, extra={}) => node('RECTANGLE', name, {
    fills:[{type:'SOLID',color:{r:1,g:0.5,b:0.1}}], cornerRadius:12,
    fillGeometry:[{data:'M0 0H100V60H0Z',windingRule:'NONZERO'}], ...extra});
  const gradient = rectangle('Gradient', {fills:[{type:'GRADIENT_LINEAR',opacity:0.8,
    gradientTransform:[[1,0,0],[0,1,0]],gradientStops:[{position:0,color:{r:1,g:0,b:0,a:1}},{position:1,color:{r:0,g:0,b:1,a:0.3}}]}]});
  const clipped=node('FRAME','Rounded clip',{children:[rectangle('Nested rectangle')],clipsContent:true,cornerRadius:12,
    absoluteBoundingBox:{x:180,y:110,width:100,height:60},absoluteTransform:[[1,0,180],[0,1,110]]});
  const picture=group('*Raster image',[node('TEXT','Baked text')]);
  const scene=node('FRAME','Direct AEP smoke',{width:640,height:360,
    absoluteBoundingBox:{x:20,y:30,width:640,height:360},absoluteRenderBounds:{x:20,y:30,width:640,height:360},
    children:[rectangle('Editable rectangle'),gradient,node('TEXT','Editable title',{characters:'Direct AEP',fontSize:24,
      fills:[{type:'SOLID',color:{r:1,g:1,b:1}}]}),clipped,picture]});
  function place(n,x,y,w=100,h=60){n.width=w;n.height=h;n.absoluteBoundingBox=n.absoluteRenderBounds={x,y,width:w,height:h};n.absoluteTransform=[[1,0,x],[0,1,y]];}
  place(scene.children[0],60,110);place(gradient,60,210);place(scene.children[2],60,50,240,40);
  place(clipped,240,110);place(clipped.children[0],220,100);place(picture,400,110);
  const h=harness(scene), image=png();
  // Figma API is mocked, including its PNG renderer. Packet collection uses production code.
  (function render(n){n.exportAsync=async()=>image;if(n.children)n.children.forEach(render);})(scene);
  const result=await h.run(true,false,true);
  const images=h.messages.filter(m=>m.type==='image-chunk'&&m.seq===0).map((m)=>({...m.meta,
    data:h.messages.filter(c=>c.type==='image-chunk'&&c.index===m.index).map(c=>c.dataPart).join('')}));
  assert.deepEqual(result.ship.frame,{width:640,height:360});
  return {...result.ship, images};
}

async function check() {
  const output=path.resolve(__dirname,'../artifacts/direct-aep');
  await fs.mkdir(output,{recursive:true});
  assert.throws(()=>normalize({}),/导出数据/);
  assert.throws(()=>normalize({svg:'<svg/>',frame:{width:0,height:360}}),/尺寸/);
  const packet=await fixture();
  await fs.writeFile(path.join(output,'fixture.packet.json'),JSON.stringify(packet));
  const directory=await fs.mkdtemp(path.join(output,'smoke-'));
  const result=await exportAep(packet,directory);
  const binary=await fs.readFile(result.project);
  assert.equal(binary.toString('ascii',0,4),'RIFX');assert.equal(binary.toString('ascii',8,12),'Egg!');
  assert.equal(result.width,640);assert.equal(result.height,360);
  assert.equal(result.counts.texts,1);assert.equal(result.counts.images,2);
  assert.ok(result.counts.shapes>=3);assert.ok(result.counts.precomps>=1);
  assert.equal(result.warnings.length,0,JSON.stringify(result.warnings));
  const server=start({port:0,output:path.join(output,'http'),quiet:true});
  await once(server,'listening');
  try {
    const base='http://127.0.0.1:'+server.address().port;
    const health=await(await fetch(base+'/health')).json();assert.equal(health.service,'f2a-aep');
    const response=await fetch(base+'/export',{method:'POST',body:JSON.stringify(packet)});
    assert.equal(response.status,200,await response.clone().text());
    const zip=Buffer.from(await response.arrayBuffer());assert.equal(zip.toString('ascii',0,2),'PK');
    await fs.writeFile(path.join(output,'download.zip'),zip);
    const bad=await fetch(base+'/export',{method:'POST',body:'{'});
    assert.equal(bad.status,400);assert.ok((await bad.json()).error);
  } finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
  await fs.writeFile(path.join(output,'test-report.json'),JSON.stringify({passed:true,syntheticFigma:true,...result},null,2));
  console.log('PASS: production exporter packet → direct binary AEP, native layers, nested clipping, gradients, HTTP ZIP and errors');
}
if(require.main===module)check().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={fixture,png};
