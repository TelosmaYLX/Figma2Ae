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
      duration: z.number().positive().max(10800).optional().describe('Override the Figma panel composition duration in seconds.'),
      frameRate: z.number().min(1).max(999).optional().describe('Override the Figma panel composition frame rate.'),
      preserveImageFilters: z.boolean().optional().describe('Override the panel option to keep editable image-fill color adjustments.'),
    },
    annotations: { destructiveHint: false, readOnlyHint: false },
  }, async ({ destination, textMode, aeVersion, duration, frameRate, preserveImageFilters }, { signal }) => {
    try {
      const entry = path.join(__dirname, '..', 'scripts', 'export-aep.cjs');
      if (!existsSync(entry)) throw new Error('缺少 AEP 导出组件，请重新安装 F2A');
      const { publishAep } = require(entry);
      const packet = await send('f2a_export_aep', { textMode, aeVersion, duration, frameRate, preserveImageFilters }, signal);
      if (preserveImageFilters && !(packet as {preserveImageFilters?: boolean})?.preserveImageFilters)
        throw new Error('当前 Figma 插件未启用图片调色导出，请重新运行新版 F2A。');
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
