import { existsSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import catalog from '../vendor/surehand/catalog.json';

export function registerSurehandTools(server: McpServer) {
  let connection: { client: Client; ready: Promise<Client> } | undefined;

  function getClient() {
    if (connection) return connection.ready;
    const bundle = path.join(__dirname, 'vendor', 'surehand', 'surehand-ae.mjs');
    if (!existsSync(bundle)) throw new Error('Surehand 组件缺失，请重新安装 F2A');

    const client = new Client({ name: 'F2A', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle, '--tools', catalog.profile],
      // Surehand launches aerender, which needs the host's Adobe and Windows environment.
      env: { ...process.env as Record<string, string>, SUREHAND_AE_NO_UPDATE_CHECK: '1' },
    });
    const reset = () => {
      if (connection?.client === client) connection = undefined;
    };
    client.onclose = reset;
    const ready = client.connect(transport, { timeout: 15_000 }).then(() => client, async error => {
      await client.close();
      reset();
      throw new Error('Surehand 启动失败：' + error.message, { cause: error });
    });
    connection = { client, ready };
    return ready;
  }

  async function call(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    const client = await getClient();
    return client.request({ method: 'tools/call', params: { name, arguments: args } },
      CallToolResultSchema, { signal, timeout: 120_000 });
  }

  // Register the pinned tool schemas before starting Surehand so Figma-only sessions work independently.
  for (const { name, title, description, inputSchema, annotations } of catalog.tools) {
    const schema = z.fromJSONSchema(inputSchema as z.core.JSONSchema.JSONSchema);
    server.registerTool(name, { title, description, inputSchema: schema, annotations },
      (args, { signal }) => call(name, args as Record<string, unknown>, signal));
  }

  server.server.onclose = () => { void connection?.client.close(); };
  return call;
}
