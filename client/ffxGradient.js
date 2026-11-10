/*
 * ffxGradient.js — generate a Gradient-Fill animation preset (.ffx) with arbitrary stops.
 *
 * WHY: After Effects does not expose shape gradient colours to scripting
 * ("ADBE Vector Grad Colors" is NO_VALUE). The only way to set them — used by Overlord,
 * GradientHub, FX Gradient — is to write a temporary .ffx that already contains the gradient
 * and apply it with layer.applyPreset(). The colours live in a small XML blob inside the
 * .ffx (a RIFX container). This module patches that blob and fixes the RIFX chunk sizes.
 *
 * Runs in Node (CEP panel side). Needs a template .ffx captured once from the user's AE.
 *
 *   var buf = ffx.generate(templateBuffer, {
 *     colorStops: [ {loc:0, rgb:[0.06,0.72,0.51]}, {loc:1, rgb:[0.06,0.72,0.51]} ],
 *     alphaStops: [ {loc:0, a:0.35}, {loc:1, a:0} ]
 *   });
 *   fs.writeFileSync(path, buf);
 */

function u32(buf, o) { return buf.readUInt32BE(o); }

// Walk the RIFX tree, return the Utf8 (gradient XML) chunk + the size-field offsets of every ancestor.
function locateGradientXML(buf) {
  var ancestors = [];          // size-field offsets to bump when the XML length changes
  var found = null;

  function walk(off, end, chain) {
    while (off + 8 <= end) {
      var tag = buf.toString('latin1', off, off + 4);
      var size = u32(buf, off + 8 - 4);       // size field at off+4
      var dataOff = off + 8;
      var isList = (tag === 'RIFX' || tag === 'LIST');
      var myChain = chain.concat([off + 4]);  // this chunk's size-field offset
      if (isList) {
        // form id at dataOff (4 bytes), children after
        walk(dataOff + 4, dataOff + size, myChain);
      } else if (tag === 'Utf8' && !found) {
        // gradient XML lives in the Utf8 chunk under LIST 'GCky'
        var txt = buf.toString('utf8', dataOff, dataOff + size);
        if (txt.indexOf('Gradient Color Data') !== -1) {
          found = { dataOff: dataOff, size: size, sizeFieldOff: off + 4, ancestors: chain.slice() };
        }
      }
      off = dataOff + size + (size & 1);       // chunks pad to even
    }
  }
  // top: 'RIFX'(4) + size(4) + form 'FaFX'(4) + children
  var total = u32(buf, 4);
  walk(12, 12 + (total - 4), [4]);             // [4] = RIFX size field
  return found;
}

function f(x) {
  // format a float the way AE's exporter does: integers as "0"/"1", else trimmed decimal
  if (x === 0) return '0';
  if (x === 1) return '1';
  var s = String(x);
  return s;
}

function stopBlock(kind, idx, floats) {
  var key = (kind === 'alpha') ? 'Stops Alpha' : 'Stops Color';
  var arr = '';
  for (var i = 0; i < floats.length; i++) arr += '<float>' + f(floats[i]) + '</float>\n';
  return '<prop.pair>\n<key>Stop-' + idx + '</key>\n<prop.list>\n<prop.pair>\n<key>' + key +
    '</key>\n<array>\n<array.type><float/></array.type>\n' + arr +
    '</array>\n</prop.pair>\n</prop.list>\n</prop.pair>\n';
}

function buildGradientXML(colorStops, alphaStops) {
  var a = '', c = '', i, s;
  for (i = 0; i < alphaStops.length; i++) { s = alphaStops[i]; a += stopBlock('alpha', i, [s.loc, 0.5, s.a]); }
  for (i = 0; i < colorStops.length; i++) { s = colorStops[i]; c += stopBlock('color', i, [s.loc, 0.5, s.rgb[0], s.rgb[1], s.rgb[2], 1]); }
  return "<?xml version='1.0'?>\n<prop.map version='4'>\n<prop.list>\n<prop.pair>\n<key>Gradient Color Data</key>\n" +
    "<prop.list>\n<prop.pair>\n<key>Alpha Stops</key>\n<prop.list>\n<prop.pair>\n<key>Stops List</key>\n<prop.list>\n" +
    a +
    "</prop.list>\n</prop.pair>\n<prop.pair>\n<key>Stops Size</key>\n<int type='unsigned' size='32'>" + alphaStops.length + "</int>\n</prop.pair>\n</prop.list>\n</prop.pair>\n" +
    "<prop.pair>\n<key>Color Stops</key>\n<prop.list>\n<prop.pair>\n<key>Stops List</key>\n<prop.list>\n" +
    c +
    "</prop.list>\n</prop.pair>\n<prop.pair>\n<key>Stops Size</key>\n<int type='unsigned' size='32'>" + colorStops.length + "</int>\n</prop.pair>\n</prop.list>\n</prop.pair>\n" +
    "</prop.list>\n</prop.pair>\n<prop.pair>\n<key>Gradient Colors</key>\n<string>1.0</string>\n</prop.pair>\n</prop.list>\n</prop.map>\n";
}

function generate(templateBuf, stops) {
  var loc = locateGradientXML(templateBuf);
  if (!loc) throw new Error('gradient XML not found in template .ffx');

  var xml = buildGradientXML(stops.colorStops, stops.alphaStops);
  var newBytes = Buffer.from(xml, 'utf8');
  var newLen = newBytes.length;
  var oldLen = loc.size;
  var oldPad = oldLen & 1, newPad = newLen & 1;
  var deltaTotal = (newLen + newPad) - (oldLen + oldPad);

  var out = Buffer.alloc(templateBuf.length + deltaTotal);
  // copy everything up to the Utf8 data start
  templateBuf.copy(out, 0, 0, loc.dataOff);
  // write new XML + pad
  newBytes.copy(out, loc.dataOff);
  if (newPad) out[loc.dataOff + newLen] = 0;
  // copy the suffix after the old (padded) XML
  var oldSuffixStart = loc.dataOff + oldLen + oldPad;
  templateBuf.copy(out, loc.dataOff + newLen + newPad, oldSuffixStart);

  // fix sizes: Utf8 own size (unpadded), every ancestor size += deltaTotal
  out.writeUInt32BE(newLen, loc.sizeFieldOff);
  for (var i = 0; i < loc.ancestors.length; i++) {
    var so = loc.ancestors[i];
    out.writeUInt32BE(u32(out, so) + deltaTotal, so);
  }
  return out;
}

module.exports = { generate: generate, buildGradientXML: buildGradientXML, locateGradientXML: locateGradientXML };
