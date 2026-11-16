const assert=require('node:assert/strict');
const {node,group,harness}=require('./export-options.cjs');
const {png}=require('./direct-aep.cjs');

async function check(){
  for(const nested of [false,true])for(const autoLayout of [false,true]){
    const background=node('RECTANGLE','background');
    const frosted=node('RECTANGLE','frosted',{width:100.37,height:37.21,
      absoluteBoundingBox:{x:28.625,y:21.875,width:100.37,height:37.21},
      absoluteRenderBounds:{x:28.625,y:21.875,width:100.37,height:37.21},
      absoluteTransform:[[1,0,28.625],[0,1,21.875]],
      effects:[{type:'BACKGROUND_BLUR',visible:true,radius:8}]});
    const target=nested?group('*frosted group',[frosted],{
      absoluteBoundingBox:frosted.absoluteBoundingBox,absoluteRenderBounds:frosted.absoluteRenderBounds,
      absoluteTransform:frosted.absoluteTransform,width:frosted.width,height:frosted.height}):frosted;
    const foreground=node('TEXT','foreground title');
    const root=node('FRAME','scene',{children:[background,target,foreground],
      absoluteTransform:[[1,0,0],[0,1,0]],absoluteBoundingBox:{x:0,y:0,width:320,height:200},
      layoutMode:autoLayout?'HORIZONTAL':'NONE'});
    root.insertChild=function(index,child){
      if(child.parent?.children)child.parent.children=child.parent.children.filter(c=>c!==child);
      this.children.splice(index,0,child);child.parent=this;
    };
    const h=harness(root),frames=[],create=h.figma.createFrame;
    h.figma.createFrame=function(){const frame=create();frames.push(frame);return frame;};
    let renders=0;
    target.exportAsync=async function(options){
      renders++;
      assert.equal(this.name,'F2A 切图');assert.equal(options.useAbsoluteBounds,true);
      const siblings=this.parent.children,index=siblings.indexOf(this);
      assert.deepEqual(siblings.slice(0,index).map(n=>n.name),['background'],'Only the earlier background is behind the raster canvas');
      assert.equal(siblings[index+1].name,target.name,'The original source must be after the canvas, avoiding duplicate backdrop pixels');
      assert.equal(siblings[index+2].name,'foreground title','Foreground text must remain above the canvas');
      if(autoLayout)assert.equal(this.layoutPositioning,'ABSOLUTE','The temporary canvas must not enter auto layout');
      return png(Math.round(this.width),Math.round(this.height));
    };
    const result=await h.run(true,true,true,false,{target:'aep'});
    assert.equal(renders,1);assert.equal(result.ship.texts.length,1);assert.equal(result.images.length,1);
    assert.equal(result.images[0].x,28);assert.equal(result.images[0].y,21);
    assert.equal(result.images[0].natW,101);assert.equal(result.images[0].natH,39);
    assert.deepEqual(root.children.map(n=>n.name),['background',target.name,'foreground title']);
    assert.ok(frames.every(frame=>frame.removed));
  }
  console.log('PASS: fractional background-blur raster keeps its original backdrop order, excludes later text and the duplicate source, and retains pixel padding in leaf/group and auto-layout cases');
}
check().catch(error=>{console.error(error);process.exitCode=1;});
