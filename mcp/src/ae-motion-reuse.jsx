// Manual motion capture adapted from Mark v0.3.0 (see vendor/mark-ae/LICENSE).
// Use stable AE IDs for the recording and match-name paths for the reusable clip.
var roots = ["ADBE Transform Group", "ADBE Effect Parade", "ADBE Mask Parade",
  "ADBE Root Vectors Group", "ADBE Text Properties", "ADBE Camera Options Group",
  "ADBE Light Options Group", "ADBE Material Options Group", "ADBE Audio Group", "ADBE Time Remapping"];
var valueTypes = { OneD: true, TwoD: true, ThreeD: true, TwoD_SPATIAL: true,
  ThreeD_SPATIAL: true, COLOR: true, SHAPE: true };
var featherFields = ["featherSegLocs", "featherRelSegLocs", "featherRadii", "featherInterps",
  "featherTensions", "featherTypes", "featherRelCornerAngles"];

function getLayers(comp, ids) {
  var layers = [], i, layer;
  if (!ids) {
    layers = comp.selectedLayers.slice(0);
    layers.sort(function (a, b) { return a.index - b.index; });
  } else {
    for (i = 0; i < ids.length; i++) {
      layer = app.project.layerByID(ids[i]);
      if (!layer || layer.containingComp.id !== comp.id)
        throw new Error("Layer " + ids[i] + " is not in composition " + comp.name + ".");
      layers.push(layer);
    }
  }
  if (!layers.length) throw new Error("Select at least one layer in After Effects or pass its layer ID.");
  return layers;
}

function pathLabel(path) {
  var parts = [];
  for (var i = 0; i < path.length; i++) parts.push(path[i][0] + (path[i][1] === 1 ? "" : " #" + path[i][1]));
  return parts.join(" / ");
}

function packValue(value, type) {
  if (type !== "SHAPE") return value;
  var shape = { vertices: value.vertices, inTangents: value.inTangents, outTangents: value.outTangents, closed: value.closed };
  for (var i = 0; i < featherFields.length; i++) {
    var field = featherFields[i];
    if (value[field] && value[field].length) shape[field] = value[field];
  }
  return shape;
}

function easesToArr(easeArr) {
  var out = [];
  for (var i = 0; i < easeArr.length; i++) {
    out.push({ speed: easeArr[i].speed, influence: easeArr[i].influence });
  }
  return out;
}

function packKey(prop, index, type) {
  var key = aemcp.captureKey(prop, index);
  var data = { time: key.time, value: packValue(key.value, type),
    inInterp: String(aemcp.enumName(KeyframeInterpolationType, key.inInterp)).toLowerCase(),
    outInterp: String(aemcp.enumName(KeyframeInterpolationType, key.outInterp)).toLowerCase() };
  if (key.inEase) { data.inEase = easesToArr(key.inEase); data.outEase = easesToArr(key.outEase); }
  if (key.tc !== undefined) { data.temporalContinuous = key.tc; data.temporalAutoBezier = key.tab; }
  if (key.inTan) {
    data.inTangent = key.inTan; data.outTangent = key.outTan;
    data.spatialContinuous = key.sc; data.spatialAutoBezier = key.sab; data.roving = key.roving;
  }
  if (key.label !== undefined) data.label = key.label;
  return data;
}

function collect(prop, path, includeStatic, layer) {
  var i, child, part;
  if (prop.propertyType !== PropertyType.PROPERTY) {
    var occurrences = {};
    for (i = 1; i <= prop.numProperties; i++) {
      child = prop.property(i);
      part = child.matchName;
      occurrences[part] = (occurrences[part] || 0) + 1;
      if (child.propertyType === PropertyType.PROPERTY && child.isSeparationFollower) continue;
      collect(child, path.concat([[part, occurrences[part]]]), includeStatic, layer);
    }
    return;
  }
  if (prop.isSeparationLeader && prop.dimensionsSeparated) {
    var axes = prop.propertyValueType === PropertyValueType.TwoD_SPATIAL ? 2 : 3;
    for (i = 0; i < axes; i++) {
      child = prop.getSeparationFollower(i);
      collect(child, path.slice(0, -1).concat([[child.matchName, 1]]), includeStatic, layer);
    }
    return;
  }

  var keys = prop.numKeys, expression = prop.canSetExpression ? prop.expression : "";
  if (!keys && !expression && (!includeStatic || !prop.canVaryOverTime)) return;
  var type = String(aemcp.enumName(PropertyValueType, prop.propertyValueType));
  if (!valueTypes[type]) {
    if (keys || expression) layer.omitted.push(pathLabel(path));
    return;
  }

  var track = { path: path, type: type, keys: [] };
  for (i = 1; i <= keys; i++) track.keys.push(packKey(prop, i, type));
  if (!keys) track.value = packValue(prop.valueAtTime(0, true), type);
  if (expression) track.expression = { code: expression, enabled: prop.expressionEnabled };
  layer.tracks.push(track);
}

function captureMotion(options) {
  var comp = aemcp.findComp(options.comp_id), layers = getLayers(comp, options.layer_ids), out = [];
  var project = app.project.file;
  for (var i = 0; i < layers.length; i++) {
    var layer = layers[i], row = { id: layer.id, name: layer.name, tracks: [], omitted: [] };
    for (var j = 0; j < (options.scope === "transform" ? 1 : roots.length); j++) {
      var property = layer.property(roots[j]);
      if (property) collect(property, [[roots[j], 1]], options.includeStatic, row);
    }
    out.push(row);
  }
  var snapshot = { project: project ? project.fsName : null, revision: app.project.revision,
    comp: comp.id, name: comp.name, layers: out };
  var file = new File(options.snapshotFile);
  file.encoding = "UTF-8";
  if (!file.open("w")) throw new Error("Could not open the F2A motion snapshot: " + file.error);
  try {
    if (!file.write(JSON.stringify(snapshot))) throw new Error("Could not write the F2A motion snapshot: " + file.error);
  } finally { file.close(); }
  return { comp: comp.id, layers: out.length };
}

function resolveTrack(layer, path) {
  var group = layer;
  for (var i = 0; i < path.length; i++) {
    var match = path[i][0], occurrence = path[i][1], p = null;
    if (occurrence === 1) p = group.property(match);
    if (!p || p.matchName !== match) {
      p = null;
      var found = 0;
      for (var j = 1; j <= group.numProperties; j++) {
        var candidate = group.property(j);
        if (candidate.matchName === match && ++found === occurrence) { p = candidate; break; }
      }
    }
    if (!p) throw new Error(layer.name + " is missing " + pathLabel(path) + ".");
    group = p;
  }
  return group;
}

function isPosition(track) {
  return track.path.length === 2 && track.path[0][0] === roots[0] && /^ADBE Position(_[012])?$/.test(track.path[1][0]);
}

// Some 2D AEPs expose a third, unused component. Keep the dimension the destination expects.
function fitVector(value, sample) {
  if (!(sample instanceof Array) || value.length === sample.length) return value;
  if (value.length > sample.length) return value.slice(0, sample.length);
  return value.concat(sample.slice(value.length));
}

function targetValue(prop, type, source, sample, translate) {
  if (type === "SHAPE") {
    var shape = aemcp.toAEValue(prop, source);
    for (var j = 0; j < featherFields.length; j++) {
      var field = featherFields[j];
      if (source[field]) shape[field] = source[field];
    }
    return shape;
  }
  if (typeof source === "number") return source + (translate || 0);
  var value = fitVector(source, sample);
  if (!translate) return value;
  var result = [];
  for (var i = 0; i < value.length; i++) result.push(value[i] + translate[i]);
  return result;
}

function placement(prop, track, type, options, start) {
  var keys = track.keys, first = keys[0], last = keys[keys.length - 1];
  var relative = options.position_anchor !== "absolute" && isPosition(track);
  var anchor = options.position_anchor === "start" ? first : last;
  var sample = prop.valueAtTime(start + (relative && anchor ? anchor.time * options.time_scale : 0), true);
  var translate = null;
  if (relative) {
    var ref = anchor ? anchor.value : (track.positionReference === undefined ? track.value : track.positionReference);
    if (typeof ref === "number") translate = sample - ref;
    else {
      ref = fitVector(ref, sample);
      translate = [];
      for (var i = 0; i < sample.length; i++) translate.push(sample[i] - ref[i]);
    }
  }
  return { prop: prop, track: track, type: type, sample: sample, translate: translate };
}

function keyEases(data, count, stretch) {
  var result = [];
  for (var i = 0; i < count; i++) {
    var ease = data[Math.min(i, data.length - 1)];
    result.push(new KeyframeEase(ease.speed / stretch, Math.max(0.1, Math.min(100, ease.influence))));
  }
  return result;
}

function retimeExpression(code, origin, stretch, start) {
  // AE Motion labels spring segments with the source key time.
  return code.replace(/^(\/\/ ae-motion spring\r?\nvar S=)(\[[^\r\n]*\]);/, function (line, prefix, json) {
    var segments;
    try { segments = JSON.parse(json); } catch (error) { return line; }
    for (var i = 0; i < segments.length; i++) segments[i][0] = start + (segments[i][0] - origin) * stretch;
    return prefix + JSON.stringify(segments) + ";";
  });
}

function applyTrack(edit, options, start, origin) {
  var prop = edit.prop, track = edit.track, stretch = options.time_scale;
  if (options.replaceTracks === true) {
    while (prop.numKeys) prop.removeKey(prop.numKeys);
    if (prop.canSetExpression && prop.expression) prop.expression = "";
  }
  var keys = track.keys;
  if (!keys.length) prop.setValue(targetValue(prop, edit.type, track.value, edit.sample, edit.translate));
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    prop.setValueAtTime(start + key.time * stretch, targetValue(prop, edit.type, key.value, edit.sample, edit.translate));
  }
  if (prop.numKeys !== keys.length) throw new Error("After Effects merged keys on " + pathLabel(track.path) + ". Use a longer duration.");
  for (var j = 0; j < keys.length; j++) {
    var k = j + 1, data = keys[j];
    var inInterp = aemcp.interp(data.inInterp), outInterp = aemcp.interp(data.outInterp);
    var hasBezier = data.inInterp === "bezier" || data.outInterp === "bezier";
    if (hasBezier && data.inEase && data.inEase.length) {
      var dimensions = prop.keyInTemporalEase(k).length;
      prop.setTemporalEaseAtKey(k, keyEases(data.inEase, dimensions, stretch), keyEases(data.outEase, dimensions, stretch));
    }
    prop.setInterpolationTypeAtKey(k, inInterp, outInterp);
    if (data.inInterp === "bezier" && data.outInterp === "bezier") {
      if (data.temporalContinuous !== undefined) prop.setTemporalContinuousAtKey(k, data.temporalContinuous);
      if (data.temporalAutoBezier !== undefined) prop.setTemporalAutoBezierAtKey(k, data.temporalAutoBezier);
    }
    if (data.inTangent) {
      var destTangent = prop.keyInSpatialTangent(k);
      prop.setSpatialTangentsAtKey(k, fitVector(data.inTangent, destTangent), fitVector(data.outTangent, destTangent));
      prop.setSpatialContinuousAtKey(k, data.spatialContinuous);
      prop.setSpatialAutoBezierAtKey(k, data.spatialAutoBezier);
    }
    if (data.label !== undefined && prop.setLabelAtKey) prop.setLabelAtKey(k, data.label);
  }
  for (var r = 1; r < keys.length - 1; r++) if (keys[r].roving) prop.setRovingAtKey(r + 1, true);
  if (track.expression) {
    prop.expression = retimeExpression(track.expression.code, origin, stretch, start);
    prop.expressionEnabled = track.expression.enabled;
    if (track.expression.enabled && prop.expressionError)
      throw new Error(pathLabel(track.path) + ": " + prop.expressionError);
  }
}

function applyMotion(options) {
  var comp = aemcp.findComp(options.comp_id), targets = getLayers(comp, options.layer_ids);
  var clip = options.clip, start = options.time === undefined ? comp.time : options.time;
  if (clip.layers.length !== 1 && targets.length !== clip.layers.length)
    throw new Error("Select " + clip.layers.length + " matching layers, in the order listed in the motion library.");
  if (start < 0 || start + clip.duration * options.time_scale > comp.duration + 0.000001)
    throw new Error("The motion clip does not fit within the target composition at this time.");

  var edits = [], i, j;
  for (i = 0; i < targets.length; i++) {
    var layer = targets[i], tracks = clip.layers[clip.layers.length === 1 ? 0 : i].tracks;
    if (layer.locked) throw new Error("Unlock " + layer.name + " before applying the motion clip.");
    for (j = 0; j < tracks.length; j++) {
      var track = tracks[j], prop = resolveTrack(layer, track.path);
      var type = String(aemcp.enumName(PropertyValueType, prop.propertyValueType));
      var compatible = prop.propertyType === PropertyType.PROPERTY && type === track.type;
      if (prop.isSeparationLeader && prop.dimensionsSeparated) compatible = false;
      if (prop.isSeparationFollower && !prop.separationLeader.dimensionsSeparated) compatible = false;
      if (!compatible)
        throw new Error(layer.name + " has an incompatible property: " + pathLabel(track.path) + ".");
      // ExtendScript parses mixed && / || differently after transpilation.
      if (options.replaceTracks !== true) {
        var expression = prop.canSetExpression ? prop.expression : "";
        if (prop.numKeys > 0 || expression)
          throw new Error(layer.name + " already has animation on " + pathLabel(track.path) + ". Use replace:true to replace this track.");
      }
      edits.push(placement(prop, track, type, options, start));
    }
  }
  for (i = 0; i < edits.length; i++) applyTrack(edits[i], options, start, clip.origin);
  return { layers: targets.length, tracks: edits.length, time: start, duration: clip.duration * options.time_scale };
}
