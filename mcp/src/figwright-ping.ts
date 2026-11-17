import {z} from 'zod';
import type {ToolSpec} from '../vendor/figwright/packages/mcp/src/tools/spec.js';

// Figwright's original ping also probes its leader election. F2A already owns the connection.
export const pingTool: ToolSpec = {
  name: 'ping',
  description: 'Check the connected F2A document and Figma API.',
  inputSchema: z.object({}),
  kind: 'read',
};
