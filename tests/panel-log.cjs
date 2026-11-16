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

  window.MKToast('导入完成');
  assert.equal(last().children[1].textContent,'导入完成','Bridge and import messages reach the log through the shared toast');
  window.MKToast('导入失败：磁盘已满',true);assert.match(last().className,/err/);

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

  const html=fs.readFileSync(path.join(root,'client/index.html'),'utf8');
  assert.match(html,/id="mk-log"/);assert.match(html,/id="mk-log-clear"/);
  assert.ok(html.indexOf('src="main.js"')<html.indexOf('src="figmaBridge.js"'),'main.js loads first so bridge lines from the first tick are logged');
  console.log('PASS: timestamped panel log, tone classes, toast hand-off, 200-line cap, literal text, clear button and script order');
};
check();
