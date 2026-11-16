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
function png(width=64, height=64) {
  const crc = b => { let c = 0xffffffff; for (const v of b) { c ^= v; for (let j=0;j<8;j++) c = (c>>>1)^((c&1)?0xedb88320:0); } return (c^0xffffffff)>>>0; };
  const chunk = (name, bytes) => { const body=Buffer.concat([Buffer.from(name),bytes]), h=Buffer.alloc(4), t=Buffer.alloc(4);h.writeUInt32BE(bytes.length);t.writeUInt32BE(crc(body));return Buffer.concat([h,body,t]); };
  const h=Buffer.alloc(13);h.writeUInt32BE(width,0);h.writeUInt32BE(height,4);h[8]=8;h[9]=6;
  const stride=width*4+1,pixels=Buffer.alloc(height*stride);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*stride+1+x*4;pixels[i]=30;pixels[i+1]=160;pixels[i+2]=240;pixels[i+3]=x<width/2?255:128;}
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
  assert.deepEqual((await fs.readdir(directory)).sort(),['Assets','project.aep','report.json']);
  const parent=await fs.mkdtemp(path.join(output,'选择 位置-'));
  const choices=[null,path.join(parent,'自定义 项目'),path.join(parent,'自定义 项目.aep')],opened=[],temporary=await fs.mkdtemp(path.join(output,'checks-'));
  let pickerCalls=0,failOpen=false;
  const server=start({port:0,quiet:true,tempRoot:temporary,openDirectory:async directory=>{
    if(failOpen)throw new Error('Explorer failure');
    opened.push(directory);
  },chooseDestination:async(options)=>{
    assert.ok(options.name);assert.doesNotMatch(options.name,/[<>:"/\\|?*]/);
    pickerCalls++;
    const folders=await fs.readdir(temporary);assert.equal(folders.length,1);
    const checked=path.join(temporary,folders[0]);
    assert.equal((await fs.readFile(path.join(checked,'project.aep'))).toString('ascii',0,4),'RIFX','The project must be fully generated before opening the picker');
    assert.equal(JSON.parse(await fs.readFile(path.join(checked,'report.json'),'utf8')).warnings.length,0);
    assert.equal((await fs.readdir(path.join(checked,'Assets'))).length,2);
    if(!choices.length)throw new Error('Picker failed');
    return choices.shift();
  }});
  await once(server,'listening');
  try {
    const base='http://127.0.0.1:'+server.address().port;
    const health=await(await fetch(base+'/health')).json();assert.equal(health.service,'f2a-aep');assert.equal(health.version,3);
    assert.deepEqual(health.aeVersions,['24.0','25.0','26.0']);
    const post=body=>fetch(base+'/export',{method:'POST',body:JSON.stringify(body)});
    const open=body=>fetch(base+'/open-directory',{method:'POST',body:JSON.stringify(body)});
    assert.equal((await fetch(base+'/select-directory',{method:'POST'})).status,404,'Do not expose an early picker endpoint');
    assert.equal((await open({directory:parent})).status,400,'Only completed export IDs can open folders');
    const badVersion=await post({packet:{...packet,aeVersion:'23.0'}});
    assert.equal(badVersion.status,400);assert.match((await badVersion.json()).error,/工程版本/);
    assert.equal(pickerCalls,0,'Reject an unsupported version before asking for a destination');
    for(const kind of ['font','image','effect']){
      const invalid=JSON.parse(JSON.stringify(packet));
      if(kind==='font')invalid.texts[0].family='F2A Missing Font 137895';
      if(kind==='image')invalid.images[0].data='invalid PNG';
      if(kind==='effect')invalid.containers[0].blur=3;
      const rejected=await post({packet:invalid});
      assert.equal(rejected.status,400,kind+' must fail before the picker');
      assert.ok((await rejected.json()).error);
      assert.equal(pickerCalls,0,kind+' must not ask the user to choose a folder');
      assert.deepEqual(await fs.readdir(temporary),[],'Failed checks must clean their temporary files');
    }
    const cancel=await(await post({packet})).json();assert.equal(cancel.cancelled,true);
    assert.equal(pickerCalls,1);assert.deepEqual(await fs.readdir(temporary),[]);
    assert.equal((await fs.readdir(parent)).length,0,'Cancel must not create output');
    const named={...packet,name:'导出:../AEP'};
    const response=await post({packet:named});
    assert.equal(response.status,200,await response.clone().text());
    assert.match(response.headers.get('Content-Type'),/application\/json/);
    const exported=await response.json();
    assert.equal(exported.directory,path.join(parent,'自定义 项目'));
    assert.equal(exported.project,path.join(exported.directory,'自定义 项目.aep'));
    assert.equal(exported.archive,undefined);
    assert.deepEqual((await fs.readdir(exported.directory)).sort(),['Assets','report.json','自定义 项目.aep']);
    const original=await fs.readFile(exported.project);
    assert.equal(original.toString('ascii',0,4),'RIFX');
    assert.deepEqual(await fs.readdir(temporary),[],'Only the final folder remains after saving');
    const records=[...original.toString('utf8').matchAll(/\{[^{}]*"fullpath"[^{}]*\}/g)].map(match=>JSON.parse(match[0]));
    assert.equal(records.length,2,'Read both footage path records from the real AEP');
    for(const record of records){
      assert.equal(record.ascendcount_base,1);assert.equal(record.ascendcount_target,2);
      const asset=path.resolve(exported.project,'..',...record.fullpath.split(/[\\/]/).slice(-2));
      await fs.access(asset);
      await assert.rejects(()=>fs.access(record.fullpath),'The deleted temporary location cannot be masking a broken relative path');
    }
    assert.equal((await open({exportId:exported.exportId})).status,200);assert.deepEqual(opened,[exported.directory]);
    failOpen=true;const explorerError=await open({exportId:exported.exportId});assert.equal(explorerError.status,400);assert.match((await explorerError.json()).error,/Explorer failure/);failOpen=false;
    const second=await post({packet:named});
    assert.equal(second.status,200,await second.clone().text());
    const duplicate=await second.json();
    assert.equal(duplicate.directory,path.join(parent,'自定义 项目 (2)'));
    assert.equal(duplicate.project,path.join(duplicate.directory,'自定义 项目 (2).aep'));
    assert.deepEqual(await fs.readFile(exported.project),original,'An existing project is never overwritten');
    const pickerError=await post({packet});assert.equal(pickerError.status,400);assert.match((await pickerError.json()).error,/Picker failed/);
    assert.deepEqual(await fs.readdir(temporary),[]);
    const bad=await fetch(base+'/export',{method:'POST',body:'{'});
    assert.equal(bad.status,400);assert.ok((await bad.json()).error);
    assert.equal((await open({exportId:'unknown',directory:parent})).status,400);assert.equal(opened.length,1);
  } finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
  await fs.writeFile(path.join(output,'test-report.json'),JSON.stringify({passed:true,syntheticFigma:true,...result},null,2));
  console.log('PASS: real AEP/font/image/effect checks before picker; cancel/error cleanup, relative assets after relocation, Unicode folder, unique names and open-folder IDs/errors');
}
if(require.main===module)check().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={fixture,png};
