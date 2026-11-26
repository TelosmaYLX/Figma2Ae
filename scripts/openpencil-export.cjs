#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { createClient } = require('../openpencil/client.cjs');
const { createRunner } = require('../openpencil/runner.cjs');
const { exportAep } = require('./export-aep.cjs');
const { exportWeb } = require('./export-web.cjs');

function printHelp() {
  console.log([
    'F2A for OpenPencil — 命令行直接导出工具',
    '',
    '用法:',
    '  node scripts/openpencil-export.cjs [选项]',
    '',
    '常用选项:',
    '  --format <type>          导出目标：aep | web | ae | packet（默认 aep）',
    '  -o, --output <path>      输出目录（aep/web）或文件路径（packet）',
    '  --document <id>          指定 OpenPencil 文档 ID（默认当前活动文档）',
    '  --page <id>              指定页面 ID（默认当前页面）',
    '  --node <id[,id2]>        指定导出的图层/画框 ID，可多次传入（默认当前选区）',
    '  --list-documents         仅列出 OpenPencil 运行状态、打开的文档与当前选区',
    '  --json                   以 JSON 格式输出结果',
    '',
    '导出参数:',
    '  --text-mode <mode>       文字模式：editable | vector | png（默认 editable）',
    '  --ae-version <ver>       AEP 目标版本（默认 26.0）',
    '  --duration <sec>         合成时长秒数（默认 10）',
    '  --fps <n>                合成帧率（默认 30）',
    '  --raster-scale <1..4>    切图倍率（默认 1）',
    '  --ae-port <n>            AE 桥接服务端口（默认 7365，仅 --format ae）',
    '  --no-organize            关闭保留分组层级（不嵌套容器预合成）',
    '  --no-precomp-layers      关闭单图层嵌套预合成',
    '  --no-clip                关闭导出裁切蒙版',
    '  --include-hidden         包含隐藏图层',
    '  --merge-blends           合并混合模式叠加栈',
    '  --merged-image-masks     图片蒙版改为合并导出（默认独立轨道遮罩）',
    '  --preserve-image-filters 保留可编辑图片调色参数',
    '  --preserve-background-blur 保留背景模糊调整图层',
    '  --raster-all-groups      所有分组转为图片',
    '  --raster-instances       所有组件实例转为图片',
    '  --no-reference           不渲染原图对照层',
    '  -h, --help               显示帮助信息',
  ].join('\n'));
}

function parseArgs(argv) {
  const opts = {
    format: 'aep',
    output: null,
    documentId: null,
    pageId: null,
    nodeIds: [],
    listDocuments: false,
    json: false,
    textMode: 'editable',
    aeVersion: '26.0',
    duration: 10,
    fps: 30,
    rasterScale: 1,
    aePort: 7365,
    organize: true,
    precompLayers: true,
    enableClip: true,
    ignoreHidden: true,
    mergeBlends: false,
    nativeImageMasks: true,
    preserveImageFilters: false,
    preserveBackgroundBlur: false,
    rasterAllGroups: false,
    rasterInstances: false,
    skipReferences: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--list-documents') opts.listDocuments = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--format' && argv[i + 1]) opts.format = String(argv[++i]).toLowerCase();
    else if ((arg === '-o' || arg === '--output') && argv[i + 1]) opts.output = argv[++i];
    else if (arg === '--document' && argv[i + 1]) opts.documentId = argv[++i];
    else if (arg === '--page' && argv[i + 1]) opts.pageId = argv[++i];
    else if (arg === '--node' && argv[i + 1]) {
      for (const part of String(argv[++i]).split(',')) {
        const trimmed = part.trim();
        if (trimmed) opts.nodeIds.push(trimmed);
      }
    }
    else if (arg === '--text-mode' && argv[i + 1]) opts.textMode = String(argv[++i]).toLowerCase();
    else if (arg === '--ae-version' && argv[i + 1]) opts.aeVersion = String(argv[++i]);
    else if (arg === '--duration' && argv[i + 1]) opts.duration = Number(argv[++i]);
    else if (arg === '--fps' && argv[i + 1]) opts.fps = Number(argv[++i]);
    else if (arg === '--raster-scale' && argv[i + 1]) opts.rasterScale = Number(argv[++i]);
    else if (arg === '--ae-port' && argv[i + 1]) opts.aePort = Number(argv[++i]);
    else if (arg === '--no-organize') opts.organize = false;
    else if (arg === '--no-precomp-layers') opts.precompLayers = false;
    else if (arg === '--no-clip') opts.enableClip = false;
    else if (arg === '--include-hidden') opts.ignoreHidden = false;
    else if (arg === '--merge-blends') opts.mergeBlends = true;
    else if (arg === '--merged-image-masks') opts.nativeImageMasks = false;
    else if (arg === '--preserve-image-filters') opts.preserveImageFilters = true;
    else if (arg === '--preserve-background-blur') opts.preserveBackgroundBlur = true;
    else if (arg === '--raster-all-groups') opts.rasterAllGroups = true;
    else if (arg === '--raster-instances') opts.rasterInstances = true;
    else if (arg === '--no-reference') opts.skipReferences = true;
    else throw new Error('未知参数：' + arg);
  }

  if (!['aep', 'web', 'ae', 'packet'].includes(opts.format)) {
    throw new Error('不支持的导出格式：' + opts.format + '（可选 aep | web | ae | packet）');
  }
  if (!['editable', 'vector', 'png'].includes(opts.textMode)) {
    throw new Error('不支持的文字模式：' + opts.textMode + '（可选 editable | vector | png）');
  }
  return opts;
}

function postJson(port, body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(raw),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); }
        catch { resolve({ ok: res.statusCode < 400, raw: text }); }
      });
    });
    req.on('error', err => reject(new Error('无法连接到端口 ' + port + ' 上的 AE 桥接服务：' + err.message)));
    req.write(raw);
    req.end();
  });
}

async function shipToAeBridge(packet, opts) {
  const port = opts.aePort || 7365;
  const images = Array.isArray(packet.images) ? packet.images : [];
  const mainAck = await postJson(port, {
    type: 'svg',
    name: packet.name,
    svg: packet.svg,
    texts: packet.texts || [],
    effects: packet.effects || [],
    shift: packet.shift || { x: 0, y: 0 },
    nodes: packet.nodes || null,
    compSize: packet.newComp ? packet.frame : null,
    compDuration: packet.newComp ? opts.duration : null,
    compFrameRate: packet.newComp ? opts.fps : null,
    containers: packet.containers || null,
    organize: !!packet.organize,
    imageCount: images.length,
    imageBatch: true,
    vnStats: packet.vnStats || null,
  });
  if (mainAck && mainAck.ok === false) {
    throw new Error('AE 导入失败：' + (mainAck.error || '未知错误'));
  }
  for (let i = 0; i < images.length; i++) {
    const imgAck = await postJson(port, {
      type: 'image',
      index: i,
      total: images.length,
      image: images[i],
    });
    if (imgAck && imgAck.ok === false) {
      throw new Error('AE 接收图片失败：' + (imgAck.error || '未知错误'));
    }
  }
  if (images.length) {
    const doneAck = await postJson(port, { type: 'images-complete' });
    if (doneAck && doneAck.ok === false) {
      throw new Error('AE 完成导入失败：' + (doneAck.error || '未知错误'));
    }
  }
  return { format: 'ae', port, name: packet.name, imageCount: images.length, ack: mainAck };
}

async function runExport(opts, deps = {}) {
  const client = deps.client || createClient(deps.clientOptions || {});
  const runner = deps.runner || createRunner(client);
  const target = {};
  if (opts.documentId) target.documentId = opts.documentId;
  if (opts.pageId) target.pageId = opts.pageId;

  if (opts.listDocuments) {
    const health = await client.health();
    if (!health.connected) {
      return { connected: false, error: health.error, documents: [], selection: [] };
    }
    const documents = await client.listDocuments();
    let selection = [];
    let resolvedTarget = null;
    if (documents.length) {
      try {
        const selRes = await client.getSelection(target);
        selection = Array.isArray(selRes.result) ? selRes.result : [];
        resolvedTarget = selRes.target || null;
      } catch {}
    }
    return { connected: true, health, documents, target: resolvedTarget, selection };
  }

  if (opts.format !== 'ae' && !opts.output) {
    throw new Error('导出 ' + opts.format + ' 格式需要通过 --output <路径> 指定输出位置。');
  }

  const targetKind = opts.format === 'web' ? 'web' : (opts.format === 'ae' ? 'ae' : 'aep');
  const exportSettings = {
    target: targetKind,
    useNodes: true,
    organize: opts.organize,
    precompLayers: opts.precompLayers,
    enableClip: opts.enableClip,
    ignoreHidden: opts.ignoreHidden,
    convertMasks: true,
    nativeImageMasks: opts.nativeImageMasks,
    preserveImageFilters: opts.preserveImageFilters,
    preserveBackgroundBlur: targetKind !== 'web' && opts.preserveBackgroundBlur,
    rasterScale: opts.rasterScale,
    rasterize: { effects: true, paints: true, imageCrops: true, masks: true, booleans: true },
    mergeBlends: opts.mergeBlends,
    outlineTexts: opts.textMode === 'vector',
    rasterTexts: opts.textMode === 'png',
    rasterAllGroups: opts.rasterAllGroups,
    rasterInstances: opts.rasterInstances,
    skipReferences: opts.skipReferences,
    selectionIds: opts.nodeIds.length ? opts.nodeIds : undefined,
  };

  const exported = await runner.exportSelection(exportSettings, target, {
    resolveHeadlessShadows: true,
    throwOnError: true,
    onProgress(text) {
      if (!opts.json && !deps.quiet) process.stderr.write('[F2A] ' + text + '\n');
    },
  });

  const packet = exported.packet;
  packet.aeVersion = opts.aeVersion;
  packet.duration = opts.duration;
  packet.frameRate = opts.fps;

  if (opts.format === 'packet') {
    const outPath = path.resolve(opts.output);
    const filePath = outPath.toLowerCase().endsWith('.json') ? outPath : path.join(outPath, 'packet.json');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(packet, null, 2) + '\n', 'utf8');
    return { format: 'packet', file: filePath, name: packet.name, imageCount: packet.images.length };
  }
  if (opts.format === 'web') {
    const outDir = path.resolve(opts.output);
    const result = await exportWeb(packet, outDir);
    return { format: 'web', ...result };
  }
  if (opts.format === 'aep') {
    const outDir = path.resolve(opts.output);
    const result = await exportAep(packet, outDir);
    return { format: 'aep', ...result };
  }
  return shipToAeBridge(packet, opts);
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp();
    return;
  }
  const result = await runExport(opts);
  if (opts.json || opts.listDocuments) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.format === 'aep') {
    console.log('已导出 AEP: ' + result.project + ' (' + result.totalMs + ' ms)');
  } else if (result.format === 'web') {
    console.log('已导出 HTML: ' + result.entry + ' (' + result.totalMs + ' ms)');
  } else if (result.format === 'packet') {
    console.log('已导出数据包: ' + result.file);
  } else {
    console.log('已发送到 After Effects（' + result.name + '，含 ' + result.imageCount + ' 张图片）');
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, runExport, shipToAeBridge };
