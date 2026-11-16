'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {pathToFileURL} = require('node:url');
const assert = require('node:assert/strict');

async function install(name = 'f2a', command = process.execPath) {
  if (name.toLowerCase() === 'figma') throw new Error('Use f2a for F2A. The existing figma MCP must be kept separate.');
  const root = path.resolve(__dirname,'..');
  const configuredHome = process.env.DSH_HOME || path.join(os.homedir(),'.dsh');
  const home = path.resolve(configuredHome.replace(/^~(?=$|[\\/])/,os.homedir()));
  const profile = path.join(home,'profiles/desktop');
  // Reuse the installed DSH MCP manager's parser and atomic, locked entry editor.
  const modulePath = path.join(profile,'node_modules/dsh-skill-mcp-panel/lib/patch-editor.js');
  await fs.access(modulePath).catch(() => {throw new Error('DSH Desktop 的 dsh-skill-mcp-panel 未安装');});
  const editor = await import(pathToFileURL(modulePath).href);
  const file = path.join(profile,'cordis.patch.yml');
  const original = await editor.readPatchFile(file);
  const rows = editor.listMcpPatchRows(original);
  const matches = rows.filter(row => row.config?.serverName === name);
  if (matches.length > 1) throw new Error('DSH Desktop 中有多个同名 MCP：' + name);
  const previous = matches[0];
  const updated = {...previous, id:previous?.id || 'f2a-' + name + '-mcp', name:editor.MCP_PLUGIN_NAME,
    config:{...previous?.config, serverName:name, transport:'stdio', command,
      args:[path.join(root,'mcp/server.cjs')], cwd:root,
      toolCallTimeoutMs:previous?.config?.toolCallTimeoutMs || 120000}};
  delete updated.disabled;
  const backupDirectory = path.join(home,'backups/f2a');
  await fs.mkdir(backupDirectory,{recursive:true});
  const backup = path.join(backupDirectory,'desktop-cordis-' + new Date().toISOString().replace(/[:.]/g,'-') + '.yml');
  await fs.writeFile(backup,original,{flag:'wx'});
  if (previous) {
    await editor.replaceMcpEntryWithRow(file,{serverName:name,entryId:previous.id},updated);
  } else {
    const managed = editor.readManagedBlock(original);
    await editor.writeManagedRows(file,[...managed.managed,updated]);
  }
  const actual = editor.listMcpPatchRows(await editor.readPatchFile(file));
  assert.deepEqual(actual.filter(row=>row.config?.serverName!==name),rows.filter(row=>row.config?.serverName!==name),'Other MCP entries changed');
  assert.deepEqual(actual.find(row=>row.config?.serverName===name),updated);
  console.log(JSON.stringify({client:'DSH Desktop',server:name,entryId:updated.id,command,args:updated.config.args,
    timeoutMs:updated.config.toolCallTimeoutMs,config:file,backup,otherServersUnchanged:true}));
}

install(process.argv[2],process.argv[3]).catch(error=>{console.error(error.message);process.exitCode=1;});
