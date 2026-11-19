import { existsSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { registerSurehandTools } from './surehand-tools';

const prepareMp4 = String.raw`
if (!app.project.file) throw new Error('Save an editable AEP with ae_save_project first.');
var comp = app.project.itemByID(args.comp_id);
if (!(comp instanceof CompItem)) throw new Error('Composition not found: ' + args.comp_id);

var frame = comp.frameDuration;
var first = args.startFrame === undefined ? Math.round(comp.workAreaStart / frame) : args.startFrame;
var last = args.endFrame === undefined ? Math.round((comp.workAreaStart + comp.workAreaDuration) / frame) - 1 : args.endFrame;
if (last < first || last >= Math.round(comp.duration / frame)) throw new Error('The MP4 frame range must be within the composition.');

var queue = app.project.renderQueue, item = queue.items.add(comp);
try {
  var templates = item.outputModule(1).templates, h264;
  for (var i = 0; i < templates.length; i++) {
    var template = templates[i];
    if (!/H\.264/i.test(template)) continue;
    if (!h264) h264 = template;
    if (/15\s*Mbps/i.test(template)) { h264 = template; break; }
  }
  if (!h264) throw new Error('No H.264 output module template is installed.');
  item.timeSpanStart = 0;
  item.timeSpanDuration = (last - first + 1) * frame;
  item.timeSpanStart = first * frame;
  return {index: queue.numItems, template: h264};
} catch (error) {
  item.remove();
  throw error;
}`;
const queueResult = z.object({index: z.number().int().positive(), template: z.string().min(1)});

export function registerAeVideoTools(server: McpServer, call: ReturnType<typeof registerSurehandTools>) {
  server.registerTool('ae_render_mp4', {
    description: 'Render a saved AE composition to H.264 MP4 in the background. Use a composition ID, including when comp names are duplicated. Poll ae_render_jobs with the returned job ID.',
    inputSchema: {
      comp_id: z.number().int().positive().describe('Composition item ID from export_aep or ae_list_comps.'),
      outputPath: z.string().refine(p => path.isAbsolute(p) && /\.mp4$/i.test(p), 'Supply an absolute .mp4 path.'),
      startFrame: z.number().int().min(0).optional().describe('First frame, zero-based. Defaults to the work area start.'),
      endFrame: z.number().int().min(0).optional().describe('Last frame, inclusive. Defaults to the work area end.'),
    },
    annotations: {readOnlyHint: false, destructiveHint: true},
  }, async ({outputPath, ...args}, {signal}) => {
    if (existsSync(outputPath)) return {isError: true, content: [{type: 'text', text: 'MP4 already exists: ' + outputPath}]};
    const queued = await call('ae_run_script', {code: prepareMp4, args, undoGroup: 'Queue F2A MP4'}, signal);
    if (queued.isError) return queued;
    const message = queued.content.find(item => item.type === 'text')?.text;
    const {index, template} = queueResult.parse(JSON.parse(message?.split('\n', 1)[0] || '{}'));
    // aerender applies the localized template in its own process. Use the queue index for same-named comps.
    return call('ae_render_background', {rqIndex: index, output: outputPath, outputModuleTemplate: template, save: true}, signal);
  });
}
