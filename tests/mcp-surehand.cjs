'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
const {createRequire} = require('node:module');
const {start} = require('../mcp/relay.cjs');
const catalog = require('../mcp/vendor/surehand/catalog.json');
const mcpDirectory = path.resolve(__dirname, '../mcp');
const mcpRequire = createRequire(path.join(mcpDirectory, 'package.json'));
const {Client} = mcpRequire('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport} = mcpRequire('@modelcontextprotocol/sdk/client/stdio.js');

async function check() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'F2A Surehand 中文 '));
  assert.equal(path.dirname(directory), os.tmpdir());
  const relay = start({port: 0, idleTimeout: 60000});
  let jsx;
  let motion = {path: [['ADBE Transform Group', 1], ['ADBE Opacity', 1]], type: 'OneD', keys: [], value: 70};
  const bridge = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/health') {
      response.end(JSON.stringify({name: 'aemcp-bridge', version: catalog.version, host: {appVersion: '26.0'}}));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    jsx = JSON.parse(Buffer.concat(chunks).toString('utf8')).script;
    if (jsx.includes('return captureMotion(args);')) {
      const target = JSON.parse(/"snapshotFile":("(?:[^"\\]|\\.)*")/.exec(jsx)[1]);
      const snapshot = {project: 'Reference.aep', revision: 5, comp: 4, name: 'Motion reference',
        layers: [{id: 72, name: '卡片', tracks: [motion], omitted: []}]};
      await fs.writeFile(target, JSON.stringify(snapshot));
    }
    let result = {};
    if (jsx.includes('C.stagger')) result = {steps: [{ok: true, result: {move: 'fade'}}], failed: -1};
    if (jsx.includes('return applyMotion(args);')) result = {steps: [{ok: true, result: {tracks: 1}}], failed: -1};
    response.end(JSON.stringify({ok: true, result: JSON.stringify({ok: true, result, logs: []})}));
  }).listen(0, '127.0.0.1');
  const client = new Client({name: 'F2A Surehand test', version: '1'});
  const call = (name, args = {}) => client.callTool({name, arguments: args});
  const firstText = result => result.content.find(value => value.type === 'text')?.text || '';

  try {
    await Promise.all([once(relay.server, 'listening'), once(bridge, 'listening')]);
    const config = path.join(directory, 'config.json');
    await fs.writeFile(config, JSON.stringify({bridgePort: bridge.address().port, token: 'test'}));
    const entry = path.join(directory, 'server.cjs');
    await fs.copyFile(path.join(mcpDirectory, 'server.cjs'), entry);
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      cwd: directory,
      env: {
        F2A_MCP_PORT: String(relay.server.address().port),
        SUREHAND_AE_CONFIG: config,
        SUREHAND_AE_NO_AUTOSETUP: '1',
        SUREHAND_AE_NO_ACTIVITY_LOG: '1',
        F2A_MOTION_LIBRARY: path.join(directory, 'Motion Library'),
        NODE_PATH: '',
      },
    }));
    const {tools} = await client.listTools();
    assert.deepEqual(tools.filter(tool => tool.name.startsWith('ae_')).map(tool => tool.name).sort(),
      [...catalog.tools.map(tool => tool.name), 'ae_animate', 'ae_stagger', 'ae_text_reveal', 'ae_transition', 'ae_render_mp4',
        'ae_motion_record', 'ae_motion_save', 'ae_motion_list', 'ae_motion_import', 'ae_motion_apply'].sort());
    assert.ok(tools.find(tool => tool.name === 'ae_set_keyframes')?.inputSchema.required.includes('keyframes'));
    assert.equal(!!(await call('get_f2a_status')).isError, false);
    const absent = await call('ae_status');
    assert.equal(absent.isError, true);
    assert.match(firstText(absent), /Surehand 组件缺失/);
    assert.deepEqual(JSON.parse(firstText(await call('ae_motion_list'))).clips, []);

    const vendor = path.join(directory, 'vendor', 'surehand');
    await fs.mkdir(vendor, {recursive: true});
    await fs.copyFile(path.join(mcpDirectory, 'vendor', 'surehand', 'surehand-ae.mjs'), path.join(vendor, 'surehand-ae.mjs'));
    await fs.writeFile(path.join(directory, '素材.png'), 'test file');
    const [catalogResult, filesResult] = await Promise.all([
      call('ae_tools', {describe: ['ae_find_files']}),
      call('ae_call', {tool: 'ae_find_files', args: {roots: [directory], pattern: '*.png'}}),
    ]);
    assert.equal(!!catalogResult.isError, false);
    assert.equal(JSON.parse(firstText(catalogResult))[0].callDirectly, false);
    assert.equal(!!filesResult.isError, false, firstText(filesResult));
    assert.match(firstText(filesResult), /素材\.png/);

    const rendered = await call('ae_add_to_render_queue', {comp: 1, outputModuleTemplate: '中文 😀'});
    assert.equal(!!rendered.isError, false, firstText(rendered));
    assert.ok(jsx.includes('"outputModuleTemplate":"\\u4e2d\\u6587 \\ud83d\\ude00"'));
    assert.ok(!jsx.includes('中文 😀'));
    const symbolicProject = path.join(directory, "工程 # 'A&B'.aep");
    for (const name of ['ae_open_project', 'ae_save_project']) {
      const handled = await call(name, {path: symbolicProject});
      assert.equal(!!handled.isError, false, firstText(handled));
      assert.ok(jsx.includes('File.encode(args.path)') && jsx.includes(" # 'A&B'.aep"));
      assert.ok(jsx.includes('f.fsName.indexOf("%")'));
    }

    const animated = await call('ae_animate', {layer_ids: [72], move: 'fade', duration: 0.4});
    assert.equal(!!animated.isError, false, firstText(animated));
    assert.match(firstText(animated), /one undo step/);
    assert.ok(jsx.includes('"command":"animate","options":{"layer_ids":[72],"move":"fade","duration":0.4}'));

    const existingMp4 = path.join(directory, 'existing.mp4');
    await fs.writeFile(existingMp4, 'existing video');
    const collision = await call('ae_render_mp4', {comp_id: 1, outputPath: existingMp4});
    assert.equal(collision.isError, true);
    assert.match(firstText(collision), /already exists/);

    const mark = JSON.parse(firstText(await call('ae_motion_record', {comp_id: 4, layer_ids: [72]})));
    const noEdit = await call('ae_motion_save', {recording_id: mark.recording_id, name: 'No edits'});
    assert.equal(noEdit.isError, true);
    motion = {...motion, value: undefined, keys: [
      {time: 2.5, value: 40, inInterp: 'bezier', outInterp: 'bezier', inEase: [{speed: 8, influence: 61}], outEase: [{speed: 7, influence: 49}]},
      {time: 3, value: 100, inInterp: 'hold', outInterp: 'hold'},
    ]};
    const saved = JSON.parse(firstText(await call('ae_motion_save', {recording_id: mark.recording_id, name: '手调淡入', tags: ['UI']})));
    assert.equal(saved.duration, 0.5);
    const record = JSON.parse(await fs.readFile(saved.file, 'utf8'));
    assert.equal(record.clip.origin, 2.5);
    assert.deepEqual(record.clip.layers[0].tracks[0].keys.map(key => key.time), [0, 0.5]);
    assert.equal(JSON.parse(firstText(await call('ae_motion_list', {query: 'ui'}))).clips[0].id, saved.id);
    const imported = JSON.parse(firstText(await call('ae_motion_import', {file: saved.file, name: 'Imported fade'})));
    assert.equal(imported.contentHash, saved.contentHash);
    assert.notEqual(imported.id, saved.id);
    const applied = await call('ae_motion_apply', {clip_id: imported.id, comp_id: 5, layer_ids: [121]});
    assert.equal(!!applied.isError, false, firstText(applied));
    assert.match(firstText(applied), /one undo step/);
    assert.ok(jsx.includes('"layer_ids":[121]') && jsx.includes('"influence":61') && jsx.includes('"replaceTracks":false'));

    const corruptFile = path.join(directory, 'corrupt.json');
    record.clip.layers[0].tracks[0].keys[0].value = 0;
    await fs.writeFile(corruptFile, JSON.stringify(record));
    const corrupt = await call('ae_motion_import', {file: corruptFile});
    assert.equal(corrupt.isError, true);
    assert.match(firstText(corrupt), /content hash/);

    motion = {path: [['ADBE Transform Group', 1], ['ADBE Position', 1]], type: 'ThreeD_SPATIAL', keys: [], value: [56, 130, 0]};
    const staticRecording = JSON.parse(firstText(await call('ae_motion_record')));
    motion = {...motion, value: [72, 149, 0]};
    const moved = JSON.parse(firstText(await call('ae_motion_save', {recording_id: staticRecording.recording_id, name: 'Static move'})));
    const movedRecord = JSON.parse(await fs.readFile(moved.file, 'utf8'));
    assert.deepEqual(movedRecord.clip.layers[0].tracks[0].positionReference, [56, 130, 0]);

    const unavailable = await call('ae_call', {tool: 'ae_not_a_tool'});
    assert.equal(unavailable.isError, true);
    assert.match(firstText(unavailable), /Unknown tool/);
    assert.equal(!!(await call('get_f2a_status')).isError, false);
    console.log('PASS: relocated F2A, Surehand discovery, Unicode JSX, motion recording, portable library and Figma availability');
  } finally {
    await client.close();
    relay.server.closeAllConnections();
    bridge.closeAllConnections();
    await Promise.all([new Promise(resolve => relay.server.close(resolve)), new Promise(resolve => bridge.close(resolve))]);
    await fs.rm(directory, {recursive: true, force: true});
  }
}

check().catch(error => {console.error(error); process.exitCode = 1;});
