const assert=require('node:assert/strict');
const {node,harness}=require('./export-options.cjs');
const geometry=[{data:'M0 0H100V60H0Z',windingRule:'NONZERO'}];
const shape=(name,extra={})=>node('RECTANGLE',name,{cornerRadius:0,fillGeometry:geometry,
  fills:[{type:'SOLID',color:{r:.2,g:.4,b:.7}}],...extra});
const mask=(name,extra={})=>shape(name,{isMask:true,...extra});

async function check(){
  for(const bitmap of [false,true]){
    const empty=mask('image 381',bitmap?{fills:[{type:'IMAGE',imageHash:'unused',scaleMode:'CROP'}]}:{});
    const hidden=shape('Hidden artwork',{visible:false}),kept=shape('Unmasked artwork');
    const root=node('FRAME','Empty mask',{children:[kept,empty,hidden]});
    const h=harness(root);
    h.figma.getImageByHash=()=>{throw new Error('An unused image mask must not load or export its bitmap');};
    const result=await h.run();
    assert.deepEqual(result.ship.nodes.map(n=>n.name),['Unmasked artwork']);
    assert.equal(result.ship.nodes[0].maskId,null);assert.equal(result.images.length,0);
    assert.equal(empty.isMask,true);assert.equal(empty.visible,true);assert.equal(hidden.visible,false);
    assert.equal(root.children.length,3,'Do not delete or change the original Figma mask');
  }
  const hiddenMask=harness(node('FRAME','Hidden mask',{children:[mask('Hidden mask',{visible:false}),shape('Visible artwork')]}));
  const hiddenResult=await hiddenMask.run();
  assert.deepEqual(hiddenResult.ship.nodes.map(n=>n.name),['Visible artwork']);assert.equal(hiddenResult.ship.nodes[0].maskId,null);

  const next=harness(node('FRAME','Next mask',{children:[mask('Unused mask'),mask('Working mask'),shape('Masked artwork')]}));
  const nextResult=await next.run();
  assert.equal(nextResult.ship.nodes.some(n=>n.name==='Unused mask'),false);
  const source=nextResult.ship.nodes.find(n=>n.name==='Working mask');
  assert.equal(source.maskSource,source.id);assert.equal(nextResult.ship.nodes.find(n=>n.name==='Masked artwork').maskId,source.id);

  const clipped=node('FRAME','Clipped boundary',{clipsContent:true,children:[shape('Clipped artwork')]});
  const boundary=harness(node('FRAME','Boundary',{children:[mask('Unused before clip'),clipped]}));
  const boundaryResult=await boundary.run();
  assert.equal(boundaryResult.ship.nodes.some(n=>n.name==='Unused before clip'),false);
  assert.equal(boundaryResult.ship.nodes.find(n=>n.name==='Clipped artwork').maskId,null);
  assert.equal(boundaryResult.ship.containers.find(n=>n.name==='Clipped boundary').clip,true);
  console.log('PASS: empty vector/image masks are skipped without artwork or bitmap export; hidden masks, working masks and clipping boundaries retain their scope; originals unchanged');
}
check().catch(error=>{console.error(error);process.exitCode=1;});
