// Recover the shadow behind an unchanged foreground from two Figma PNG renders.
// Both inputs use straight RGBA; solve source-over in premultiplied colour space.
function extractShadow(full, clean) {
  var out = new Uint8ClampedArray(full.length);
  for (var i = 0; i < full.length; i += 4) {
    var af = full[i + 3] / 255, ac = clean[i + 3] / 255, remaining = 1 - ac;
    if (remaining < 1 / 255 || af <= ac) continue;
    var alpha = Math.max(0, Math.min(1, (af - ac) / remaining));
    out[i + 3] = Math.round(alpha * 255);
    for (var c = 0; c < 3; c++)
      out[i + c] = Math.max(0, Math.min(255, (full[i + c] * af - clean[i + c] * ac) / (remaining * alpha)));
  }
  return out;
}
function renderShadow(full, base, document, Image) {
  function load(data) { return new Promise(function (resolve, reject) {
    var image = new Image(); image.onload = function () { resolve(image); };
    image.onerror = function () { reject(new Error('无法读取 Figma 投影图片')); };
    image.src = 'data:image/png;base64,' + data;
  }); }
  return Promise.all([load(full), load(base.data)]).then(function (images) {
    var canvas = document.createElement('canvas'), cleanCanvas = document.createElement('canvas');
    canvas.width = cleanCanvas.width = images[0].naturalWidth;
    canvas.height = cleanCanvas.height = images[0].naturalHeight;
    var context = canvas.getContext('2d'), cleanContext = cleanCanvas.getContext('2d');
    context.drawImage(images[0], 0, 0);
    cleanContext.drawImage(images[1], base.dx, base.dy, base.w, base.h);
    var pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    pixels.data.set(extractShadow(pixels.data, cleanContext.getImageData(0, 0, canvas.width, canvas.height).data));
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  });
}
module.exports = {extractShadow: extractShadow, renderShadow: renderShadow};
