'use strict';

module.exports = function aeFilename(name, fallback, maxLength) {
  // AE interprets ASCII percent signs in native paths. Windows reserves the other characters.
  var base = String(name || fallback).replace(/[<>:"/\\|?*%\x00-\x1f]/g, '_').slice(0, maxLength)
    .replace(/[\uD800-\uDBFF]$/, '').replace(/[. ]+$/, '') || fallback;
  return /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³]) *(?:\.|$)/i.test(base) ? '_' + base : base;
};
