'use strict';

// The shipped stdio bundle, relay, F2A iframe script and embedded Figma commands run together.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {once} = require('node:events');
const vm = require('node:vm');
const {createHash} = require('node:crypto');
const {connectPlugin, mcpClient, result} = require('./mcp.cjs');
const {start} = require('../mcp/relay.cjs');
const root = path.resolve(__dirname, '..');
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

async function check() {
  const relay = start({port:0, commandTimeout:1000});
  await once(relay.server, 'listening');
  const port = relay.server.address().port;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'f2a-figwright-'));
  let plugin, client, undo = 0, yieldReplies = 0;
  const styles = new Map(), collections = new Map(), variables = new Map();
  const exports = [];
  try {
    const upstreamDir=path.join(root,'mcp/vendor/figwright');
    const upstream=JSON.parse(await fs.readFile(path.join(upstreamDir,'UPSTREAM.json'),'utf8'));
    for(const file of upstream.files) {
      assert.equal(createHash('sha256').update(await fs.readFile(path.join(upstreamDir,file.path))).digest('hex'),file.sha256,'modified upstream source '+file.path);
    }
    // Relocation exercises the actual distribution boundary, including third-party notices.
    await require('../scripts/package-aep-service.cjs').copyMcp(temp);
    assert.match(await fs.readFile(path.join(temp,'mcp/THIRD_PARTY_LICENSES.txt'),'utf8'), /Figwright 0.7.0/);
    client = mcpClient(path.join(temp,'mcp/server.cjs'), port);
    await client.init();
    plugin = await connectPlugin(port, 'Figwright test', ({figma, nodes, page}) => {
      let id = 100;
      nodes.set(page.id, page);
      figma.editorType = 'figma'; figma.mode = 'default'; figma.apiVersion = '1.0.0';
      figma.commitUndo = () => undo++;
      figma.base64Encode = bytes => Buffer.from(bytes).toString('base64');
      figma.base64Decode = data => new Uint8Array(Buffer.from(data,'base64'));
      figma.getNodeByIdAsync = async id => nodes.get(id) || null;
      const append = function(node) {
        if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node),1);
        node.parent = this; this.children.push(node);
      };
      page.appendChild = append;
      const node = type => {
        const n = {id:'2:'+(++id), type, name:type, visible:true, locked:false, x:0, y:0,
          width:100, height:50, rotation:0, opacity:1, blendMode:'NORMAL', fills:[], strokes:[], effects:[],
          strokeWeight:1, strokeAlign:'CENTER', strokeCap:'NONE', strokeJoin:'MITER', dashPattern:[],
          cornerRadius:0, cornerSmoothing:0, constraints:{horizontal:'MIN',vertical:'MIN'}, boundVariables:{},
          absoluteTransform:[[1,0,0],[0,1,0]], absoluteBoundingBox:{x:0,y:0,width:100,height:50},
          absoluteRenderBounds:{x:0,y:0,width:100,height:50}, relativeTransform:[[1,0,0],[0,1,0]],
          resize(w,h) {this.width=w;this.height=h;},
          setBoundVariable(field, variable) {this.boundVariables[field]=variable ? {type:'VARIABLE_ALIAS',id:variable.id}:undefined;},
          async exportAsync(settings) {exports.push(settings);return new Uint8Array(settings.format==='PDF' ? Buffer.from('%PDF-1.7\ntest') : settings.format==='SVG_STRING' ? Buffer.from('<svg/>') : png);},
          getTopLevelFrame() {return this;},
          remove() {nodes.delete(this.id);if(this.parent)this.parent.children.splice(this.parent.children.indexOf(this),1);}
        };
        if(type==='FRAME') Object.assign(n,{children:[],appendChild:append,layoutMode:'NONE',clipsContent:true,
          paddingTop:0,paddingRight:0,paddingBottom:0,paddingLeft:0,itemSpacing:0,layoutGrids:[],
          primaryAxisAlignItems:'MIN',counterAxisAlignItems:'MIN',primaryAxisSizingMode:'FIXED',counterAxisSizingMode:'FIXED'});
        if(type==='VECTOR') Object.assign(n,{vectorPaths:[],vectorNetwork:{vertices:[],segments:[],regions:[]},handleMirroring:[],
          async setVectorNetworkAsync(network){this.vectorNetwork=network;}});
        nodes.set(n.id,n);page.appendChild(n);return n;
      };
      figma.createRectangle = () => node('RECTANGLE');
      figma.createFrame = () => node('FRAME');
      figma.createVector = () => node('VECTOR');
      figma.createPaintStyle = () => {const s={id:'S:'+ ++id,key:'style-key',name:'',description:'',paints:[]};styles.set(s.id,s);return s;};
      figma.getLocalPaintStylesAsync = async () => [...styles.values()];
      for(const type of ['Text','Effect','Grid']) figma['getLocal'+type+'StylesAsync']=async()=>[];
      figma.getStyleByIdAsync = async id => styles.get(id) || null;
      figma.getImageByHash = hash => hash==='image-hash' ? {getBytesAsync:async()=>new Uint8Array(png),getSizeAsync:async()=>({width:1,height:1})} : null;
      figma.createImage = bytes => {assert.deepEqual(Buffer.from(bytes),png);return {hash:'image-hash',getSizeAsync:async()=>({width:1,height:1})};};
      figma.variables = {
        createVariableCollection(name) {const c={id:'C:'+ ++id,name,defaultModeId:'m:1',modes:[{modeId:'m:1',name:'Light'}],variableIds:[],remote:false};collections.set(c.id,c);return c;},
        getVariableCollectionByIdAsync:async id=>collections.get(id)||null,
        getLocalVariableCollectionsAsync:async()=>[...collections.values()],
        getLocalVariablesAsync:async()=>[...variables.values()],
        createVariable(name,c,resolvedType) {const v={id:'V:'+ ++id,name,variableCollectionId:c.id,resolvedType,valuesByMode:{},scopes:['ALL_SCOPES'],codeSyntax:{},remote:false,
          setValueForMode(mode,value){this.valuesByMode[mode]=value;}};variables.set(v.id,v);c.variableIds.push(v.id);return v;},
        getVariableByIdAsync:async id=>variables.get(id)||null,
        setBoundVariableForPaint:(paint,field,v)=>({...paint,boundVariables:{[field]:{type:'VARIABLE_ALIAS',id:v.id}}}),
      };
    });
    const tools = (await client.call('tools/list')).tools;
    const names = new Set(tools.map(t=>t.name));
    assert.equal(tools.filter(tool => !tool.name.startsWith('ae_')).length,166);
    assert.equal(names.size,tools.length);
    for(const name of plugin.main.F2AMCP.commands) assert.ok(names.has(name),'unadvertised handler '+name);
    for(const name of ['get_design_context','get_vector','get_variable_defs','set_auto_layout','create_paint_style','apply_manual_keyframe_track','export_video']) assert.ok(names.has(name),name);
    const call = async (name,args={}) => {
      const text=result(await client.tool(name,args));
      return JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));
    };
    assert.equal((await call('ping')).currentPageName,'Figwright test Page');
    assert.equal((await call('get_metadata')).editorType,'figma');
    const frameReply=result(await client.tool('create_frame',{x:10,y:20,width:320,height:180,name:'Card'}));
    assert.match(frameReply,/Created frame/);
    const frame={id:/with ID: ([^.]+)/.exec(frameReply)[1]};
    await call('set_auto_layout',{nodeId:frame.id,layoutMode:'VERTICAL',paddingTop:16,itemSpacing:8});
    const f=plugin.nodes.get(frame.id);
    assert.equal(f.layoutMode,'VERTICAL');assert.equal(f.paddingTop,16);assert.equal(f.itemSpacing,8);
    const gradient={type:'GRADIENT_LINEAR',gradientStops:[{position:0,color:{r:1,g:0,b:0,a:1}},{position:1,color:{r:0,g:0,b:1,a:1}}],gradientTransform:[[1,0,0],[0,1,0]]};
    await call('set_fills',{nodeId:'https://www.figma.com/design/test/file?node-id='+frame.id.replace(':','-'),fills:[gradient]});
    assert.equal(f.fills[0].type,'GRADIENT_LINEAR');
    await call('set_effects',{nodeId:frame.id,effects:[{type:'LAYER_BLUR',radius:12,visible:true}]});
    assert.equal(f.effects[0].radius,12);
    const context=await call('get_design_context',{nodeId:frame.id});
    assert.equal(context.nodes[0].name,'Card');assert.equal(context.nodes[0].layout.mode,'VERTICAL');
    assert.ok(context.globalVars,'full detail includes shared appearance table');
    assert.equal((await call('get_design_context',{nodeId:frame.id,detail:'minimal'})).nodes[0].width,undefined);
    const style=await call('create_paint_style',{name:'Accent',paints:[{type:'SOLID',color:{r:1,g:0,b:0}}]});
    const listed=await call('get_design_styles');assert.equal(listed.paints[0].id,style.styleId);
    const before=undo;
    const batch=await call('batch',{ops:[
      {tool:'create_variable_collection',params:{name:'Tokens'}},
      {tool:'create_variable',params:{name:'Width',collectionId:'$0',resolvedType:'FLOAT'}},
      {tool:'set_variable_value',params:{variableId:'$1',modeId:'m:1',value:144}},
      {tool:'bind_variable_to_node',params:{nodeId:frame.id,field:'width',variableId:'$1'}},
      {tool:'rename_node',params:{nodeId:frame.id,name:'Bound Card'}},
    ]});
    assert.equal(batch.applied,5);assert.equal(undo,before+1,'mixed batch is one Figma undo step');
    const variableId=batch.results[1].result.variableId;
    assert.equal(variables.get(variableId).valuesByMode['m:1'],144);
    assert.equal(f.boundVariables.width.id,variableId);
    assert.ok((await call('get_variable_defs')).collections.length);
    const vector=await call('create_vector',{name:'Triangle',vectorPaths:[{windingRule:'NONZERO',data:'M0 0 L20 0 L10 20 Z'}]});
    assert.equal((await call('get_vector',{nodeId:vector.nodeId})).vectorPaths[0].data,'M 0 0 L 20 0 L 10 20 Z');
    await call('set_vector',{nodeId:vector.nodeId,vectorPaths:[{windingRule:'NONZERO',data:'M0 0 L40 0 Z'}]});
    assert.equal(plugin.nodes.get(vector.nodeId).vectorPaths[0].data,'M 0 0 L 40 0 Z');
    const imagePath=path.join(temp,'原始 图片.png');await fs.writeFile(imagePath,png);
    const imageBatch=await call('batch',{ops:[{tool:'import_image',params:{path:imagePath}},{tool:'rename_node',params:{nodeId:'$0',name:'Batch image'}}]});
    assert.equal(imageBatch.applied,2);
    assert.equal(plugin.nodes.get(imageBatch.results[0].result.nodeId).name,'Batch image');
    const image=await call('import_image',{path:imagePath,name:'Original'});
    assert.equal(plugin.nodes.get(image.nodeId).fills[0].imageHash,'image-hash');
    await call('set_design_image_fill',{nodeId:frame.id,path:imagePath});
    const originals=await call('save_image_fills',{nodeIds:[image.nodeId,frame.id],outDir:path.join(temp,'originals')});
    assert.deepEqual(await fs.readFile(originals.nodes[0].images[0].path),png);
    assert.equal(originals.nodes[0].images[0].path,originals.nodes[1].images[0].path,'shared images reuse one asset');
    const screenshot=await client.tool('get_screenshot',{nodeIds:[frame.id]});
    assert.ok(screenshot.content.some(c=>c.type==='image'&&c.mimeType==='image/png'));
    const saved=await call('save_screenshots',{nodeIds:[frame.id],outDir:path.join(temp,'screenshots'),scale:2});
    assert.deepEqual(await fs.readFile(saved.saved[0].path),png);
    assert.equal(exports.at(-1).constraint.value,2,'disk screenshots preserve explicit scale');
    const pdf=await call('export_pdf',{nodeId:frame.id,outPath:path.join(temp,'card.pdf')});
    assert.match(await fs.readFile(pdf.path,'utf8'),/^%PDF/);
    const video=await call('export_video',{nodeId:frame.id,format:'GIF',outPath:path.join(temp,'motion.gif')});
    assert.deepEqual(await fs.readFile(video.path),png,'video bytes survive JSON transport');
    const rejected=await client.tool('set_opacity',{nodeId:frame.id,opacity:0.5,typo:1});
    assert.equal(rejected.isError,true);assert.equal(f.opacity,1,'unknown arguments never silently disappear');
    const failed=await call('batch',{ops:[{tool:'set_opacity',params:{nodeId:frame.id,opacity:0.4}},{tool:'set_opacity',params:{nodeId:'missing',opacity:0.1}}]});
    assert.equal(failed.ok,false);assert.equal(failed.applied,1);assert.equal(failed.rolledBack,false);assert.equal(f.opacity,0.4);
    // A long read must yield through the real F2A iframe and resume the same in-flight command.
    const originalPost=plugin.figma.ui.postMessage;
    plugin.figma.ui.postMessage=message=>{if(message.tag==='@figwright/yield')yieldReplies++;originalPost(message);};
    for(let i=0;i<6;i++) f.appendChild(plugin.figma.createRectangle());
    vm.runInContext('var savedDateNow = Date.now; var sliceClock = 100000; Date.now = function(){return sliceClock += 50;};',plugin.main);
    try {
      const tree=await call('get_node',{nodeId:frame.id});
      assert.equal(tree.node.children.length,6);
      assert.ok(yieldReplies>0,'serialization must yield and complete through the real UI script');
    } finally {vm.runInContext('Date.now = savedDateNow;',plugin.main);}
    console.log('PASS: 109 Figwright tools in relocated F2A runtime; schemas, full design context, gradients/effects/layout, styles, variables/bindings, mixed batch/undo, vector geometry, local image import, original assets, screenshots, PDF/video bytes, failure reporting and cooperative UI round-trip');
  } finally {
    if(client)await client.close();if(plugin)await plugin.close();
    relay.server.closeAllConnections();await new Promise(resolve=>relay.server.close(resolve));
    await fs.rm(temp,{recursive:true,force:true});
  }
}
check().catch(error=>{console.error(error);process.exitCode=1;});
