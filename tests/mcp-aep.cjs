'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {once} = require('node:events');
const path = require('node:path');
const {connectPlugin, mcpClient, result} = require('./mcp.cjs');
const {mockFigma} = require('./export-options.cjs');
const {fixtureScene, mockFixturePng} = require('./direct-aep.cjs');
const {start} = require('../mcp/relay.cjs');

async function connectFixture(port) {
  const scene = fixtureScene();
  const {figma: exportMock} = mockFigma(scene);
  mockFixturePng(scene);
  const plugin = await connectPlugin(port, 'F2A selection fixture', ({figma, page}) => {
    for (const method of ['createFrame', 'group', 'loadFontAsync', 'base64Encode']) figma[method] = exportMock[method];
    page.appendChild(scene);
    page.selection = [scene];
  });
  return {plugin, scene};
}

async function check() {
  const root = path.resolve(__dirname, '..');
  const artifacts = path.join(root, 'artifacts');
  await fs.mkdir(artifacts, {recursive: true});
  const output = await fs.mkdtemp(path.join(artifacts, 'mcp-aep-'));
  const relay = start({port: 0});
  let receivedParts = 0;
  relay.sockets.on('connection', socket => socket.on('message', data => {
    if (JSON.parse(data).type === 'aep-part') receivedParts++;
  }));
  await once(relay.server, 'listening');
  const port = relay.server.address().port;
  const client = mcpClient(path.join(root, 'mcp/server.cjs'), port);
  let plugin;
  try {
    const fixture = await connectFixture(port);
    plugin = fixture.plugin;
    const page = plugin.figma.currentPage;
    await client.init();
    plugin.elements['text-mode'].value = 'vector';
    const destination = path.join(output, '本地工程.aep');
    const args = {destination, textMode: 'editable', aeVersion: '25.0'};

    page.selection = [];
    const empty = await client.tool('export_aep', args);
    assert.equal(empty.isError, true);
    assert.match(empty.content[0].text, /至少选择/);
    assert.deepEqual(await fs.readdir(output), []);
    page.selection = [fixture.scene];

    const project = JSON.parse(result(await client.tool('export_aep', args)));
    assert.equal(project.composition, fixture.scene.name);
    assert.ok(Number.isInteger(project.compositionId) && project.compositionId > 0);
    assert.equal(project.project, path.join(output, '本地工程', '本地工程.aep'));
    assert.equal(project.counts.texts, 1);
    assert.ok(project.counts.shapes >= 3);
    assert.equal(project.counts.images, 2);
    assert.equal((await fs.readdir(path.join(project.directory, 'Assets'))).length, 2);
    const report = JSON.parse(await fs.readFile(path.join(project.directory, 'report.json'), 'utf8'));
    assert.equal(report.aeVersion, '25.0');
    const original = await fs.readFile(project.project);
    assert.equal(original.subarray(0, 4).toString(), 'RIFX');

    const second = JSON.parse(result(await client.tool('export_aep', args)));
    assert.equal(second.project, path.join(output, '本地工程 (2)', '本地工程 (2).aep'));
    assert.deepEqual(await fs.readFile(project.project), original);
    assert.equal(page.selection.length, 1);
    assert.equal(page.selection[0], fixture.scene);
    assert.equal(page.children.length, 1);
    assert.ok(receivedParts >= 2);
    console.log('PASS: Figma selection to editable AEP through MCP, including raster assets and version selection, no picker and no overwrite');
  } finally {
    if (plugin) await plugin.close();
    await client.close();
    relay.server.closeAllConnections();
    await new Promise(resolve => relay.server.close(resolve));
  }
}

if (require.main === module) check().catch(error => {console.error(error); process.exitCode = 1;});
module.exports = {connectFixture};
