const assert=require('node:assert/strict');
const {node,group,harness}=require('./export-options.cjs');
const {png}=require('./direct-aep.cjs');

function withRealRelativeTransform(create){
  function coordOrigin(parent){
    let origin=parent;
    while(origin&&(origin.type==='GROUP'||origin.type==='BOOLEAN_OPERATION'))origin=origin.parent;
    return origin&&origin.type!=='PAGE'&&origin.absoluteTransform?origin.absoluteTransform:[[1,0,0],[0,1,0]];
  }
  return function(){
    const frame=create();
    let rel=[[1,0,0],[0,1,0]];
    Object.defineProperty(frame,'relativeTransform',{
      get(){return rel;},
      set(m){
        rel=m.map(r=>r.slice());
        const o=coordOrigin(this.parent);
        this.x=o[0][0]*rel[0][2]+o[0][1]*rel[1][2]+o[0][2];
        this.y=o[1][0]*rel[0][2]+o[1][1]*rel[1][2]+o[1][2];
      }
    });
    return frame;
  };
}

async function checkGroupParent(){
  for(const deep of [false,true]){
    const rootX=5200,rootY=6704,dx=859,dy=430;
    const backdrop=node('RECTANGLE','背景遮罩',{
      absoluteBoundingBox:{x:rootX,y:rootY,width:2560,height:1440},
      absoluteRenderBounds:{x:rootX,y:rootY,width:2560,height:1440},
      absoluteTransform:[[1,0,rootX],[0,1,rootY]]});
    const frosted=node('RECTANGLE','弹窗毛玻璃底',{width:842,height:580.914733886719,
      absoluteBoundingBox:{x:rootX+dx,y:rootY+dy,width:842,height:580.914733886719},
      absoluteRenderBounds:{x:rootX+dx,y:rootY+dy,width:842,height:580.914733886719},
      absoluteTransform:[[1,0,rootX+dx],[0,1,rootY+dy]],
      effects:[{type:'BACKGROUND_BLUR',visible:true,radius:46.5}]});
    const label=node('TEXT','弹窗标题',{
      absoluteBoundingBox:{x:rootX+dx+100,y:rootY+dy+40,width:200,height:40},
      absoluteRenderBounds:{x:rootX+dx+100,y:rootY+dy+40,width:200,height:40},
      absoluteTransform:[[1,0,rootX+dx+100],[0,1,rootY+dy+40]]});
    const inner=group('弹窗',[frosted,label],{
      absoluteBoundingBox:{x:rootX+dx,y:rootY+dy,width:842,height:580.914733886719},
      absoluteRenderBounds:{x:rootX+dx,y:rootY+dy,width:842,height:580.914733886719},
      absoluteTransform:[[1,0,rootX+dx],[0,1,rootY+dy]],width:842,height:580.914733886719});
    inner.insertChild=function(index,child){
      if(child.parent?.children)child.parent.children=child.parent.children.filter(c=>c!==child);
      this.children.splice(index,0,child);child.parent=this;
    };
    const holder=deep?group('外层组',[inner],{
      absoluteBoundingBox:{x:rootX+dx-20,y:rootY+dy-10,width:862,height:590.914733886719},
      absoluteRenderBounds:{x:rootX+dx-20,y:rootY+dy-10,width:862,height:590.914733886719},
      absoluteTransform:[[1,0,rootX+dx-20],[0,1,rootY+dy-10]]}):inner;
    const root=node('FRAME','车牌_替换确认弹窗',{children:[backdrop,holder],
      width:2560,height:1440,
      absoluteBoundingBox:{x:rootX,y:rootY,width:2560,height:1440},
      absoluteRenderBounds:{x:rootX,y:rootY,width:2560,height:1440},
      absoluteTransform:[[1,0,rootX],[0,1,rootY]]});
    const h=harness(root);
    h.figma.createFrame=withRealRelativeTransform(h.figma.createFrame);
    let checked=0;
    frosted.exportAsync=async function(options){
      checked++;
      assert.equal(this.name,'F2A 切图');assert.equal(options.useAbsoluteBounds,true);
      assert.equal(this.parent.name,'弹窗');
      assert.deepEqual(JSON.parse(JSON.stringify(this.relativeTransform)),[[1,0,dx],[0,1,dy]],'Canvas inside a GROUP must resolve relativeTransform against the non-GROUP ancestor');
      assert.deepEqual(JSON.parse(JSON.stringify(this.absoluteTransform)),[[1,0,rootX+dx],[0,1,rootY+dy]]);
      const copy=this.children[0];
      assert.ok(copy.relativeTransform,'Cloned node must be positioned inside the padded canvas');
      return png(Math.round(this.width),Math.round(this.height));
    };
    const result=await h.run(true,true,true,false,{target:'aep'});
    assert.equal(checked,1);
    assert.equal(result.images.length,1);
    assert.equal(result.images[0].x,dx);assert.equal(result.images[0].y,dy);
    assert.equal(result.images[0].natW,842);assert.equal(result.images[0].natH,581);
  }
}

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
  await checkGroupParent();
  console.log('PASS: fractional background-blur raster keeps its original backdrop order, excludes later text and the duplicate source, resolves GROUP parents against their coordinate ancestor, and retains pixel padding in leaf/group and auto-layout cases');
}
check().catch(error=>{console.error(error);process.exitCode=1;});
