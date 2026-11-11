const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(__dirname, '../artifacts/fidelity').replaceAll('\\', '/') + '/';
for (const file of ['nodes.json', 'texts.json', 'gradients.json', 'effects.json', 'containers.json', 'images.json']) {
  if (!fs.existsSync(dir + file)) throw new Error('Full sample replay data required: ' + dir + file);
}
fs.writeFileSync(dir + 'undo-job.json', JSON.stringify({svgPath: dir + 'unused.svg', nodesPath: dir + 'nodes.json',
  textsPath: dir + 'texts.json', gradMapPath: dir + 'gradients.json', effectsPath: dir + 'effects.json',
  containersPath: dir + 'containers.json', imagesPath: dir + 'images.json', imageFolder: dir + 'assets'}));
console.log('Prepared full sample undo test');
