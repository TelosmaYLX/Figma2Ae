const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
// Minimal DOM: main.js only appends children, reads textContent/className and scrolls the list.
class Node{
  constructor(tag){this.tagName=tag;this.className='';this.children=[];this.textContent='';this.hidden=false;this.scrollTop=0;this.scrollHeight=0;}
  appendChild(child){this.children.push(child);return child;}
  removeChild(child){const at=this.children.indexOf(child);if(at<0)throw new Error('not a child');this.children.splice(at,1);return child;}
  get firstChild(){return this.children[0]||null;}
  set innerHTML(value){if(!value)this.children=[];this._html=value;}
  get innerHTML(){return this._html||'';}
  addEventListener(){}
}
function panel(){
  const nodes={},document={getElementById(id){return nodes[id]||(nodes[id]=new Node('div'));},createElement(tag){return new Node(tag);},addEventListener(){}};
  const window={};
  vm.runInNewContext(fs.readFileSync(path.join(root,'client/main.js'),'utf8'),{window,document,console,setTimeout(){},clearTimeout(){},Date,navigator:{platform:'win32'}});
  return {nodes,window};
}
const check=()=>{
  const {nodes,window}=panel();
  const list=nodes['mk-log'],last=()=>list.children.at(-1)||{children:[{textContent:''},{}]};
  assert.ok(list,'the panel carries the log container');
  assert.equal(list.children.length,1,'one boot line');
  const boot=list.children[0];
  assert.match(boot.children[0].textContent,/^\d{2}:\d{2}:\d{2}$/,'every line starts with a timestamp');
  assert.equal(boot.children[1].textContent,'F2A 面板已加载');
  assert.match(boot.className,/\bok\b/);

  window.MKLog('已保存 3 张图片 → D:/素材');
  assert.match(last().children[1].textContent,/已保存 3 张图片/);
  assert.equal(last().className.replace('mk-log-line','').trim(),'','Neutral progress lines keep the muted colour');
  window.MKLog('AE: error on layer','err');assert.match(last().className,/err/);

  window.MKReport('导入完成');
  assert.equal(last().children[1].textContent,'导入完成','bridge messages reach the log through the report hook');
  window.MKReport('导入失败：磁盘已满',true);assert.match(last().className,/err/);
  window.MKReport('导入完成：8 个形状 · 18 张图片 · 28 个预合成','ok');assert.match(last().className,/\bok\b/);
  window.MKReport('导入完成：8 个形状 · 18 张图片\n注意：空组 1/29：图层 15 拷贝 1 内容','warn');
  assert.match(last().className,/\bwarn\b/);
  assert.equal(last().children[1].children[0].textContent,'导入完成：8 个形状 · 18 张图片');
  assert.equal(last().children[1].children[1].textContent,'注意：空组 1/29：图层 15 拷贝 1 内容');
  assert.match(last().children[1].children[1].className,/is-warn/);
  assert.equal(last().children[1]._html,undefined,'multi-line log entries never assign innerHTML');
  assert.equal(nodes['mk-log-count'].textContent,String(list.children.length),'header count badge reflects live entry count');
  assert.equal(nodes['mk-log-count'].hidden,false);

  // Markup must stay literal: AE and Figma text can contain angle brackets.
  window.MKLog('<script>alert(1)</script>');
  assert.equal(last().children[1].textContent,'<script>alert(1)</script>');
  assert.equal(last().children[1]._html,undefined,'the log never assigns innerHTML from a message');

  for(let i=0;i<300;i++)window.MKLog('line '+i);
  assert.equal(list.children.length,200,'the console keeps the newest 200 lines');
  assert.equal(list.children.at(-1).children[1].textContent,'line 299');
  assert.equal(list.scrollTop,list.scrollHeight,'new lines keep the list scrolled to the end');

  nodes['mk-log-clear'].onclick();
  assert.equal(list.children.length,0,'清空 empties the console');
  assert.equal(nodes['mk-log-count'].hidden,true,'clearing hides the count badge');

  // Host import log formatting: never list successful layer/precomp names; keep real warnings.
  {
    class CompItem{
      constructor(id=1,name='群星计划'){
        this.id=id;this.name=name;this.width=100;this.height=100;this.items=[];
        this.layers={
          addShape:()=>{const l=new Layer(this,'Shape');this.items.unshift(l);return l;},
          precompose:(indices,cname)=>{
            const pc=new CompItem(id+10,cname);
            const moved=indices.slice().sort((a,b)=>a-b).map(idx=>this.items[idx-1]);
            for(const m of moved){const at=this.items.indexOf(m);if(at>=0)this.items.splice(at,1);m.containingComp=pc;pc.items.push(m);}
            const pcLayer=new Layer(this,cname);pcLayer.source=pc;this.items.unshift(pcLayer);return pc;
          }
        };
      }
      get numLayers(){return this.items.length;}
      layer(i){return this.items[i-1];}
      openInViewer(){}
    }
    class Layer{
      constructor(comp,name){this.containingComp=comp;this.name=name;this.enabled=true;}
      get index(){return this.containingComp.items.indexOf(this)+1;}
      property(){
        const group={numProperties:0,addProperty:()=>group,property:()=>({value:[0,0,0],setValue(){}}),moveTo(){}};
        return group;
      }
      moveToBeginning(){const a=this.containingComp.items;a.splice(a.indexOf(this),1);a.unshift(this);}
      moveAfter(other){const a=this.containingComp.items;a.splice(a.indexOf(this),1);a.splice(a.indexOf(other)+1,0,this);}
      moveBefore(other){const a=this.containingComp.items;a.splice(a.indexOf(this),1);a.splice(a.indexOf(other),0,this);}
      remove(){const a=this.containingComp.items;const at=a.indexOf(this);if(at>=0)a.splice(at,1);}
    }
    const comp=new CompItem(1,'群星计划');
    const files={
      job:JSON.stringify({name:'群星计划',nodesPath:'nodes',containersPath:'containers'}),
      nodes:JSON.stringify([{id:'n1',name:'宝石 1',path:['c1'],z:1,fills:[],strokes:[]}]),
      containers:JSON.stringify([
        {id:'c1',name:'宝石 1',path:[],z:1,x:0,y:0,w:50,h:50},
        {id:'c2',name:'图层 15 拷贝 1 内容',path:[],z:2,x:0,y:0,w:50,h:50}
      ])
    };
    function File(name){this.exists=name in files;this.open=()=>{};this.close=()=>{};this.read=()=>files[name];}
    File.encode=encodeURI;
    const app={project:{activeItem:comp,numItems:1,item:()=>comp},beginUndoGroup(){},endUndoGroup(){}};
    const ctx=vm.createContext({
      app,CompItem,File,
      Shape:function(){},
      MaskMode:{ADD:1},
      SVGParser:{fromNodes(){return {shapes:[{name:'宝石 1',path:['c1'],z:1,subpaths:[]}]};}}
    });
    vm.runInContext(fs.readFileSync(path.join(root,'host/figma/aeShapeBuilder.jsx'),'utf8'),ctx);
    vm.runInContext(fs.readFileSync(path.join(root,'host/figma/figmaRunner.jsx'),'utf8'),ctx);
    const out=ctx.runImportBatch('job');
    assert.match(out,/导入完成：1 个形状 · 1 个预合成/);
    assert.ok(!/swallowed:|top>bottom:|stack already|order ok|宝石 1/.test(out),'successful layer names and debug stack telemetry stay out of the user log: '+out);
    assert.match(out,/\n注意：空组 1\/2（图层 15 拷贝 1 内容）/,'real warnings like empty groups remain visible with their names');
    // Developer diagnostics remain intact for automated tests.
    assert.match(ctx.AEShapeBuilder.getDiag(),/swallowed: 宝石 1\(1\)/);
    assert.match(ctx.AEShapeBuilder.getDiag(),/top>bottom: 宝石 1#1/);
  }

  const html=fs.readFileSync(path.join(root,'client/index.html'),'utf8');
  const css=fs.readFileSync(path.join(root,'client/style.css'),'utf8');
  assert.match(html,/id="mk-log"/);assert.match(html,/id="mk-log-clear"/);
  assert.ok(html.indexOf('src="main.js"')<html.indexOf('src="figmaBridge.js"'),'main.js loads first so bridge lines from the first tick are logged');
  assert.ok(!/mk-status|mk-main|mk-overlay|导入 SVG/.test(html),'no toast bubble, tool buttons or popup left in the panel');
  assert.ok(!/\.mk-status|\.mk-main|\.mk-btn|\.mk-overlay|\.mk-popup/.test(css),'their styles go with the markup');
  assert.equal(window.MKToast,undefined,'messages no longer surface as a bubble');
  assert.match(css,/\.mk-figbar\{[^}]*margin:2px 14px 4px/,'the two status lines sit 6px apart');
  console.log('PASS: timestamped panel log, tone classes, report hook, 200-line cap, literal text, clear button, script order and a toast-free panel');
};
check();
