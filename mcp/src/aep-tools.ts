import { existsSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerAepTools(server: McpServer,
  send: (command: string, params: object, signal: AbortSignal) => Promise<unknown>) {
  server.registerTool('export_aep', {
    description: 'Export the current Figma selection to an editable AEP with its Assets and report. Open the returned project path with ae_open_project, then use compositionId to inspect the main comp. Use textMode "editable" for native AE text.',
    inputSchema: {
      destination: z.string().refine(p => path.isAbsolute(p) && /\.aep$/i.test(p), 'Supply an absolute .aep path.')
        .describe('Absolute .aep destination. F2A makes a same-named folder and numbers it if it already exists.'),
      textMode: z.enum(['editable', 'vector', 'png']).optional().describe('Override the Figma panel text mode.'),
      aeVersion: z.enum(['24.0', '25.0', '26.0']).optional().describe('Override the Figma panel AE version.'),
    },
    annotations: { destructiveHint: false, readOnlyHint: false },
  }, async ({ destination, textMode, aeVersion }, { signal }) => {
    try {
      const entry = path.join(__dirname, '..', 'scripts', 'export-aep.cjs');
      if (!existsSync(entry)) throw new Error('缺少 AEP 导出组件，请重新安装 F2A');
      const { publishAep } = require(entry);
      const packet = await send('f2a_export_aep', { textMode, aeVersion }, signal);
      const result = await publishAep(packet, () => destination, { signal });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      const failure = error as Error & {nodeId?: string};
      return { isError: true, content: [{
        type: 'text', text: failure.nodeId ? JSON.stringify({ error: failure.message, nodeId: failure.nodeId }) : failure.message,
      }] };
    }
  });
}
