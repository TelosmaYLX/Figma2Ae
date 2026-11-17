// Figwright uses the existing F2A relay. No second server or plugin is needed.
import {figwrightTools} from './figwright-catalog.js';
import {normalizeIdArgs} from '../vendor/figwright/packages/mcp/src/node-id.js';
import {handleSaveScreenshots} from '../vendor/figwright/packages/mcp/src/tools/save-screenshots.js';
import {handleSaveImageFills} from '../vendor/figwright/packages/mcp/src/tools/save-image-fills.js';
import {handleExportPdf} from '../vendor/figwright/packages/mcp/src/tools/export-pdf.js';
import {handleExportVideo} from '../vendor/figwright/packages/mcp/src/tools/export-video.js';
import {resolveImagePath} from '../vendor/figwright/packages/mcp/src/tools/import-image.js';
import {screenshotContent} from '../vendor/figwright/packages/mcp/src/tools/get-screenshot.js';
import {TOOL_RESULT_LIMIT_BYTES} from './figwright-shared.js';

type Send = (name: string, args?: Record<string, unknown>) => Promise<any>;
type Dispatch = (name: string, args: unknown) => Promise<any>;
const files: Record<string, (send: Dispatch, args: unknown) => Promise<unknown>> = {
  save_screenshots: handleSaveScreenshots,
  save_image_fills: handleSaveImageFills,
  export_pdf: handleExportPdf,
  export_video: handleExportVideo,
};

async function prepare(name: string, args: Record<string, unknown>) {
  args = normalizeIdArgs(args);
  if (name === 'import_image' || name === 'set_design_image_fill') {
    args = await resolveImagePath(args, name);
  }
  return args;
}

// Also used by F2A's existing batch tool, so new writes support paths and pasted node URLs there.
export function withFigwrightArgs(send: Send): Send {
  return async (name, args = {}) => {
    if (name === 'batch' && Array.isArray(args.ops)) {
      const ops = [];
      for (const op of args.ops as any[]) {
        ops.push({...op, params: await prepare(op.tool, op.params || {})});
      }
      return send(name, {...args, ops});
    }
    return send(name, await prepare(name, args));
  };
}

export function registerFigwrightTools(server: any, send: Send) {
  const dispatch: Dispatch = (name, args) => {
    // F2A's wire format is JSON. Request base64 instead of Figwright's msgpack Uint8Array.
    const {binary, ...payload} = (args ?? {}) as Record<string, unknown>;
    return send(name, payload);
  };
  for (const {spec, name} of figwrightTools) {
    const description = name === 'get_design_context'
      ? 'Read the selected layers or nodeId as a design tree with layout, text, paints, effects, variables and component overrides. Defaults to full detail with repeated components deduplicated. Use depth or compact/minimal detail for structure; sectionPlan lists sections to read individually.'
      : spec.description;
    server.registerTool(name, {
      description,
      inputSchema: spec.inputSchema.strict(),
      annotations: {readOnlyHint: spec.kind === 'read', destructiveHint: spec.destructive === true},
    }, async (raw: Record<string, unknown>) => {
      try {
        const args = normalizeIdArgs(raw);
        if (files[name]) return json(await files[name](dispatch, args));
        if (name === 'get_screenshot') {
          return {content: screenshotContent(await dispatch(name, {...args, forVision: true}))};
        }
        const params = name === 'get_design_context'
          ? {detail: 'full', dedupeComponents: true, ...args, budget: true}
          : args;
        return json(await dispatch(name, params));
      } catch (error) {
        return {isError: true, content: [{type: 'text', text: `${name}: ${error instanceof Error ? error.message : String(error)}`}]};
      }
    });
  }
}

function json(value: unknown) {
  const response = {content: [{type: 'text' as const, text: JSON.stringify(value)}]};
  if (Buffer.byteLength(JSON.stringify(response)) > TOOL_RESULT_LIMIT_BYTES) {
    throw new Error('Result is too large. Read fewer nodes, reduce depth, or use compact detail.');
  }
  return response;
}
