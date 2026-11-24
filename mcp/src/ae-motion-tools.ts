import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { registerSurehandTools } from './surehand-tools';
import { z } from 'zod';

const layerId = z.number().int().positive().describe('AE layer ID from ae_get_comp_info, not the timeline index.');
const compId = z.number().int().positive().describe('AE composition item ID.');
const changeScope = compId.optional().describe('Composition containing the layers, for the change report.');
const time = z.number().min(0);
const direction = z.enum(['up', 'down', 'left', 'right']);
const phase = z.enum(['in', 'out']);
const curve = z.enum(['snappy', 'smooth', 'spring', 'bounce', 'linear']);
// The closed-form easings used by text reveals, including the React Bits vocabulary
// (power/expo/back/wave) distilled in host/motion/aeMotionPresets.jsx.
const textEase = z.enum([
  'snappy', 'smooth', 'accelerate', 'linear', 'spring', 'bounce',
  'power2Out', 'power3Out', 'power4Out', 'power2InOut', 'expoOut', 'backOut', 'backInOut', 'wave',
]);
const textStyle = z.enum(['rise', 'drop', 'fade', 'pop', 'blur', 'typewriter', 'skewIn', 'riseBlur', 'focus', 'zoomIn', 'wave', 'float']);
const order = z.enum(['forward', 'reverse']);

export function registerAeMotionTools(server: McpServer, call: ReturnType<typeof registerSurehandTools>, jsx: string) {
  function preset(command: 'animate' | 'stagger' | 'text_reveal' | 'transition', description: string, inputSchema: z.ZodRawShape) {
    server.registerTool('ae_' + command, {
      description,
      inputSchema,
      annotations: {readOnlyHint: false, destructiveHint: command !== 'transition'},
    }, (options, { signal }) => call('ae_batch', {
      name: 'AE Motion: ' + command.replace('_', ' '),
      atomic: true,
      verbose: true,
      steps: [{tool: 'ae_run_script', args: {comp: options.comp_id, code: jsx, args: {command, options}}}],
    }, signal));
  }

  preset('animate', 'Apply editable AE Motion moves to layers in the same composition. Use seconds for time, duration and stagger. Spring and bounce use expressions on editable keys.', {
    layer_ids: z.array(layerId).min(1),
    comp_id: changeScope,
    move: z.enum(['fade', 'pop', 'grow', 'slide', 'drop', 'spin', 'push', 'drift']),
    phase: phase.optional(),
    time: time.optional(),
    duration: z.number().positive().optional(),
    amount: z.number().positive().max(50).optional().describe('Scale change in percent for push.'),
    style: curve.optional(),
    direction: direction.optional(),
    distance: z.number().positive().optional(),
    stagger: time.optional(),
    order: order.optional(),
  });

  preset('stagger', 'Shift existing keys of one property across layers, preserving interpolation and spatial tangents.', {
    layer_ids: z.array(layerId).min(2),
    comp_id: changeScope,
    path: z.union([z.string(), z.array(z.union([z.string(), z.number()])).min(1)])
      .describe('AE Motion alias such as position or opacity, or an array of AE match names and indices.'),
    offset_seconds: z.number(),
    order: order.optional(),
  });

  preset('text_reveal', 'Reveal or hide native AE text by characters, words, or lines. For Figma selection export use export_aep with textMode "editable".', {
    layer_id: layerId,
    comp_id: changeScope,
    style: textStyle.optional(),
    by: z.enum(['chars', 'words', 'lines']).optional(),
    phase: phase.optional(),
    time: time.optional(),
    duration: time.optional(),
    stagger: time.optional(),
    ease: textEase.optional(),
    order: z.enum(['forward', 'reverse', 'center', 'random']).optional(),
    direction: direction.optional().describe('Travel direction of the unit; the unit starts on its opposite side.'),
    distance: z.number().positive().optional(),
    mask: z.boolean().optional(),
  });

  preset('transition', 'Add an editable wipe, bars, iris, fade, split, or shutter shape transition. Time is the cut in composition seconds, when the transition covers the frame.', {
    comp_id: compId,
    time,
    type: z.enum(['wipe', 'bars', 'iris', 'fade', 'split', 'shutter']).optional(),
    duration: z.number().positive().optional(),
    color: z.array(z.number().min(0).max(1)).min(3).max(4).optional(),
    direction: direction.optional(),
    bars: z.number().int().min(2).max(20).optional(),
    center: z.array(z.number()).length(2).optional().describe('Iris centre in composition pixels.'),
  });
}
