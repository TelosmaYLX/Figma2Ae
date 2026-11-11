// Replays existing real Figma PNGs through the current exporter and native AE importer.
// Node APIs are simulated here; this is deliberately not labelled a fresh Figma export.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {node,group,harness}=require('./export-options.cjs');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'artifacts/blend-merge'),old=path.join(root,'artifacts/card-brightness');
fs.mkdirSync(dir,{recursive:true});
const project=JSON.parse(fs.readFileSync(path.join(old,'project-before.json'))),card=project.comps.find(c=>c.name==='pinball_game-card');
const verified=JSON.parse(fs.readFileSync(path.join(old,'verified-assets.json'))),bg='D:/Users/图片/temp/bg_s_img_36.png';
assert.ok(fs.existsSync(bg),'Requires the existing whole-background Figma export');
const box={x:0,y:0,width:88,height:136},geometry={width:88,height:136,absoluteBoundingBox:box,absoluteRenderBounds:box,absoluteTransform:[[1,0,0],[0,1,0]]};
const shape=(name,extra={})=>node('RECTANGLE',name,{...geometry,...extra});
const mask=shape('mask',{isMask:true,cornerRadius:16/3,fills:[{type:'SOLID',color:{r:1,g:1,b:1}}]});
const backing=shape('base',{cornerRadius:0,fills:[{type:'SOLID',color:{r:.2,g:.4,b:.6}}]});
const background=group('background',[mask,backing,shape('pattern',{blendMode:'SOFT_LIGHT'}),shape('photo',{blendMode:'LINEAR_BURN'}),shape('detail',{blendMode:'COLOR_BURN'})],geometry);
const textBox={x:58,y:4,width:28,height:20};
const scene=group('card',[background,node('TEXT','counter',{...geometry,characters:'×1',absoluteBoundingBox:textBox,absoluteRenderBounds:textBox,absoluteTransform:[[1,0,58],[0,1,4]]})],geometry),h=harness(scene);
function attach(n){n.exportAsync=async({format})=>{if(format==='SVG')throw Error('No SVG is needed');return fs.readFileSync(n===scene?path.join(old,'reference.png'):bg);};if(n.children)n.children.forEach(attach);}
attach(scene);
(async()=>{
  const r=await h.run(true,false,false,false,{mergeBlends:true});
  assert.equal(r.images.length,1);assert.equal(r.ship.texts.length,1);assert.equal(r.ship.blendStats.merged,1);assert.equal(r.ship.blendStats.external,0);
  const chunks=h.messages.filter(m=>m.type==='image-chunk'&&!m.meta?.reference),png=Buffer.from(chunks.map(m=>m.dataPart).join(''),'base64');
  assert.deepEqual(png,fs.readFileSync(bg));fs.writeFileSync(path.join(dir,'background.png'),png);
  const after=[{...r.images[0],file:'background.png'}],before=[];
  for(const l of card.layers.slice().reverse()){
    if(!l.source||l.index===1)continue;
    const found=verified.find(v=>v.index===l.index),file='source-'+l.index+'.png';
    fs.copyFileSync(found.file,path.join(dir,file));
    const factor=l.scale[0]/100,s=l.source;
    const meta={file,name:l.name,natW:s.width,natH:s.height,cx:l.position[0]-100,cy:l.position[1]-100,cw:s.width*factor,ch:s.height*factor,w:s.width*factor,h:s.height*factor,scaleMode:'FIT',opacity:1,nativeBlend:Number(l.blend),blend:l.index===3?'LINEAR_DODGE':'NORMAL',z:18-l.index};
    before.push(meta);if(l.index<5)after.push(meta);
  }
  fs.copyFileSync(path.join(old,'reference.png'),path.join(dir,'reference.png'));
  const reference={file:'reference.png',name:'原图对照',reference:true,hidden:true,natW:88,natH:136,cx:44,cy:68,cw:88,ch:136,w:88,h:136,scaleMode:'FIT',z:100};
  fs.writeFileSync(path.join(dir,'native-input.json'),JSON.stringify({before,after,reference,text:r.ship.texts[0],blendStats:r.ship.blendStats,scope:'Current exporter with simulated node APIs, existing real Figma PNG bytes, native AE rendering; not a fresh live Figma export'},null,2));
  const shape=(name,blendMode='NORMAL')=>node('RECTANGLE',name,{blendMode,cornerRadius:0,fills:[{type:'SOLID',color:{r:.2,g:.8,b:.4}}],fillGeometry:[{data:'M0 0 L100 0 L100 60 L0 60 Z',windingRule:'NONZERO'}]});
  const scenes=[
    {kind:'local',root:group('root',[group('local',[shape('base'),shape('blend','SOFT_LIGHT'),shape('editable front')])])},
    {kind:'cross',root:group('root',[shape('base'),group('ending',[shape('blend','SOFT_LIGHT'),shape('editable front')])])},
    {kind:'text',root:group('root',[shape('base'),node('TEXT','outside glow',{absoluteBoundingBox:{x:25,y:30,width:30,height:15},absoluteRenderBounds:{x:25,y:30,width:30,height:15}}),node('RECTANGLE','small glow',{blendMode:'SCREEN',absoluteBoundingBox:{x:25,y:60,width:30,height:20},absoluteRenderBounds:{x:25,y:60,width:30,height:20}})])}
  ],grouped=[];
  for(const s of scenes){
    const hg=harness(s.root);(function render(n){n.exportAsync=async()=>fs.readFileSync(bg);if(n.children)n.children.forEach(render);})(s.root);
    const result=await hg.run(true,false,true,false,{mergeBlends:true});
    grouped.push({kind:s.kind,nodes:result.ship.nodes,texts:result.ship.texts,containers:result.ship.containers,images:result.images.concat(result.references).map(im=>({...im,file:'background.png'}))});
  }
  fs.writeFileSync(path.join(dir,'grouped-input.json'),JSON.stringify(grouped,null,2));
  console.log('PASS: current blend option emits one NORMAL background PNG, preserves editable counter and original Figma PNG bytes');
})().catch(e=>{console.error(e);process.exitCode=1;});
