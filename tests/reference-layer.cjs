const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
class FootageItem {constructor(file){this.width=200;this.height=120;this.mainSource={file};}}
class CompItem {
  constructor(){this.items=[];this.layers={add:item=>{const layer=new Layer(this,item);this.items.unshift(layer);return layer;}};}
  get numLayers(){return this.items.length;} layer(i){return this.items[i-1];}
}
class Layer {
  constructor(comp,source){this.containingComp=comp;this.source=source;this.values={};this.enabled=true;}
  get index(){return this.containingComp.items.indexOf(this)+1;}
  property(){return {property:key=>({setValue:value=>{this.values[key]=value;},get value(){return null;}})}}
  moveToBeginning(){const list=this.containingComp.items;list.splice(list.indexOf(this),1);list.unshift(this);}
  moveAfter(other){const list=this.containingComp.items;list.splice(list.indexOf(this),1);list.splice(list.indexOf(other)+1,0,this);}
  remove(){const list=this.containingComp.items;list.splice(list.indexOf(this),1);}
}
function File(name){this.exists=true;this.fsName=name;}
File.encode=encodeURI;
function ImportOptions(file){this.file=file;}
const comp=new CompItem(),footage=[],app={project:{activeItem:comp,get numItems(){return footage.length;},item:i=>footage[i-1],importFile(options){const item=new FootageItem(options.file);footage.push(item);return item;}},beginUndoGroup(){},endUndoGroup(){}};
const context=vm.createContext({app,CompItem,FootageItem,File,ImportOptions});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../host/figma/aeShapeBuilder.jsx'),'utf8'),context);
const builder=context.AEShapeBuilder;builder.build({shapes:[]},{comp});
const image=(name,z,reference=false,external=false)=>({file:name+'.png',name,natW:200,natH:120,cx:50,cy:30,cw:100,ch:60,w:100,h:60,scaleMode:'FIT',z,reference,external});
const rasterComp=new CompItem();
builder.buildImages(rasterComp,[{...image('fractional baked',0),cw:99.72,ch:59.86,rasterScale:2}], 'assets');
assert.deepEqual(Array.from(rasterComp.layer(1).values['ADBE Scale']),[50,50,100],'Integer PNG rounding must not rescale baked pixels');
assert.deepEqual(Array.from(rasterComp.layer(1).values['ADBE Position']),[50,30,0],'Keep the original raster centre');
builder.build({shapes:[]},{comp});
assert.equal(builder.buildImages(comp,[image('reference',0,true),image('lower',1),image('upper',2),image('root shadow',-.01,false,true)],'assets'),4);
builder.restack(comp);
assert.equal(comp.layer(1).name,'reference');assert.equal(comp.layer(1).enabled,false);
assert.deepEqual(Array.from(comp.layer(1).values['ADBE Position']),[50,30,0]);
assert.ok(!/reference/.test(builder.getDiag().split('top>bottom:')[1]||''),'References must stay out of the artwork hierarchy');
let members;
comp.layers.precompose=indices=>{members=Array.from(indices);throw new Error('Stop after checking precompose membership');};
assert.equal(builder.organize(comp,[{id:'root',root:true,name:'root',path:[],x:0,y:0,w:100,h:60}]),0);
assert.equal(members.length,2);assert.ok(members.every(i=>!['reference','root shadow'].includes(comp.layer(i).name)));
builder.restack(comp);assert.equal(comp.layer(1).name,'reference');assert.equal(comp.layer(1).enabled,false);
console.log('PASS: production AE image builder imports reference at the correct position, excludes it from artwork ordering, restores it to top and keeps it hidden');
