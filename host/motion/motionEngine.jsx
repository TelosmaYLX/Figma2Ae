/*
 * motionEngine.jsx — Standalone ExtendScript motion engine for the F2A AE panel.
 * Loaded into AE's persistent ExtendScript engine alongside aeMotionPresets.jsx.
 * Zero dependency on Surehand / aemcp. ES3-safe across all After Effects versions.
 *
 * Exposes globals called from client/motionPanel.js:
 *   mkMotionGetSelectionInfo()         -> JSON string
 *   mkMotionApplyClip(jobPath)         -> JSON string
 *   mkMotionApplyPreset(jobPath)       -> JSON string
 *   mkMotionCaptureSelected(jobPath)   -> JSON string
 *   mkMotionImportTemplate(jobPath)    -> JSON string
 *   mkMotionResetSelected()            -> JSON string
 */

// ---- Minimal ES3 JSON polyfill (needed by both motionEngine and aeMotionPresets) ----
if (typeof JSON === "undefined") {
  var JSON = {};
}
if (typeof JSON.parse !== "function") {
  JSON.parse = function (text) {
    return eval("(" + String(text) + ")");
  };
}
if (typeof JSON.stringify !== "function") {
  JSON.stringify = (function () {
    var escRe = /[\\\"\u0000-\u001f\u2028\u2029]/g;
    var escMap = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r", '"': '\\"', "\\": "\\\\" };
    function quote(s) {
      return '"' + String(s).replace(escRe, function (c) {
        if (escMap[c]) return escMap[c];
        var hex = c.charCodeAt(0).toString(16);
        return "\\u" + ("0000" + hex).slice(-4);
      }) + '"';
    }
    function str(val) {
      if (val === null || val === undefined) return "null";
      var t = typeof val;
      if (t === "boolean") return val ? "true" : "false";
      if (t === "number") return isFinite(val) ? String(val) : "null";
      if (t === "string") return quote(val);
      if (val instanceof Array || Object.prototype.toString.call(val) === "[object Array]") {
        var arr = [], i;
        for (i = 0; i < val.length; i++) arr.push(val[i] === undefined ? "null" : str(val[i]));
        return "[" + arr.join(",") + "]";
      }
      var pairs = [], k;
      for (k in val) {
        if (val.hasOwnProperty && !val.hasOwnProperty(k)) continue;
        if (val[k] === undefined || typeof val[k] === "function") continue;
        pairs.push(quote(k) + ":" + str(val[k]));
      }
      return "{" + pairs.join(",") + "}";
    }
    return str;
  })();
}

// ---- Core helpers ----
function _mkMotionReadJson(pathStr) {
  if (!pathStr) return null;
  var f = new File(File.encode(pathStr));
  if (!f.exists) f = new File(pathStr);
  if (!f.exists) throw new Error("找不到任务文件：" + pathStr);
  f.encoding = "UTF-8";
  if (!f.open("r")) throw new Error("无法读取任务文件：" + f.error);
  var txt = f.read();
  f.close();
  if (txt && txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
  return JSON.parse(txt);
}

function _mkMotionWriteJson(pathStr, obj) {
  var f = new File(File.encode(pathStr));
  f.encoding = "UTF-8";
  if (!f.open("w")) {
    f = new File(pathStr);
    f.encoding = "UTF-8";
    if (!f.open("w")) throw new Error("无法写入快照文件：" + f.error);
  }
  try {
    if (!f.write(JSON.stringify(obj))) throw new Error("写入快照失败：" + f.error);
  } finally {
    f.close();
  }
}

var _MK_UNDO_OPEN = false;

function _mkBeginUndo(name) {
  if (_MK_UNDO_OPEN) {
    try { app.endUndoGroup(); } catch (e0) {}
    _MK_UNDO_OPEN = false;
  }
  app.beginUndoGroup(name);
  _MK_UNDO_OPEN = true;
}

function _mkEndUndo() {
  if (_MK_UNDO_OPEN) {
    _MK_UNDO_OPEN = false;
    try { app.endUndoGroup(); } catch (e1) {}
  }
}

function _mkMotionOk(data) {
  data.ok = true;
  return JSON.stringify(data);
}

function _mkMotionErr(e) {
  var msg = "";
  if (e && e.aem && e.message) msg = e.message + (e.hint ? "（" + e.hint + "）" : "");
  else if (e && e.message) msg = e.message;
  else msg = String(e);
  return JSON.stringify({ ok: false, error: msg });
}

function _mkMotionFindComp(compId) {
  if (!app.project) throw new Error("请先在 After Effects 中打开工程。");
  if (compId) {
    var it = app.project.itemByID(compId);
    if (!it || !(it instanceof CompItem)) throw new Error("未找到指定合成 #" + compId);
    return it;
  }
  var active = app.project.activeItem;
  if (!active || !(active instanceof CompItem)) throw new Error("请先在时间轴打开一个合成。");
  return active;
}

function _mkMotionLayerKind(layer) {
  try {
    if (layer instanceof TextLayer) return "text";
    if (layer instanceof ShapeLayer) return "shape";
    if (layer instanceof CameraLayer) return "camera";
    if (layer instanceof LightLayer) return "light";
    if (layer.nullLayer) return "null";
    if (layer.source && layer.source instanceof CompItem) return "precomp";
  } catch (e) {}
  return "av";
}

function _mkMotionLayerHasTransformKeys(layer) {
  try {
    var tf = layer.property("ADBE Transform Group");
    if (!tf) return false;
    var i, p;
    for (i = 1; i <= tf.numProperties; i++) {
      p = tf.property(i);
      if (p && p.propertyType === PropertyType.PROPERTY) {
        if (p.numKeys > 0) return true;
        if (p.canSetExpression && p.expression) return true;
      }
    }
  } catch (e) {}
  return false;
}

function _mkMotionEnumValueType(valType) {
  if (valType === PropertyValueType.OneD) return "OneD";
  if (valType === PropertyValueType.TwoD) return "TwoD";
  if (valType === PropertyValueType.ThreeD) return "ThreeD";
  if (valType === PropertyValueType.TwoD_SPATIAL) return "TwoD_SPATIAL";
  if (valType === PropertyValueType.ThreeD_SPATIAL) return "ThreeD_SPATIAL";
  if (valType === PropertyValueType.COLOR) return "COLOR";
  if (valType === PropertyValueType.SHAPE) return "SHAPE";
  return "OTHER";
}

function _mkMotionEnumInterp(interpType) {
  if (interpType === KeyframeInterpolationType.BEZIER) return "bezier";
  if (interpType === KeyframeInterpolationType.HOLD) return "hold";
  return "linear";
}

function _mkMotionParseInterp(name) {
  var s = String(name || "linear").toLowerCase();
  if (s === "bezier") return KeyframeInterpolationType.BEZIER;
  if (s === "hold") return KeyframeInterpolationType.HOLD;
  return KeyframeInterpolationType.LINEAR;
}

function _mkMotionCopyArr(v) {
  if (v instanceof Array) {
    var o = [], i;
    for (i = 0; i < v.length; i++) o.push(v[i]);
    return o;
  }
  return v;
}

function _mkMotionFitVector(value, sample) {
  if (!(sample instanceof Array)) return value;
  if (!(value instanceof Array)) return sample;
  if (value.length === sample.length) return _mkMotionCopyArr(value);
  if (value.length > sample.length) return value.slice(0, sample.length);
  var out = _mkMotionCopyArr(value), i;
  for (i = value.length; i < sample.length; i++) out.push(sample[i]);
  return out;
}

var _MK_MOTION_ROOTS = [
  "ADBE Transform Group", "ADBE Effect Parade", "ADBE Mask Parade",
  "ADBE Root Vectors Group", "ADBE Text Properties", "ADBE Camera Options Group",
  "ADBE Light Options Group", "ADBE Material Options Group", "ADBE Audio Group", "ADBE Time Remapping"
];

var _MK_VALUE_TYPES = {
  OneD: true, TwoD: true, ThreeD: true, TwoD_SPATIAL: true,
  ThreeD_SPATIAL: true, COLOR: true, SHAPE: true
};

var _MK_FEATHER_FIELDS = [
  "featherSegLocs", "featherRelSegLocs", "featherRadii", "featherInterps",
  "featherTensions", "featherTypes", "featherRelCornerAngles"
];

function _mkMotionPathLabel(path) {
  var parts = [], i;
  for (i = 0; i < path.length; i++) parts.push(path[i][0] + (path[i][1] === 1 ? "" : " #" + path[i][1]));
  return parts.join(" / ");
}

function _mkMotionPackValue(value, type) {
  if (type !== "SHAPE") return _mkMotionCopyArr(value);
  var shape = {
    vertices: value.vertices,
    inTangents: value.inTangents,
    outTangents: value.outTangents,
    closed: value.closed
  };
  var i, field;
  for (i = 0; i < _MK_FEATHER_FIELDS.length; i++) {
    field = _MK_FEATHER_FIELDS[i];
    if (value[field] && value[field].length) shape[field] = value[field];
  }
  return shape;
}

function _mkMotionBuildShape(source) {
  var shape = new Shape();
  shape.vertices = source.vertices;
  if (source.inTangents) shape.inTangents = source.inTangents;
  if (source.outTangents) shape.outTangents = source.outTangents;
  shape.closed = !!source.closed;
  var i, field;
  for (i = 0; i < _MK_FEATHER_FIELDS.length; i++) {
    field = _MK_FEATHER_FIELDS[i];
    if (source[field]) shape[field] = source[field];
  }
  return shape;
}

function _mkMotionEasesToArr(easeArr) {
  var out = [], i;
  for (i = 0; i < easeArr.length; i++) {
    out.push({ speed: easeArr[i].speed, influence: easeArr[i].influence });
  }
  return out;
}

function _mkMotionPackKey(prop, index, type) {
  var inI = prop.keyInInterpolationType(index);
  var outI = prop.keyOutInterpolationType(index);
  var data = {
    time: prop.keyTime(index),
    value: _mkMotionPackValue(prop.keyValue(index), type),
    inInterp: _mkMotionEnumInterp(inI),
    outInterp: _mkMotionEnumInterp(outI)
  };
  if (inI === KeyframeInterpolationType.BEZIER || outI === KeyframeInterpolationType.BEZIER) {
    try {
      data.inEase = _mkMotionEasesToArr(prop.keyInTemporalEase(index));
      data.outEase = _mkMotionEasesToArr(prop.keyOutTemporalEase(index));
    } catch (e1) {}
  }
  try {
    data.temporalContinuous = prop.keyTemporalContinuous(index);
    data.temporalAutoBezier = prop.keyTemporalAutoBezier(index);
  } catch (e2) {}
  if (type === "TwoD_SPATIAL" || type === "ThreeD_SPATIAL") {
    try {
      data.inTangent = _mkMotionCopyArr(prop.keyInSpatialTangent(index));
      data.outTangent = _mkMotionCopyArr(prop.keyOutSpatialTangent(index));
      data.spatialContinuous = prop.keySpatialContinuous(index);
      data.spatialAutoBezier = prop.keySpatialAutoBezier(index);
      data.roving = prop.keyRoving(index);
    } catch (e3) {}
  }
  try {
    if (prop.keyLabel) data.label = prop.keyLabel(index);
  } catch (e4) {}
  return data;
}

function _mkMotionResolveTrack(layer, path) {
  var group = layer, i, j, match, occ, p, found, cand;
  for (i = 0; i < path.length; i++) {
    match = path[i][0];
    occ = path[i][1];
    p = null;
    if (occ === 1) {
      try { p = group.property(match); } catch (e) { p = null; }
    }
    if (!p || p.matchName !== match) {
      p = null;
      found = 0;
      for (j = 1; j <= group.numProperties; j++) {
        cand = group.property(j);
        if (cand.matchName === match && ++found === occ) { p = cand; break; }
      }
    }
    if (!p) throw new Error("图层「" + layer.name + "」缺少属性：" + _mkMotionPathLabel(path));
    group = p;
  }
  return group;
}

function _mkMotionIsPosition(track) {
  return track.path.length === 2 && track.path[0][0] === "ADBE Transform Group" &&
    /^ADBE Position(_[012])?$/.test(track.path[1][0]);
}

function _mkMotionIsScale(track) {
  return track.path.length === 2 && track.path[0][0] === "ADBE Transform Group" &&
    track.path[1][0] === "ADBE Scale";
}

function _mkMotionIsRotation(track) {
  return track.path.length === 2 && track.path[0][0] === "ADBE Transform Group" &&
    (track.path[1][0] === "ADBE Rotate Z" || track.path[1][0] === "ADBE Rotation");
}

function _mkMotionRetimeExpr(code, origin, stretch, start) {
  return code.replace(/^(\/\/ ae-motion spring\r?\nvar S=)(\[[^\r\n]*\]);/, function (line, prefix, json) {
    var segments, i;
    try { segments = JSON.parse(json); } catch (e) { return line; }
    for (i = 0; i < segments.length; i++) segments[i][0] = start + (segments[i][0] - origin) * stretch;
    return prefix + JSON.stringify(segments) + ";";
  });
}

function _mkMotionMakeEases(data, count, stretch) {
  var result = [], i, ease;
  for (i = 0; i < count; i++) {
    ease = data[Math.min(i, data.length - 1)];
    result.push(new KeyframeEase((ease.speed || 0) / stretch, Math.max(0.1, Math.min(100, ease.influence || 33.33))));
  }
  return result;
}

function _mkMotionExpandSeparatedPosition(layer, track) {
  // If clip has combined ADBE Position but target layer separated dimensions, split into X/Y tracks.
  if (track.path.length !== 2 || track.path[0][0] !== "ADBE Transform Group" || track.path[1][0] !== "ADBE Position") {
    return [track];
  }
  var posProp = _mkMotionResolveTrack(layer, track.path);
  if (!posProp.isSeparationLeader || !posProp.dimensionsSeparated) return [track];
  var axes = posProp.propertyValueType === PropertyValueType.TwoD_SPATIAL ? 2 : 3;
  var out = [], ax, i, k, nk, changed;
  for (ax = 0; ax < Math.min(axes, 2); ax++) {
    var follower = posProp.getSeparationFollower(ax);
    var keys = [];
    changed = false;
    for (i = 0; i < track.keys.length; i++) {
      k = track.keys[i];
      var v = (k.value instanceof Array && k.value.length > ax) ? k.value[ax] : 0;
      if (i > 0 && Math.abs(v - keys[0].value) > 0.01) changed = true;
      nk = {
        time: k.time,
        value: v,
        inInterp: k.inInterp,
        outInterp: k.outInterp
      };
      if (k.inEase) nk.inEase = [{ speed: 0, influence: k.inEase[0].influence }];
      if (k.outEase) nk.outEase = [{ speed: 0, influence: k.outEase[0].influence }];
      keys.push(nk);
    }
    if (changed || !track.keys.length) {
      var tr = { path: [["ADBE Transform Group", 1], [follower.matchName, 1]], type: "OneD", keys: keys };
      if (!keys.length && track.value instanceof Array) tr.value = track.value[ax];
      if (track.positionReference instanceof Array) tr.positionReference = track.positionReference[ax];
      out.push(tr);
    }
  }
  return out.length ? out : [track];
}

function _mkMotionTargetValue(type, source, sample, translate, scaleFactor) {
  if (type === "SHAPE") return _mkMotionBuildShape(source);
  if (typeof source === "number") return source + (translate || 0);
  var value = _mkMotionFitVector(source, sample);
  var i, res = [];
  if (scaleFactor) {
    for (i = 0; i < value.length; i++) res.push(value[i] * scaleFactor[i]);
    return res;
  }
  if (!translate) return value;
  for (i = 0; i < value.length; i++) res.push(value[i] + translate[i]);
  return res;
}

function _mkMotionPlacement(prop, track, type, options, start) {
  var keys = track.keys, first = keys[0], last = keys[keys.length - 1];
  var anchorMode = options.position_anchor || "end";
  var stretch = options.time_scale || 1;
  var relativePos = anchorMode !== "absolute" && _mkMotionIsPosition(track);
  var relativeRot = anchorMode !== "absolute" && _mkMotionIsRotation(track);
  var relativeScale = options.scale_relative !== false && anchorMode !== "absolute" && _mkMotionIsScale(track);
  var anchor = anchorMode === "start" ? first : last;
  var sampleTime = start + ((relativePos || relativeRot || relativeScale) && anchor ? anchor.time * stretch : 0);
  var sample = _mkMotionCopyArr(prop.valueAtTime(sampleTime, true));
  var translate = null;
  var scaleFactor = null;
  var i, ref;

  if (relativePos || relativeRot) {
    ref = anchor ? anchor.value : (track.positionReference === undefined ? track.value : track.positionReference);
    if (typeof ref === "number") {
      translate = sample - ref;
    } else if (ref instanceof Array && sample instanceof Array) {
      ref = _mkMotionFitVector(ref, sample);
      translate = [];
      for (i = 0; i < sample.length; i++) translate.push(sample[i] - ref[i]);
    }
  } else if (relativeScale && sample instanceof Array && keys.length) {
    ref = anchor ? anchor.value : [100, 100, 100];
    if (ref instanceof Array) {
      ref = _mkMotionFitVector(ref, sample);
      scaleFactor = [];
      for (i = 0; i < sample.length; i++) {
        var denom = Math.abs(ref[i]) > 10 ? ref[i] : 100;
        scaleFactor.push(sample[i] / denom);
      }
    }
  }
  return { prop: prop, track: track, type: type, sample: sample, translate: translate, scaleFactor: scaleFactor, start: start };
}

function _mkMotionApplyTrack(edit, options, origin) {
  var prop = edit.prop, track = edit.track, stretch = options.time_scale || 1, start = edit.start;
  if (options.replaceTracks === true) {
    while (prop.numKeys > 0) prop.removeKey(prop.numKeys);
    if (prop.canSetExpression && prop.expression) prop.expression = "";
  }
  var keys = track.keys, i, j, k, data, r;
  if (!keys.length) {
    prop.setValue(_mkMotionTargetValue(edit.type, track.value, edit.sample, edit.translate, edit.scaleFactor));
  }
  for (i = 0; i < keys.length; i++) {
    k = keys[i];
    prop.setValueAtTime(start + k.time * stretch, _mkMotionTargetValue(edit.type, k.value, edit.sample, edit.translate, edit.scaleFactor));
  }
  // Look up key indices by time so non-replace mode doesn't clobber unrelated keys
  var keyIndices = [];
  for (i = 0; i < keys.length; i++) {
    keyIndices.push(prop.nearestKeyIndex(start + keys[i].time * stretch));
  }
  for (j = 0; j < keys.length; j++) {
    var idx = keyIndices[j];
    data = keys[j];
    var inInterp = _mkMotionParseInterp(data.inInterp);
    var outInterp = _mkMotionParseInterp(data.outInterp);
    var hasBezier = data.inInterp === "bezier" || data.outInterp === "bezier";
    if (hasBezier && data.inEase && data.inEase.length && data.outEase && data.outEase.length) {
      try {
        var dims = prop.keyInTemporalEase(idx).length;
        prop.setTemporalEaseAtKey(idx, _mkMotionMakeEases(data.inEase, dims, stretch), _mkMotionMakeEases(data.outEase, dims, stretch));
      } catch (eEase) {}
    }
    prop.setInterpolationTypeAtKey(idx, inInterp, outInterp);
    if (data.inInterp === "bezier" && data.outInterp === "bezier") {
      try {
        if (data.temporalContinuous !== undefined) prop.setTemporalContinuousAtKey(idx, data.temporalContinuous);
        if (data.temporalAutoBezier !== undefined) prop.setTemporalAutoBezierAtKey(idx, data.temporalAutoBezier);
      } catch (eTc) {}
    }
    if (data.inTangent && data.outTangent && (edit.type === "TwoD_SPATIAL" || edit.type === "ThreeD_SPATIAL")) {
      try {
        var destTan = prop.keyInSpatialTangent(idx);
        prop.setSpatialTangentsAtKey(idx, _mkMotionFitVector(data.inTangent, destTan), _mkMotionFitVector(data.outTangent, destTan));
        if (data.spatialContinuous !== undefined) prop.setSpatialContinuousAtKey(idx, data.spatialContinuous);
        if (data.spatialAutoBezier !== undefined) prop.setSpatialAutoBezierAtKey(idx, data.spatialAutoBezier);
      } catch (eSp) {}
    }
    if (data.label !== undefined && prop.setLabelAtKey) {
      try { prop.setLabelAtKey(idx, data.label); } catch (eLb) {}
    }
  }
  for (r = 1; r < keys.length - 1; r++) {
    if (keys[r].roving) {
      try { prop.setRovingAtKey(keyIndices[r], true); } catch (eRv) {}
    }
  }
  if (track.expression) {
    prop.expression = _mkMotionRetimeExpr(track.expression.code, origin || 0, stretch, start);
    prop.expressionEnabled = track.expression.enabled;
    if (track.expression.enabled && prop.expressionError) {
      throw new Error(_mkMotionPathLabel(track.path) + ": " + prop.expressionError);
    }
  }
}

// =========================================================================
// PUBLIC API CALLED FROM CEP PANEL
// =========================================================================

function mkMotionGetSelectionInfo() {
  try {
    if (!app.project) return _mkMotionOk({ hasComp: false, selected: [] });
    var comp = app.project.activeItem;
    if (!comp || !(comp instanceof CompItem)) return _mkMotionOk({ hasComp: false, selected: [] });
    var sel = comp.selectedLayers.slice(0);
    sel.sort(function (a, b) { return a.index - b.index; });
    var list = [], i, l;
    for (i = 0; i < sel.length; i++) {
      l = sel[i];
      list.push({
        id: l.id,
        index: l.index,
        name: l.name,
        type: _mkMotionLayerKind(l),
        locked: !!l.locked,
        hasKeys: _mkMotionLayerHasTransformKeys(l)
      });
    }
    return _mkMotionOk({
      hasComp: true,
      compId: comp.id,
      compName: comp.name,
      width: comp.width,
      height: comp.height,
      frameRate: comp.frameRate,
      duration: comp.duration,
      time: comp.time,
      selected: list
    });
  } catch (e) {
    return _mkMotionErr(e);
  }
}

function mkMotionApplyClip(jobPath) {
  try {
    var job = _mkMotionReadJson(jobPath);
    var comp = _mkMotionFindComp(job.comp_id);
    var targets = comp.selectedLayers.slice(0);
    targets.sort(function (a, b) { return a.index - b.index; });
    if (job.order === "reverse") targets.reverse();
    if (!targets.length) throw new Error("请先在时间轴中选中至少一个图层。");

    var clip = job.clip;
    if (!clip || !clip.layers || !clip.layers.length) throw new Error("动效数据为空。");
    if (clip.layers.length !== 1 && targets.length !== clip.layers.length) {
      throw new Error("该组合动效包含 " + clip.layers.length + " 层，请选中对应数量的图层。");
    }

    var baseStart = (job.time === undefined || job.time === null) ? comp.time : Number(job.time);
    var stretch = Number(job.time_scale) > 0 ? Number(job.time_scale) : 1;
    var stagger = Number(job.stagger) > 0 ? Number(job.stagger) : 0;
    var lastStart = baseStart + (clip.layers.length === 1 ? (targets.length - 1) * stagger : 0);
    if (baseStart < 0) baseStart = 0;
    if (lastStart + clip.duration * stretch > comp.duration + 0.002) {
      throw new Error("当前播放头距离合成末尾太近，放不下该动效（需 " + (Math.round(clip.duration * stretch * 100) / 100) + "s）。");
    }

    var options = {
      time_scale: stretch,
      position_anchor: job.position_anchor || "end",
      scale_relative: job.scale_relative !== false,
      replaceTracks: job.replaceTracks !== false
    };

    var edits = [], i, j, k;
    for (i = 0; i < targets.length; i++) {
      var layer = targets[i];
      if (layer.locked) throw new Error("图层「" + layer.name + "」已锁定，请先解锁。");
      var layerTracks = clip.layers[clip.layers.length === 1 ? 0 : i].tracks;
      var layerStart = baseStart + (clip.layers.length === 1 ? i * stagger : 0);
      for (j = 0; j < layerTracks.length; j++) {
        var expanded = _mkMotionExpandSeparatedPosition(layer, layerTracks[j]);
        for (k = 0; k < expanded.length; k++) {
          var tr = expanded[k];
          var prop = _mkMotionResolveTrack(layer, tr.path);
          var type = _mkMotionEnumValueType(prop.propertyValueType);
          if (prop.propertyType !== PropertyType.PROPERTY || type !== tr.type) {
            throw new Error("图层「" + layer.name + "」属性不兼容：" + _mkMotionPathLabel(tr.path));
          }
          if (!options.replaceTracks) {
            var ex = prop.canSetExpression ? prop.expression : "";
            if (prop.numKeys > 0 || ex) {
              throw new Error("图层「" + layer.name + "」已有关键帧，请勾选“覆盖关键帧”后重试。");
            }
          }
          edits.push(_mkMotionPlacement(prop, tr, type, options, layerStart));
        }
      }
    }

    _mkBeginUndo("F2A 动效：" + (job.name || "Clip"));
    try {
      for (i = 0; i < edits.length; i++) {
        _mkMotionApplyTrack(edits[i], options, clip.origin || 0);
      }
    } finally {
      _mkEndUndo();
    }

    return _mkMotionOk({
      layers: targets.length,
      tracks: edits.length,
      time: baseStart,
      duration: clip.duration * stretch
    });
  } catch (e) {
    return _mkMotionErr(e);
  }
}

function mkMotionApplyPreset(jobPath) {
  try {
    if (typeof C === "undefined") throw new Error("AE Motion 预设引擎未加载。");
    var job = _mkMotionReadJson(jobPath);
    var comp = _mkMotionFindComp(job.comp_id);
    var cmd = job.command;
    var opts = job.options || {};
    var sel = comp.selectedLayers.slice(0);
    sel.sort(function (a, b) { return a.index - b.index; });

    _mkBeginUndo("F2A 动效：" + (job.name || cmd));
    var out;
    try {
      if (cmd === "animate") {
        if (!sel.length) throw new Error("请先在时间轴中选中至少一个图层。");
        var ids = [], i;
        for (i = 0; i < sel.length; i++) {
          if (sel[i].locked) throw new Error("图层「" + sel[i].name + "」已锁定，请先解锁。");
          ids.push(sel[i].id);
        }
        opts.layer_ids = ids;
        if (opts.time === undefined || opts.time === null) opts.time = comp.time;
        // Clear conflicting transform keys when replaceTracks is true so switching presets feels clean
        if (job.replaceTracks === true) {
          var move = opts.move || "fade";
          var clearProps = ["ADBE Opacity"];
          if (move === "pop" || move === "grow" || move === "push" || move === "spin") clearProps.push("ADBE Scale");
          if (move === "slide" || move === "drop" || move === "drift") clearProps.push("ADBE Position");
          if (move === "spin") clearProps.push("ADBE Rotate Z");
          for (i = 0; i < sel.length; i++) {
            var tf = sel[i].property("ADBE Transform Group");
            if (!tf) continue;
            for (var c = 0; c < clearProps.length; c++) {
              var pr = tf.property(clearProps[c]);
              if (pr && pr.propertyType === PropertyType.PROPERTY) {
                while (pr.numKeys > 0) pr.removeKey(pr.numKeys);
                if (pr.canSetExpression && pr.expression) pr.expression = "";
              }
            }
          }
        }
        out = C.animate(opts);
        out.layers = sel.length;
      } else if (cmd === "text_reveal") {
        var textLayers = [];
        for (var ti = 0; ti < sel.length; ti++) {
          if (sel[ti] instanceof TextLayer) textLayers.push(sel[ti]);
        }
        if (!textLayers.length) throw new Error("文字揭示需要选中至少一个原生文字图层（TextLayer）。");
        var baseT = (opts.time === undefined || opts.time === null) ? comp.time : opts.time;
        var layerStagger = Number(job.layerStagger) || 0;
        var results = [];
        for (var j = 0; j < textLayers.length; j++) {
          var o2 = {};
          for (var k in opts) if (opts.hasOwnProperty(k)) o2[k] = opts[k];
          o2.layer_id = textLayers[j].id;
          o2.time = baseT + j * layerStagger;
          results.push(C.text_reveal(o2));
        }
        out = { layers: textLayers.length, reveals: results };
      } else if (cmd === "transition") {
        opts.comp_id = comp.id;
        var d = Number(opts.duration) > 0 ? Number(opts.duration) : 0.8;
        var cut = (opts.time === undefined || opts.time === null) ? comp.time : Number(opts.time);
        if (cut < d / 2) cut = d / 2;
        if (cut + d / 2 > comp.duration) cut = Math.max(d / 2, comp.duration - d / 2);
        opts.time = cut;
        out = C.transition(opts);
      } else if (cmd === "stagger") {
        if (sel.length < 2) throw new Error("错峰交错需要至少选中 2 个带关键帧的图层。");
        var off = Number(opts.offset_seconds);
        if (!off) throw new Error("请设置大于 0 的错峰间隔时间。");
        var sIds = [];
        for (var si = 0; si < sel.length; si++) sIds.push(sel[si].id);
        var paths = opts.path ? [opts.path] : ["position", "x_position", "y_position", "scale", "rotation", "opacity", "anchor"];
        var shifted = 0;
        for (var pi = 0; pi < paths.length; pi++) {
          try {
            C.stagger({ layer_ids: sIds, path: paths[pi], offset_seconds: off, order: opts.order || "forward" });
            shifted++;
          } catch (eSkip) {}
        }
        if (!shifted) throw new Error("选中的图层没有共同的关键帧属性可以错峰交错。");
        out = { layers: sel.length, properties: shifted, offset: off };
      } else {
        throw new Error("未知的预设命令：" + cmd);
      }
    } finally {
      _mkEndUndo();
    }

    return _mkMotionOk({ result: out });
  } catch (e) {
    return _mkMotionErr(e);
  }
}

function _mkMotionCollect(prop, path, includeStatic, layerRow) {
  var i, child, part;
  if (prop.propertyType !== PropertyType.PROPERTY) {
    var occ = {};
    for (i = 1; i <= prop.numProperties; i++) {
      child = prop.property(i);
      part = child.matchName;
      occ[part] = (occ[part] || 0) + 1;
      if (child.propertyType === PropertyType.PROPERTY && child.isSeparationFollower) continue;
      _mkMotionCollect(child, path.concat([[part, occ[part]]]), includeStatic, layerRow);
    }
    return;
  }
  if (prop.isSeparationLeader && prop.dimensionsSeparated) {
    var axes = prop.propertyValueType === PropertyValueType.TwoD_SPATIAL ? 2 : 3;
    for (i = 0; i < axes; i++) {
      child = prop.getSeparationFollower(i);
      _mkMotionCollect(child, path.slice(0, -1).concat([[child.matchName, 1]]), includeStatic, layerRow);
    }
    return;
  }
  var keys = prop.numKeys;
  var expression = prop.canSetExpression ? prop.expression : "";
  if (!keys && !expression && (!includeStatic || !prop.canVaryOverTime)) return;
  var type = _mkMotionEnumValueType(prop.propertyValueType);
  if (!_MK_VALUE_TYPES[type]) {
    if (keys || expression) layerRow.omitted.push(_mkMotionPathLabel(path));
    return;
  }
  var track = { path: path, type: type, keys: [] };
  for (i = 1; i <= keys; i++) track.keys.push(_mkMotionPackKey(prop, i, type));
  if (!keys) track.value = _mkMotionPackValue(prop.valueAtTime(0, true), type);
  if (expression) track.expression = { code: expression, enabled: prop.expressionEnabled };
  layerRow.tracks.push(track);
}

function mkMotionCaptureSelected(jobPath) {
  try {
    var job = _mkMotionReadJson(jobPath);
    var comp = _mkMotionFindComp(job.comp_id);
    var layers = [], i, j;
    if (job.layer_ids && job.layer_ids.length) {
      for (i = 0; i < job.layer_ids.length; i++) {
        var l = app.project.layerByID(job.layer_ids[i]);
        if (!l || l.containingComp.id !== comp.id) throw new Error("原图层已不存在于合成中。");
        layers.push(l);
      }
    } else {
      layers = comp.selectedLayers.slice(0);
      layers.sort(function (a, b) { return a.index - b.index; });
    }
    if (!layers.length) throw new Error("请先在时间轴中选中至少一个图层。");

    var out = [];
    var maxRoots = job.scope === "transform" ? 1 : _MK_MOTION_ROOTS.length;
    for (i = 0; i < layers.length; i++) {
      var layer = layers[i];
      var row = { id: layer.id, name: layer.name, tracks: [], omitted: [] };
      for (j = 0; j < maxRoots; j++) {
        var p = layer.property(_MK_MOTION_ROOTS[j]);
        if (p) _mkMotionCollect(p, [[_MK_MOTION_ROOTS[j], 1]], !!job.includeStatic, row);
      }
      out.push(row);
    }

    var projectFile = app.project.file;
    var snapshot = {
      project: projectFile ? projectFile.fsName : null,
      revision: app.project.revision,
      comp: comp.id,
      name: comp.name,
      layers: out
    };
    _mkMotionWriteJson(job.snapshotFile, snapshot);
    return _mkMotionOk({ comp: comp.id, name: comp.name, layers: out.length });
  } catch (e) {
    return _mkMotionErr(e);
  }
}

function _mkMotionFindOrCreateFolder(name) {
  var i, it;
  for (i = 1; i <= app.project.numItems; i++) {
    it = app.project.item(i);
    if (it instanceof FolderItem && it.name === name && it.parentFolder === app.project.rootFolder) return it;
  }
  return app.project.items.addFolder(name);
}

function _mkMotionCollectCompsInItem(item, list) {
  if (item instanceof CompItem) {
    list.push(item);
  } else if (item instanceof FolderItem) {
    for (var i = 1; i <= item.numItems; i++) _mkMotionCollectCompsInItem(item.item(i), list);
  }
}

function mkMotionImportTemplate(jobPath) {
  try {
    var job = _mkMotionReadJson(jobPath);
    var comp = _mkMotionFindComp(job.comp_id);
    var filePath = job.file;
    if (!filePath) throw new Error("缺少模板文件路径。");
    var file = new File(File.encode(filePath));
    if (!file.exists) file = new File(filePath);
    if (!file.exists) throw new Error("找不到文件：" + filePath);

    if (job.kind === "ffx") {
      var sel = comp.selectedLayers.slice(0);
      if (!sel.length) throw new Error("请先选中至少一个图层以应用 FFX 预设。");
      var i;
      for (i = 0; i < sel.length; i++) {
        if (sel[i].locked) throw new Error("图层「" + sel[i].name + "」已锁定。");
      }
      _mkBeginUndo("F2A FFX：" + (job.name || file.name));
      try {
        // layer.applyPreset() applies to all selected layers at once; call once when all targets are selected
        sel[0].applyPreset(file);
      } finally {
        _mkEndUndo();
      }
      return _mkMotionOk({ kind: "ffx", layers: sel.length, name: job.name || file.name });
    }

    // AEP import (used for Titles Factory .aep, Special Titles.aep, and extracted .mogrt .aep).
    // IMPORTANT: app.project.importFile() flushes AE's active undo stack, so NEVER call it inside
    // beginUndoGroup/endUndoGroup (doing so triggers AE's "Undo group mismatch" dialog).
    var io = new ImportOptions(file);
    if (io.canImportAs(ImportAsType.PROJECT)) io.importAs = ImportAsType.PROJECT;
    var imported = app.project.importFile(io);

    var comps = [];
    _mkMotionCollectCompsInItem(imported, comps);
    if (!comps.length) throw new Error("该工程中未找到可导入的合成。");

    var chosenComp = null;
    var wanted = String(job.compName || "").replace(/^\s+|\s+$/g, "").toLowerCase();
    var ci;
    if (wanted) {
      for (ci = 0; ci < comps.length; ci++) {
        var cn = String(comps[ci].name || "").replace(/^\s+|\s+$/g, "").toLowerCase();
        if (cn === wanted) { chosenComp = comps[ci]; break; }
      }
      if (!chosenComp) {
        for (ci = 0; ci < comps.length; ci++) {
          var cn2 = String(comps[ci].name || "").replace(/^\s+|\s+$/g, "").toLowerCase();
          if (cn2.indexOf(wanted) !== -1) { chosenComp = comps[ci]; break; }
        }
      }
    }
    if (!chosenComp) {
      var base = file.name.replace(/\.aep$/i, "").toLowerCase();
      for (ci = 0; ci < comps.length; ci++) {
        var cname = String(comps[ci].name || "").replace(/^\s+|\s+$/g, "").toLowerCase();
        if (cname === base || cname.indexOf(base) === 0) { chosenComp = comps[ci]; break; }
      }
    }
    if (!chosenComp) chosenComp = comps[0];

    var addedLayer = null;
    _mkBeginUndo("F2A 模板：" + (job.name || file.name));
    try {
      var container = _mkMotionFindOrCreateFolder("F2A 模板库");
      if (imported && imported.parentFolder !== container) {
        try { imported.parentFolder = container; } catch (eMv) {}
      }
      addedLayer = comp.layers.add(chosenComp);
      addedLayer.startTime = comp.time;
      if (job.fitToComp !== false && chosenComp.width > 0 && chosenComp.height > 0 &&
          (chosenComp.width !== comp.width || chosenComp.height !== comp.height)) {
        var fitScale = Math.min(comp.width / chosenComp.width, comp.height / chosenComp.height) * 100;
        addedLayer.property("ADBE Transform Group").property("ADBE Scale").setValue([fitScale, fitScale, 100]);
      }
    } finally {
      _mkEndUndo();
    }

    return _mkMotionOk({
      kind: "aep",
      compName: chosenComp ? chosenComp.name : "",
      layerName: addedLayer ? addedLayer.name : "",
      layerIndex: addedLayer ? addedLayer.index : 0
    });
  } catch (e) {
    return _mkMotionErr(e);
  }
}

function mkMotionResetSelected() {
  try {
    var comp = _mkMotionFindComp();
    var sel = comp.selectedLayers.slice(0);
    if (!sel.length) throw new Error("请先在时间轴中选中至少一个图层。");
    var cleared = 0;
    _mkBeginUndo("F2A 重置选中图层动效");
    try {
      for (var i = 0; i < sel.length; i++) {
        if (sel[i].locked) continue;
        var tf = sel[i].property("ADBE Transform Group");
        if (!tf) continue;
        for (var j = 1; j <= tf.numProperties; j++) {
          var p = tf.property(j);
          if (!p || p.propertyType !== PropertyType.PROPERTY) continue;
          if (p.isSeparationLeader && p.dimensionsSeparated) continue;
          var had = p.numKeys > 0 || (p.canSetExpression && p.expression);
          if (!had) continue;
          var cur = null;
          try { cur = p.valueAtTime(comp.time, true); } catch (eV) {}
          while (p.numKeys > 0) p.removeKey(p.numKeys);
          if (p.canSetExpression && p.expression) p.expression = "";
          if (cur !== null) {
            try { p.setValue(cur); } catch (eS) {}
          }
          cleared++;
        }
        // Also remove any F2A / Reveal text animators on TextLayer
        if (sel[i] instanceof TextLayer) {
          var anims = sel[i].property("ADBE Text Properties").property("ADBE Text Animators");
          if (anims) {
            for (var ai = anims.numProperties; ai >= 1; ai--) {
              var an = anims.property(ai);
              if (an && /^Reveal \(/.test(an.name)) { an.remove(); cleared++; }
            }
          }
        }
      }
    } finally {
      _mkEndUndo();
    }
    return _mkMotionOk({ layers: sel.length, cleared: cleared });
  } catch (e) {
    return _mkMotionErr(e);
  }
}
