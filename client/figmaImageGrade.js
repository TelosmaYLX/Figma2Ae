'use strict';

// Figma image-paint controls, in the order shown in the design and AE.
var keys = ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights', 'shadows'];
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var clamp = function (v) { return Math.max(0, Math.min(1, v)); };
var decode = function (v) { return Math.pow(v, 2.2); };

function controls(filters) {
  return keys.map(function (key) {
    var v = filters[key] == null ? 0 : filters[key];
    if (typeof v !== 'number' || !isFinite(v) || Math.abs(v) > 1) throw new Error('无效的图片调色参数 ' + key);
    return v;
  });
}

// Inputs are linear RGB. Keep the original luminance for highlights and shadows.
// The output is straight, gamma-encoded RGB. Alpha stays with the footage in AE.
function grade(r, g, b, p, out) {
  var y = .2126*r + .7152*g + .0722*b;
  var d = y - .217637640824031;
  var ev = p[0] + .75*d / Math.sqrt(1+4*d*d) * (d > 0 ? p[5] : -.999*p[6]);
  if (p[1] || p[3] || p[4]) {
    var fx = Math.cbrt((.4124564*r + .3575761*g + .1804375*b)/.95047);
    var fy = Math.cbrt(.2126729*r + .7151522*g + .0721750*b);
    var fz = Math.cbrt((.0193339*r + .1191920*g + .9503041*b)/1.08883);
    var light = 116*fy-16, t = clamp((light-20)/60);
    var target = p[1] < 0 ? (light-50)*.2+50 : 100*t*t*t*(6*t*t-15*t+10);
    var shift = .3*Math.abs(p[1])*(target-light)/116;
    var x = .95047*Math.pow(fx+shift+.06*p[4],3);
    var labY = Math.pow(fy+shift,3);
    var z = 1.08883*Math.pow(fz+shift-.15*p[3],3);
    r = clamp(3.2404542*x-1.5371385*labY-.4985314*z);
    g = clamp(-.969266*x+1.8760108*labY+.041556*z);
    b = clamp(.0556434*x-.2040259*labY+1.0572252*z);
    y = .2126*r + .7152*g + .0722*b;
  }
  if (ev) {
    var negative = Math.min(0,ev), scale = 1+negative/16, gain = Math.pow(10,2*ev);
    var chroma = 3*(1+y*y*negative/(.2-negative));
    var scaledY = scale*y, base = scaledY*gain/(1+scaledY*(gain-1));
    var rr = scale*(.25*r+.75*y), gg = scale*(.25*g+.75*y), bb = scale*(.25*b+.75*y);
    rr = rr*gain/(1+rr*(gain-1)); gg = gg*gain/(1+gg*(gain-1)); bb = bb*gain/(1+bb*(gain-1));
    r = clamp(rr+(rr-base)*chroma); g = clamp(gg+(gg-base)*chroma); b = clamp(bb+(bb-base)*chroma);
    y = .2126*r + .7152*g + .0722*b;
  }
  var sat = 1+p[2];
  if (p[2] > 0) {
    var limit = Math.min(y/(y-Math.min(r,g,b)+1e-6), (1-y)/(Math.max(r,g,b)-y+1e-6));
    sat = Math.min(2, 1+p[2]*(limit-1));
  }
  out[0] = Math.pow(clamp(y+(r-y)*sat),1/2.2);
  out[1] = Math.pow(clamp(y+(g-y)*sat),1/2.2);
  out[2] = Math.pow(clamp(y+(b-y)*sat),1/2.2);
}

function table(p, size, precision) {
  var dst = Buffer.alloc(size*size*size*3*precision), axis = [], pixel = [0,0,0], offset = 0;
  for (var i=0; i<size; ++i) axis.push(decode(i/(size-1)));
  // An ICC mAB grid stores B fastest, unlike the ordering in a .cube text file.
  for (var r=0; r<size; ++r) for (var g=0; g<size; ++g) for (var b=0; b<size; ++b) {
    grade(axis[r],axis[g],axis[b],p,pixel);
    for (var c=0; c<3; ++c) {
      if (precision === 2) { dst.writeUInt16BE(Math.round(pixel[c]*65535),offset); offset+=2; }
      else dst[offset++] = Math.round(pixel[c]*255);
    }
  }
  return dst;
}

function writeTables(directory, images) {
  var anchors = Object.create(null);
  images.forEach(function (image) {
    if (!image.imageFilters) return;
    var p = controls(image.imageFilters);
    var id = crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0,24);
    image.gradeId = id;
    anchors[id] = p;
  });
  if (!Object.keys(anchors).length) return;
  fs.mkdirSync(directory, {recursive:true});
  keys.forEach(function (key,index) {
    var p = keys.map(function () { return 0; });
    for (var percent=-100; percent<=100; percent+=10) {
      if (!percent) continue;
      p[index] = percent/100;
      fs.writeFileSync(path.join(directory,key+'_'+percent+'.lut'),table(p,24,1));
    }
  });
  Object.keys(anchors).forEach(function (id) {
    var anchor = anchors[id];
    fs.writeFileSync(path.join(directory,id+'.lut'),table(anchor,64,2));
    var radius = Math.min(.1, anchor.reduce(function (sum,v) { return sum + Math.abs(v); },0)/2);
    keys.forEach(function (key,index) {
      [-1,1].forEach(function (direction) {
        var p = anchor.slice();
        p[index] = Math.max(-1, Math.min(1, p[index] + direction*radius));
        if (p[index] !== anchor[index])
          fs.writeFileSync(path.join(directory,id+'_'+key+'_'+direction+'.lut'),table(p,32,1));
      });
    });
  });
}

function prepareImport(extension, images, folder, duration, frameRate, callback) {
  var os = require('os'), child = require('child_process');
  var graded = images.filter(function (image) { return !!image.imageFilters; });
  var root = extension;
  if (!fs.existsSync(path.join(root, 'scripts/aep/image_grade.py')) && process.env.LOCALAPPDATA)
    root = path.join(process.env.LOCALAPPDATA, 'F2A', 'AEP');
  var bundled = path.join(root, 'runtime/python/python.exe');
  var python = process.env.F2A_PYTHON || (fs.existsSync(bundled) ? bundled :
    path.join(root, '.venv-aep', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
  var temp = fs.mkdtempSync(path.join(os.tmpdir(), 'f2a-grade-'));
  function cleanup() {
    fs.readdirSync(temp).forEach(function (name) { fs.unlinkSync(path.join(temp,name)); });
    fs.rmdirSync(temp);
  }
  try {
    var jobs = graded.map(function (im) { return {source:path.join(folder,im.file), imageFilters:im.imageFilters}; });
    writeTables(temp,jobs);
    var manifest = path.join(temp,'images.json'), project = path.join(temp,'图片调色.aep');
    fs.writeFileSync(manifest, JSON.stringify({duration:duration, frameRate:frameRate, images:jobs}));
    child.execFile(python,[path.join(root,'scripts/aep/image_grade.py'),manifest,project], {windowsHide:true},
      function (error, stdout) {
        if (error) { cleanup(); callback(error.code === 'ENOENT' ? new Error('请安装 F2A 的 AEP 导出组件') : error); return; }
        try {
          var comps = JSON.parse(stdout);
          graded.forEach(function (im,index) { im.gradeComp = comps[index]; im.gradeProject = project; });
        } catch (parseError) { cleanup(); callback(parseError); return; }
        callback(null,cleanup);
      });
  } catch (error) { cleanup(); callback(error); }
}

module.exports = {controls:controls, table:table, writeTables:writeTables, prepareImport:prepareImport};
