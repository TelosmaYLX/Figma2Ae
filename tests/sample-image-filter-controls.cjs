'use strict';

// Capture one Figma image adjustment at a time, using the public F2A MCP tools.
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const mcpRequire = require('node:module').createRequire(path.resolve(__dirname, '../mcp/package.json'));
const {Client} = mcpRequire('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport} = mcpRequire('@modelcontextprotocol/sdk/client/stdio.js');

async function main() {
  const [image, destination, positions, channel] = process.argv.slice(2);
  if (!image || !destination) {
    throw Error('Usage: node tests/sample-image-filter-controls.cjs chart.png new-directory [percentages] [F2A channel]');
  }
  const values = positions ? positions.split(',').map(Number) : Array.from({length:41}, (_, i) => i * 5 - 100);
  if (!values.every(v => Number.isFinite(v) && Math.abs(v) <= 100)) throw Error('Use percentages from -100 to 100.');
  const source = path.resolve(image);
  const dir = path.resolve(destination);
  await fs.access(source);
  await fs.mkdir(dir);
  const keys = ['exposure','contrast','saturation','temperature','tint','highlights','shadows'];
  const neutral = Object.fromEntries(keys.map(k => [k, 0]));
  const client = new Client({name:'F2A single-control calibration',version:'1.0.0'});
  async function call(name, args = {}) {
    const result = await client.callTool({name, arguments:args});
    if (result.isError) throw Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  }
  let node;
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,
      args:[path.resolve(__dirname, '../mcp/server.cjs')], stderr:'pipe'}));
    const {sessions} = await call('get_f2a_status');
    if (!channel && sessions.length !== 1) throw Error('Open F2A in one document or specify its channel.');
    await call('join_channel', {channel:channel || sessions[0].id});
    const selection = (await call('get_selection')).selection;
    const bounds = selection.length ? (await call('get_node_info', {nodeId:selection[0].id})).absoluteBoundingBox : null;
    node = (await call('import_image', {name:'F2A 调色采样（临时）', path:source,
      x:bounds ? Math.ceil(bounds.x + bounds.width) + 16 : 0, y:bounds ? Math.floor(bounds.y) : 0})).nodeId;
    async function capture(name, filters) {
      const result = await call('set_design_image_fill', {nodeId:node, filters});
      if (!keys.every(k => Number.isFinite(result.filters?.[k]) && Math.abs(result.filters[k] - filters[k]) < 1e-5)) {
        throw Error('Unexpected filter readback for ' + name);
      }
      const outDir = path.join(dir, name);
      const {saved} = await call('save_screenshots', {nodeIds:[node], outDir});
      const reference = path.join(outDir, 'reference.png');
      await fs.rename(saved[0].path, reference);
      return reference;
    }
    let ready = false;
    for (let i = 0; i < 5; i++) {
      const png = await capture('neutral', neutral);
      const check = execFileSync(process.env.PYTHON || 'python',
        [path.join(__dirname, 'image-filter-calibration.py'), 'neutral', source, png], {encoding:'utf8'});
      if (check.trim() === 'ok') { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (!ready) throw Error('The neutral render did not match the calibration image.');
    for (const key of keys) {
      for (const value of new Set(values)) {
        if (value !== 0) await capture(key + value, {...neutral, [key]:value / 100});
      }
    }
  } finally {
    try { if (node) await call('delete_nodes', {nodeIds:[node]}); }
    finally { await client.close(); }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
