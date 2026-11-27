const assert=require('node:assert/strict');
const {node,harness}=require('./export-options.cjs');
const {png}=require('./direct-aep.cjs');

async function check(){
  const root=node('FRAME','Pixel grid',{width:320,height:200,
    absoluteBoundingBox:{x:500.125,y:200.375,width:320,height:200},
    absoluteTransform:[[1,0,500.125],[0,1,200.375]],children:[]});
  const source=node('RECTANGLE','*Fractional raster',{width:100.37,height:37.21,
    absoluteBoundingBox:{x:528.75,y:222.25,width:100.37,height:37.21},
    absoluteRenderBounds:{x:528.75,y:222.25,width:100.37,height:37.21},
    absoluteTransform:[[1,0,528.75],[0,1,222.25]]});
  root.children=[source];source.parent=root;
  const h=harness(root),frames=[],create=h.figma.createFrame;
  h.figma.createFrame=function(){const frame=create();frames.push(frame);return frame;};
  source.exportAsync=async function(options){
    assert.equal(options.useAbsoluteBounds,true);
    const copy=this.children[0],matrix=copy.relativeTransform;
    assert.deepEqual(Array.from(matrix[0]).slice(0,2),[1,0]);
    assert.deepEqual(Array.from(matrix[1]).slice(0,2),[0,1]);
    assert.ok(Math.abs(matrix[0][2]+this.x-528.75)<1e-6);
    assert.ok(Math.abs(matrix[1][2]+this.y-222.25)<1e-6);
    return png(Math.round(this.width*options.constraint.value),Math.round(this.height*options.constraint.value));
  };
  for(const scale of [1,2,3,4])for(const bicubicExport of [false,true]){
    const result=await h.run(true,false,false,false,{rasterScale:scale,bicubicExport});
    const image=result.images[0],factor=bicubicExport?2:1;
    const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,[a,b]);
    near(image.x*scale,Math.round(image.x*scale));near(image.y*scale,Math.round(image.y*scale));
    near(image.natW,image.w*scale*factor);near(image.natH,image.h*scale*factor);
    near(image.cx-image.w/2,image.x);near(image.cy-image.h/2,image.y);
    assert.ok(image.x<=28.625&&image.x+image.w>=28.625+100.37-1e-6);
    assert.ok(image.y<=21.875&&image.y+image.h>=21.875+37.21-1e-6);
    if(bicubicExport)assert.deepEqual(image.bicubic,{width:image.natW/2,height:image.natH/2});
    assert.ok(frames.every(frame=>frame.removed),'Clean up every temporary render canvas');
    assert.equal(source.parent,root);assert.equal(source.width,100.37);assert.equal(source.height,37.21);
  }
  source.exportAsync=async()=>{throw new Error('raster failed');};
  await h.context.exportSelectionSVG(true,false,true,false,false,false,{rasterScale:2});
  assert.match(h.messages.find(m=>m.type==='error').message,/raster failed/);
  assert.ok(frames.every(frame=>frame.removed),'Clean up the padded canvas after a renderer failure');

  const width = 17 + 1e-12;
  const bounds = {x:20,y:30,width,height:227};
  const roundoff = node('VECTOR','Subpixel width rounding',{
    width,height:227,absoluteBoundingBox:bounds,absoluteRenderBounds:bounds,
    fills:[{type:'SOLID',color:{r:1,g:1,b:1}}],
  });
  const exact = harness(roundoff);
  roundoff.exportAsync = async function (options) {
    const s = options.constraint.value;
    return png(Math.ceil(this.width*s),Math.ceil(this.height*s));
  };
  const rounded = await exact.run(true,false,false,false,{target:'ae',rasterVectorShapes:true});
  assert.deepEqual(rounded.images.map(im=>[im.x,im.y,im.cw,im.ch,im.natW,im.natH]), [[0,0,17,227,17,227]],
    'Floating-point noise must not add a pixel to the PNG and shift its anchor');
  console.log('PASS: fractional raster retains geometry and subpixel offset inside pixel-aligned padding at 1/2/3/4×; exact 2× bicubic source; rounding, original nodes and failure cleanup');
}
check().catch(error=>{console.error(error);process.exitCode=1;});
