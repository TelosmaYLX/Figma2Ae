'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {png}=require('./direct-aep.cjs');
const {exportAep}=require('../scripts/export-aep.cjs');
async function main(){
  const dir=path.resolve('artifacts/precomp-pixel-grid');await fs.mkdir(dir,{recursive:true});
  const image={name:'Sharp alpha edge',ext:'png',x:8,y:8,w:64,h:64,cx:40,cy:40,cw:64,ch:64,natW:64,natH:64,
    scaleMode:'FIT',rasterScale:1,opacity:1,blend:'NORMAL',data:png(64,64).toString('base64')};
  const containers=[
    {id:'outer',name:'Fractional outer',x:.625,y:.80145,w:94.1,h:94.2,path:[],clip:false},
    {id:'clip',name:'Fractional clip',x:3.375,y:4.625,w:85.333,h:83.667,path:['outer'],clip:true},
    {id:'inner',name:'Fractional inner',x:5.10156,y:6.34784,w:80.666,h:78.666,path:['outer','clip'],clip:false}
  ].map((c,z)=>({...c,z,opacity:1,blend:'PASS_THROUGH',collapseForBlends:false}));
  const fixture={};
  for(const name of ['flat','nested']){
    const output=await fs.mkdtemp(path.join(dir,name+'-'));
    const data={name:'Pixel grid '+name,svg:'<svg width="96" height="96"></svg>',frame:{width:96,height:96},
      texts:[],images:[{...image,path:name==='flat'?[]:['outer','clip','inner']},{...image,name:'Hidden reference',reference:true,hidden:true,path:[]}],
      imageCount:2,organize:true,containers:name==='flat'?[]:containers};
    fixture[name]=await exportAep(data,output);
  }
  const file=path.join(dir,'fixture.json');await fs.writeFile(file,JSON.stringify(fixture));
  execFileSync(path.resolve('.venv-aep/Scripts/python.exe'),['tests/check-precomp-pixel-grid.py',file],{stdio:'inherit'});
  console.log('PASS: original image placement and scale survive three uncollapsed fractional frames and explicit clipping');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
