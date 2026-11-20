import {z} from 'zod';

import {setImageFillTool} from '../vendor/figwright/packages/mcp/src/tools/set-image-fill.js';
import type {SandboxToolHandler} from '../vendor/figwright/packages/plugin/src/dispatcher.js';
import {writePaints} from '../vendor/figwright/packages/plugin/src/handlers/paints.js';
import {isRuntimeSpent, runtimeSpentError} from '../vendor/figwright/packages/plugin/src/runtime-ids.js';

const adjustment = z.number().min(-1).max(1).optional();
const imageFilterSchema = z.object({
  exposure: adjustment,
  contrast: adjustment,
  saturation: adjustment,
  temperature: adjustment,
  tint: adjustment,
  highlights: adjustment,
  shadows: adjustment,
}).strict();

export const setDesignImageFillTool = {
  ...setImageFillTool,
  description: 'Replace an image fill or edit its color adjustments on a frame, shape or text layer. ' +
    'Use one of path, data or url to place an image. Omit the image source to edit filters on an existing IMAGE fill. ' +
    'Index 0 is the bottom fill. The default targets the topmost IMAGE fill, or adds one if an image source is provided. ' +
    'The crop and other adjustments are kept by default. Setting fills unlinks a fill style.',
  inputSchema: setImageFillTool.inputSchema.extend({
    filters: imageFilterSchema.optional().describe('Figma image adjustments from -1 to 1. Only supplied fields change. Set a field to 0 to reset it.'),
  }),
};

// Paths arrive as data after server resolution; the bridge adds a command id.
const sandboxArgs = setDesignImageFillTool.inputSchema.omit({path: true}).extend({
  commandId: z.string().optional(),
}).strict();

function imagePaint(previous: Paint | undefined, hash: string, mode: ImagePaint['scaleMode'] | undefined): ImagePaint {
  if (previous?.type === 'IMAGE') {
    if (mode === undefined || mode === previous.scaleMode) return {...previous, imageHash: hash};
    const {imageTransform: _transform, scalingFactor: _scale, ...paint} = previous;
    return {...paint, imageHash: hash, scaleMode: mode};
  }
  const paint: ImagePaint = {type: 'IMAGE', imageHash: hash, scaleMode: mode ?? 'FILL'};
  return {...paint,
    ...(previous?.visible !== undefined && {visible: previous.visible}),
    ...(previous?.opacity !== undefined && {opacity: previous.opacity}),
    ...(previous?.blendMode !== undefined && {blendMode: previous.blendMode}),
  };
}

export const createSetDesignImageFillHandler = (figmaCtx: typeof figma): SandboxToolHandler => async raw => {
  const {nodeId, index, data, url, scaleMode, filters} = sandboxArgs.parse(raw);
  const replace = data !== undefined || url !== undefined;
  if (data !== undefined && url !== undefined) throw new Error('Provide one image source.');
  if (!replace && (!filters || Object.keys(filters).length === 0)) {
    throw new Error('Provide an image source or at least one filter value.');
  }

  const node = await figmaCtx.getNodeByIdAsync(nodeId as string);
  if (!node || !('fills' in node)) throw new Error(`Node ${nodeId} not found or cannot have fills.`);
  const fills = node.fills;
  if (fills === figmaCtx.mixed) throw new Error(`Node ${nodeId} uses different fills across its text ranges.`);
  if (index !== undefined && (index as number) >= fills.length) {
    throw new Error(`Node ${nodeId} has ${fills.length} fills. Index ${index} is out of range.`);
  }
  const topImage = fills.map(paint => paint.type).lastIndexOf('IMAGE');
  const at = (index as number | undefined) ?? (topImage < 0 ? fills.length : topImage);
  const previous = fills[at];

  let image;
  if (replace) {
    if (isRuntimeSpent()) throw runtimeSpentError('set_design_image_fill', 'create the image');
    image = data !== undefined
      ? figmaCtx.createImage(figmaCtx.base64Decode(data as string))
      : await figmaCtx.createImageAsync(url as string);
  } else {
    if (previous?.type !== 'IMAGE') throw new Error(`Fill ${at} of ${nodeId} must be an image fill.`);
    image = previous.imageHash && figmaCtx.getImageByHash(previous.imageHash);
    if (!image) throw new Error(`Image data is missing for fill ${at} of ${nodeId}.`);
  }

  const {hash} = image;
  const {width, height} = await image.getSizeAsync();
  const paint = imagePaint(previous, hash, scaleMode as ImagePaint['scaleMode'] | undefined);
  const next = [...fills];
  next[at] = filters ? {...paint, filters: {...paint.filters, ...filters}} : paint;
  await writePaints(node, 'fills', next);

  const written = (node.fills as readonly Paint[])[at];
  if (written?.type !== 'IMAGE' || written.imageHash !== hash) {
    throw new Error(`Figma did not keep the image in fill ${at} of ${nodeId}.`);
  }
  return {ok: true, nodeId: node.id, index: at, imageHash: hash, width, height,
    ...(filters && {filters: written.filters ?? {}})};
};
