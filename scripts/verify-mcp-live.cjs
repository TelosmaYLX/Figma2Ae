'use strict';

// Read-only end-to-end check against the F2A plugins currently open in Figma.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const mcpRequire = require('node:module').createRequire(path.join(__dirname,'../mcp/package.json'));
const {Client} = mcpRequire('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport} = mcpRequire('@modelcontextprotocol/sdk/client/stdio.js');
const root=path.resolve(__dirname,'..');
function value(response) {
  assert.ok(!response.isError,JSON.stringify(response));
  return JSON.parse(response.content.find(item=>item.type==='text').text);
}
async function check() {
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'mcp/server.cjs')],stderr:'pipe'});
  const client=new Client({name:'F2A live verification',version:'1.0.0'});
  try {
    await client.connect(transport);
    const {tools}=await client.listTools();
    const {sessions}=value(await client.callTool({name:'get_f2a_status',arguments:{}}));
    assert.ok(sessions.length,'Open F2A in a Figma document first.');
    const documents=[];
    for(const session of sessions) {
      value(await client.callTool({name:'join_channel',arguments:{channel:session.id}}));
      const page=value(await client.callTool({name:'get_document_info',arguments:{}}));
      const selection=value(await client.callTool({name:'get_selection',arguments:{}}));
      assert.equal(page.id,session.pageId);
      assert.equal(typeof selection.selectionCount,'number');
      documents.push({name:session.name,pageId:page.id,pageName:page.name,selectionCount:selection.selectionCount});
    }
    const report={passed:true,tools:tools.length,documents,readOnly:true,checkedAt:new Date().toISOString()};
    await fs.mkdir(path.join(root,'artifacts/mcp'),{recursive:true});
    await fs.writeFile(path.join(root,'artifacts/mcp/live-report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } finally {await client.close();}
}
check().catch(error=>{console.error(error);process.exitCode=1;});
