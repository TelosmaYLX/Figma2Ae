const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..'), output = path.join(root, 'artifacts/undo/client', String(process.pid));
let testId = 0;
function harness({rememberFolder = true, failImages = false, shadowRenderer, nativeFolder, activeCompId = 101} = {}) {
  const dir = path.join(output, String(++testId)), assets = path.join(dir, 'assets');
  fs.mkdirSync(assets, {recursive: true});
  const native = [], pending = [], pickers = [], messages = [], folderCalls = [], elements = {}, launchCalls=[];
  let callbacks, active = 0, svgId = 0;
  const storage = new Map(rememberFolder ? [['f2a.imageFolder', assets]] : []);
  const disk = Object.create(fs);
  disk.writeFileSync = (file, data, encoding) => {
    if (failImages && path.dirname(path.resolve(file)) === assets) { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; }
    return fs.writeFileSync(file, data, encoding);
  };
  const bridge = {start(opts) { callbacks = opts; }, saveTemp(svg) { const file = path.join(dir, 'source-' + (++svgId) + '.svg'); fs.writeFileSync(file, svg); return file; }};
  const window = {MKReport(m) { messages.push(m); }, __adobe_cep__: {
    getSystemPath() { return root.replaceAll('\\', '/'); },
    evalScript(script, callback) {
      if (script.startsWith('runImportBatch(')) {
        assert.equal(active, 0, 'Only one mutating native evaluation may run at a time'); active++;
        const file = script.match(/\("([^"]+)"\)/)[1], job = JSON.parse(fs.readFileSync(file, 'utf8'));
        native.push({file, job, id: JSON.parse(fs.readFileSync(job.nodesPath, 'utf8'))[0]?.id}); pending.push(callback);
      } else if (script === 'mkFigmaTargetCompId()') callback(String(activeCompId));
      else if (script.startsWith('mkChooseImageFolder(')) pickers.push(callback);
      else { assert.ok(!/^runImport\(|^runImportImages\(|^runOrganize\(/.test(script), 'Old split import entry must not be called'); if (callback) callback('loaded'); }
    }
  }};
  if (nativeFolder) window.cep={fs:{showOpenDialogEx(...args){folderCalls.push(args);return nativeFolder();}}};
  class Clock extends Date { static now() { return 123456789; } }
  const result={launchCalls,launchError:null};
  const launcherModule={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'client/aepLauncher.js'),'utf8'),{module:launcherModule,process:{platform:'win32',env:{SystemRoot:'C:/Windows'}},require(name){
    if(name==='child_process')return{execFile(file,args,options,callback){launchCalls.push({file,args,options});callback(result.launchError,'',result.launchError?result.launchError.message:'');}};
    return require(name);
  }});
  vm.runInNewContext(fs.readFileSync(path.join(root, 'client/figmaBridge.js'), 'utf8'), {
    window, Buffer, Date: Clock, process: {platform: 'linux'},
    document: {getElementById(id) { return elements[id] ||= {}; }}, setTimeout() {}, clearTimeout() {},
    localStorage: {getItem(k) { return storage.get(k) || ''; }, setItem(k, v) { storage.set(k, v); }, removeItem(k) { storage.delete(k); }},
    require(name) { if (name === 'fs') return disk; if (name === 'os') return {tmpdir: () => dir}; if(name.endsWith('/client/aepLauncher.js'))return launcherModule.exports; if (name.endsWith('/client/figmaRasterEffects.js') && shadowRenderer) return shadowRenderer; if (name.endsWith('/client/mkBridgeServer.js')) return bridge; return require(name); }
  });
  return Object.assign(result,{native, pending, pickers, messages, elements, storage, window, folderCalls, assets, get callbacks(){return callbacks;},
    start(id, imageCount, compSize) { return callbacks.onSvg('<svg width="10" height="10"></svg>', {name: id, nodes: [{id, fills: [], strokes: []}], texts: [], effects: [], imageCount, compSize}); },
    images(id, reference = false, shadow = false) { callbacks.onImages(id ? [{name: id, ext: 'png', data: Buffer.from(id).toString('base64'), z: 3, reference, hidden: reference, external: shadow, shadowBase: shadow ? {data:'clean'} : null}] : []); },
    abort(message){callbacks.onAbort(message);},
    finish() { assert.equal(active, 1); active--; pending.shift()('OK'); }
  });
}
module.exports={harness};
if(require.main===module){
const h = harness();
h.start('A', 1); h.start('B', 0);
assert.equal(h.native.length, 0, 'Wait for images before touching AE');
h.images('A'); assert.deepEqual(h.native.map(n => n.id), ['A']);
h.start('C', 1); h.images('C');
assert.equal(h.native.length, 1, 'Later jobs stay queued during the native import');
h.finish(); assert.deepEqual(h.native.map(n => n.id), ['A', 'B']);
h.finish(); assert.deepEqual(h.native.map(n => n.id), ['A', 'B', 'C']);
assert.notEqual(h.native[0].file, h.native[1].file, 'Frozen timestamps must not overwrite queued metadata');
assert.notEqual(h.native[0].job.nodesPath, h.native[1].job.nodesPath);
assert.equal(h.native[0].job.compId, 101);
assert.equal(h.native[0].job.name, 'A', 'The frame name travels to AE so the import folders carry it');
assert.equal(JSON.parse(fs.readFileSync(h.native[2].job.imagesPath, 'utf8'))[0].name, 'C');
h.finish();
const newFrame = harness({activeCompId: 0});
const frameSize = {width: 810.25, height: 432};
newFrame.start('new frame', 1, frameSize);
assert.equal(newFrame.native.length, 0, 'Wait for the image before creating a composition');
newFrame.images('frame artwork');
assert.deepEqual(newFrame.native[0].job.compSize, frameSize);
assert.equal(newFrame.native[0].job.compId, undefined);
newFrame.finish();
const canceled = harness({rememberFolder: false});
canceled.start('cancel images', 1, frameSize); canceled.images('image'); canceled.start('next', 0);
assert.equal(canceled.native.length, 0, 'A folder picker is outside the native transaction');
canceled.pickers.shift()('');
assert.equal(canceled.native.length,1);assert.equal(canceled.native[0].id,'next');canceled.finish();
assert.ok(canceled.messages.some(m=>/已取消导入/.test(m)));
const failed = harness({failImages: true});
failed.start('disk failure', 1); failed.start('after failure', 0); failed.images('image');
assert.deepEqual(failed.native.map(n => n.id), ['after failure']);
assert.ok(failed.messages.some(m => /图片保存失败/.test(m))); failed.finish();
const empty = harness(); empty.start('all PNGs failed', 2); empty.images();
assert.equal(empty.native.length,0);assert.ok(empty.messages.some(m=>/图片数据不完整/.test(m)));
empty.start('after incomplete batch',0);assert.equal(empty.native.length,1);empty.finish();
const aborted=harness();aborted.start('aborted PNG',1);aborted.start('after aborted PNG',0);
aborted.abort('图片「broken」导出失败');assert.equal(aborted.native.length,1);assert.equal(aborted.native[0].id,'after aborted PNG');aborted.finish();
const reference = harness();reference.start('reference job',1);reference.images('original PNG',true);
const savedReference=JSON.parse(fs.readFileSync(reference.native[0].job.imagesPath,'utf8'))[0];
assert.equal(savedReference.reference,true);assert.equal(savedReference.hidden,true);reference.finish();
console.log('PASS: complete payload, single evalScript, FIFO jobs, no phase overlap, unique files, picker cancellation, disk failure, empty batch');
(async()=>{
  let resolveShadow;
  const h=harness({shadowRenderer:{renderShadow(){return new Promise(resolve=>{resolveShadow=resolve;});}}});
  h.start('shadow',1);h.images('full render',false,true);h.start('next',0);
  await Promise.resolve();assert.equal(h.native.length,0,'Wait for the shadow PNG before importing any part of this job');
  resolveShadow(Buffer.from('shadow only').toString('base64'));
  await new Promise(setImmediate);assert.equal(h.native.length,1);
  const im=JSON.parse(fs.readFileSync(h.native[0].job.imagesPath,'utf8'))[0];
  assert.equal(im.external,true);assert.equal(fs.readFileSync(path.join(h.native[0].job.imageFolder,im.file),'utf8'),'shadow only');
  h.finish();assert.equal(h.native.length,2);h.finish();
  const bad=harness({shadowRenderer:{renderShadow(){return Promise.reject(new Error('forced decode failure'));}}});
  bad.start('bad shadow',1);bad.images('bad render',false,true);bad.start('after shadow failure',0);
  await new Promise(setImmediate);assert.deepEqual(bad.native.map(n=>n.id),['after shadow failure']);
  assert.ok(bad.messages.some(m=>/投影图片处理失败/.test(m)));bad.finish();
  console.log('PASS: asynchronous shadow extraction finishes before the single AE import and preserves FIFO ordering');
})().catch(e=>{console.error(e);process.exitCode=1;});
}
