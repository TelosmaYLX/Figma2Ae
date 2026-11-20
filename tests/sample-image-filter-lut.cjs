'use strict';

// Sample the selected IMAGE paint with the running Figma renderer.
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const mcpRequire = require('node:module').createRequire(path.resolve(__dirname, '../mcp/package.json'));
const {Client} = mcpRequire('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport} = mcpRequire('@modelcontextprotocol/sdk/client/stdio.js');

async function main() {
  const [destination, channel] = process.argv.slice(2);
  if (!destination || path.extname(destination).toLowerCase() !== '.cube') {
    throw Error('Usage: node tests/sample-image-filter-lut.cjs output.cube [F2A channel]');
  }
  const client = new Client({name:'F2A image grade study', version:'1.0.0'});
  const server = path.resolve(__dirname, '../mcp/server.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'f2a-color-chart-'));
  const chart = path.join(dir, 'chart.png');
  const cube = path.join(dir, 'grade.cube');
  const pixels = (...args) => execFileSync(process.env.PYTHON || 'python',
    [path.join(__dirname, 'image-filter-cube.py'), ...args], {stdio:'pipe'});
  async function call(name, args = {}) {
    const result = await client.callTool({name, arguments:args});
    if (result.isError) throw Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  }
  let sample;
  try {
    pixels('chart', chart);
    await client.connect(new StdioClientTransport({command:process.execPath, args:[server], stderr:'pipe'}));
    const {sessions} = await call('get_f2a_status');
    if (!channel && sessions.length !== 1) throw Error('Open F2A in one document or pass its channel ID.');
    await call('join_channel', {channel:channel || sessions[0].id});
    const {selection} = await call('get_selection');
    if (selection.length !== 1) throw Error('Select one layer with an image fill.');
    const node = await call('get_node_info', {nodeId:selection[0].id});
    const images = (node.fills || []).filter(p => p.type === 'IMAGE' && p.visible !== false);
    if (images.length !== 1) throw Error('Select a layer with one visible image fill.');
    const filters = images[0].filters || {};
    const bounds = node.absoluteBoundingBox;
    sample = (await call('import_image', {name:'F2A LUT sample', path:chart,
      x:Math.ceil(bounds.x + bounds.width) + 16, y:Math.floor(bounds.y)})).nodeId;
    async function capture() {
      const {saved} = await call('save_screenshots', {nodeIds:[sample], outDir:dir});
      return saved[0].path;
    }
    // Newly imported images can return a transparent first frame while Figma decodes them.
    let ready = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (pixels('identity', await capture()).toString().trim() === 'ok') { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (!ready) throw Error('The neutral chart did not match the RGB input.');
    if (Object.values(filters).some(value => value !== 0)) {
      const result = await call('set_design_image_fill', {nodeId:sample, filters});
      if (!result.filters || Object.entries(filters).some(([k,v]) => Math.abs(result.filters[k] - v) > 0.00001 || result.filters[k] == null)) {
        throw Error('Figma did not retain the requested filters.');
      }
    }
    pixels('cube', await capture(), cube);
    await fs.copyFile(cube, destination, constants.COPYFILE_EXCL);
    console.log(JSON.stringify({layer:node.name, filters, cube:path.resolve(destination)}));
  } finally {
    try {
      if (sample) await call('delete_nodes', {nodeIds:[sample]});
    } finally {
      try { await client.close(); } finally { await fs.rm(dir, {recursive:true, force:true}); }
    }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
