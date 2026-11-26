'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');

const { createClient, OpenPencilError, readDiscovery } = require('../openpencil/client.cjs');
const { createRunner } = require('../openpencil/runner.cjs');
const { startBridge, connectRawWebSocket, renderHostHtml } = require('../openpencil/bridge.cjs');
const { windowTitleForPort, buildAppArgs, findAppBrowser } = require('../openpencil/window.cjs');
const { detectImageExt, readImageDimensions, decodePngRgba, encodePngRgba, resolveShadowBaseNode } = require('../openpencil/png.cjs');
const { parseArgs: parseExportArgs, runExport } = require('../scripts/openpencil-export.cjs');
const { parseArgs: parsePanelArgs } = require('../scripts/openpencil-panel.cjs');
const { normalize } = require('../scripts/aep/packet.cjs');
const { writeWebBundle } = require('../scripts/web/writer.cjs');
const { privacyIssues } = require('../scripts/package-dist.cjs');
const { start: startMcpRelay } = require('../mcp/relay.cjs');

const root = path.resolve(__dirname, '..');

function solidPng(width, height, r, g, b, a = 255) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
  }
  return encodePngRgba(width, height, rgba);
}

function createMockOpenPencilScene() {
  const MIXED = Symbol('mixed');
  const nodes = new Map();
  let seq = 100;
  const imgA = solidPng(40, 20, 60, 140, 230, 255);
  const fullShadowPng = (() => {
    const rgba = new Uint8ClampedArray(20 * 20 * 4);
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        const i = (y * 20 + x) * 4;
        if (x >= 2 && x < 12 && y >= 2 && y < 12) {
          rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255; rgba[i + 3] = 255;
        } else if (x >= 4 && x < 16 && y >= 4 && y < 16) {
          rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = 128;
        }
      }
    }
    return encodePngRgba(20, 20, rgba);
  })();
  const cleanShadowPng = solidPng(10, 10, 255, 255, 255, 255);

  const images = new Map([['hash-banner', imgA]]);
  let tempRectCreated = 0;

  function makeNode(type, name, props = {}) {
    const id = props.id || ('n:' + (++seq));
    const n = {
      id,
      type,
      name,
      visible: true,
      locked: false,
      opacity: 1,
      blendMode: type === 'GROUP' ? 'PASS_THROUGH' : 'NORMAL',
      fills: [],
      strokes: [],
      effects: [],
      width: props.width ?? 100,
      height: props.height ?? 60,
      x: props.x ?? 0,
      y: props.y ?? 0,
      cornerRadius: props.cornerRadius ?? 0,
      topLeftRadius: props.topLeftRadius ?? (typeof props.cornerRadius === 'number' ? props.cornerRadius : 0),
      topRightRadius: props.topRightRadius ?? (typeof props.cornerRadius === 'number' ? props.cornerRadius : 0),
      bottomRightRadius: props.bottomRightRadius ?? (typeof props.cornerRadius === 'number' ? props.cornerRadius : 0),
      bottomLeftRadius: props.bottomLeftRadius ?? (typeof props.cornerRadius === 'number' ? props.cornerRadius : 0),
      cornerSmoothing: props.cornerSmoothing ?? 0,
      clipsContent: false,
      isMask: false,
      removed: false,
      parent: null,
      ...props,
    };
    if (props.children || ['FRAME', 'GROUP', 'PAGE', 'DOCUMENT', 'COMPONENT', 'INSTANCE'].includes(type)) {
      n.children = props.children ? props.children.slice() : [];
    } else {
      delete n.children;
    }
    if (!n.relativeTransform) n.relativeTransform = [[1, 0, n.x], [0, 1, n.y]];
    if (!n.absoluteTransform) n.absoluteTransform = [[1, 0, n.x], [0, 1, n.y]];
    if (!n.absoluteBoundingBox) n.absoluteBoundingBox = { x: n.x, y: n.y, width: n.width, height: n.height };
    if (!n.absoluteRenderBounds) n.absoluteRenderBounds = { ...n.absoluteBoundingBox };

    // Simulate OpenPencil quirk: ROUNDED_RECTANGLE has NO fillGeometry / strokeGeometry / outlineStroke!
    if (type !== 'ROUNDED_RECTANGLE' && type !== 'GROUP' && type !== 'PAGE' && type !== 'DOCUMENT') {
      if (n.fillGeometry === undefined) {
        n.fillGeometry = [{ windingRule: 'NONZERO', data: `M0 0H${n.width}V${n.height}H0Z` }];
      }
      if (n.strokeGeometry === undefined) {
        n.strokeGeometry = (n.strokes || []).length ? [{ windingRule: 'NONZERO', data: `M0 0H${n.width}V${n.height}H0Z` }] : [];
      }
      if (!n.outlineStroke) {
        n.outlineStroke = () => {
          if (n.type === 'TEXT') {
            // Simulate OpenPencil text.outlineStroke() returning a GROUP of glyph VECTORs!
            const glyph = makeNode('VECTOR', 'glyph-stroke', {
              width: 20, height: 20,
              fillGeometry: [{ windingRule: 'NONZERO', data: 'M0 0H10V10H0Z' }],
              fills: n.strokes,
              absoluteTransform: n.absoluteTransform,
            });
            const grp = makeNode('GROUP', 'Text Outline', { children: [glyph] });
            glyph.parent = grp;
            page.appendChild(grp);
            return grp;
          }
          const vec = makeNode('VECTOR', n.name + ' stroke', {
            width: n.width, height: n.height,
            fillGeometry: [{ windingRule: 'NONZERO', data: `M0 0H${n.width}V${n.height}H0Z` }],
            fills: n.strokes,
            absoluteTransform: n.absoluteTransform,
          });
          page.appendChild(vec);
          return vec;
        };
      }
    }

    if (n.children) {
      n.appendChild = child => {
        if (child.parent && child.parent.children) {
          child.parent.children = child.parent.children.filter(c => c !== child);
        }
        child.parent = n;
        n.children.push(child);
      };
      n.insertChild = (idx, child) => {
        if (child.parent && child.parent.children) {
          child.parent.children = child.parent.children.filter(c => c !== child);
        }
        child.parent = n;
        n.children.splice(idx, 0, child);
      };
      for (const c of n.children) c.parent = n;
    }
    n.resize = (w, h) => {
      n.width = w; n.height = h;
      n.absoluteBoundingBox = { x: n.absoluteTransform[0][2], y: n.absoluteTransform[1][2], width: w, height: h };
      n.absoluteRenderBounds = { ...n.absoluteBoundingBox };
    };
    n.resizeWithoutConstraints = n.resize;
    n.clone = (skipAttach = false) => {
      const copyProps = { ...n };
      delete copyProps.id;
      delete copyProps.parent;
      delete copyProps.children;
      delete copyProps.clone;
      delete copyProps.remove;
      delete copyProps.appendChild;
      delete copyProps.insertChild;
      delete copyProps.resize;
      delete copyProps.resizeWithoutConstraints;
      delete copyProps.exportAsync;
      delete copyProps.outlineStroke;
      copyProps.fills = Array.isArray(n.fills) ? n.fills.map(f => ({ ...f })) : n.fills;
      copyProps.strokes = Array.isArray(n.strokes) ? n.strokes.map(s => ({ ...s })) : n.strokes;
      copyProps.effects = Array.isArray(n.effects) ? n.effects.map(e => ({ ...e })) : n.effects;
      copyProps.absoluteTransform = n.absoluteTransform.map(r => r.slice());
      copyProps.relativeTransform = n.relativeTransform.map(r => r.slice());
      copyProps.absoluteBoundingBox = { ...n.absoluteBoundingBox };
      copyProps.absoluteRenderBounds = { ...n.absoluteRenderBounds };
      if (n.type === 'ROUNDED_RECTANGLE') {
        delete copyProps.fillGeometry;
        delete copyProps.strokeGeometry;
      }
      if (n.children) copyProps.children = n.children.map(c => c.clone(true));
      const copy = makeNode(n.type, n.name, copyProps);
      if (n._isShadowTarget) {
        Object.defineProperty(copy, 'absoluteRenderBounds', {
          get() {
            const hasShadow = (copy.effects || []).some(e => e.type === 'DROP_SHADOW' && e.visible !== false);
            return hasShadow ? { x: 10, y: 20, width: 20, height: 20 } : { x: 12, y: 22, width: 10, height: 10 };
          },
          set() {},
          enumerable: true,
          configurable: true,
        });
      }
      if (!skipAttach && n.parent && n.parent.appendChild) n.parent.appendChild(copy);
      return copy;
    };
    n.remove = () => {
      n.removed = true;
      if (n.parent && n.parent.children) {
        n.parent.children = n.parent.children.filter(c => c !== n);
      }
      nodes.delete(n.id);
    };
    n.exportAsync = async () => {
      if (n.effects && n.effects.some(e => e.type === 'DROP_SHADOW' && e.visible !== false)) {
        return new Uint8Array(fullShadowPng);
      }
      if (n._isShadowTarget) {
        return new Uint8Array(cleanShadowPng);
      }
      return new Uint8Array(solidPng(Math.max(1, Math.round(n.width)), Math.max(1, Math.round(n.height)), 200, 100, 50, 255));
    };
    nodes.set(n.id, n);
    return n;
  }

  const page = makeNode('PAGE', 'Page 1', { id: '0:1', children: [] });
  const docRoot = makeNode('DOCUMENT', 'Test Design', { id: '0:0', children: [page] });
  page.selection = [];

  // Build realistic OpenPencil scene inside a FRAME:
  // 1) ROUNDED_RECTANGLE with uniform cornerRadius (no fillGeometry!)
  const rrUniform = makeNode('ROUNDED_RECTANGLE', 'Card BG', {
    id: '1:10', x: 10, y: 10, width: 120, height: 80, cornerRadius: 12,
    fills: [{ type: 'SOLID', color: { r: 0.1, g: 0.2, b: 0.3 }, opacity: 1, visible: true }],
    absoluteTransform: [[1, 0, 10], [0, 1, 10]],
    absoluteBoundingBox: { x: 10, y: 10, width: 120, height: 80 },
    absoluteRenderBounds: { x: 10, y: 10, width: 120, height: 80 },
  });
  // 2) ROUNDED_RECTANGLE with IMAGE fill + identity imageTransform (OpenPencil always sends identity!)
  const rrPhoto1 = makeNode('ROUNDED_RECTANGLE', 'Hero Photo 1', {
    id: '1:11', x: 10, y: 100, width: 40, height: 20, cornerRadius: 4,
    fills: [{ type: 'IMAGE', imageHash: 'hash-banner', scaleMode: 'FILL', imageTransform: [[1, 0, 0], [0, 1, 0]], opacity: 1, visible: true }],
    absoluteTransform: [[1, 0, 10], [0, 1, 100]],
    absoluteBoundingBox: { x: 10, y: 100, width: 40, height: 20 },
    absoluteRenderBounds: { x: 10, y: 100, width: 40, height: 20 },
  });
  // 3) Second node reusing the SAME imageHash (verifies deduplication!)
  const rrPhoto2 = makeNode('ROUNDED_RECTANGLE', 'Hero Photo 2', {
    id: '1:12', x: 60, y: 100, width: 40, height: 20, cornerRadius: 0,
    fills: [{ type: 'IMAGE', imageHash: 'hash-banner', scaleMode: 'FILL', imageTransform: [[1, 0, 0], [0, 1, 0]], opacity: 1, visible: true }],
    absoluteTransform: [[1, 0, 60], [0, 1, 100]],
    absoluteBoundingBox: { x: 60, y: 100, width: 40, height: 20 },
    absoluteRenderBounds: { x: 60, y: 100, width: 40, height: 20 },
  });
  // 4) TEXT node with missing local font + DROP_SHADOW
  const title = makeNode('TEXT', 'Title', {
    id: '1:13', x: 12, y: 22, width: 10, height: 10,
    characters: 'Hello OpenPencil',
    fontSize: 16,
    fontName: { family: 'MissingCustomFont', style: 'Bold' },
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1, visible: true }],
    effects: [{ type: 'DROP_SHADOW', visible: true, radius: 4, spread: 0, offset: { x: 2, y: 2 }, color: { r: 0, g: 0, b: 0, a: 0.5 } }],
    _isShadowTarget: true,
    absoluteTransform: [[1, 0, 12], [0, 1, 22]],
    absoluteBoundingBox: { x: 12, y: 22, width: 10, height: 10 },
    absoluteRenderBounds: { x: 10, y: 20, width: 20, height: 20 },
    getStyledTextSegments: () => [{
      characters: 'Hello OpenPencil',
      fontName: { family: 'MissingCustomFont', style: 'Bold' },
      fontSize: 16,
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1, visible: true }],
      textCase: 'ORIGINAL',
      letterSpacing: { unit: 'PIXELS', value: 0 },
      lineHeight: { unit: 'AUTO' },
      textDecoration: 'NONE',
    }],
  });
  // Keep clean shadow bounds dynamic when DROP_SHADOW is removed!
  Object.defineProperty(title, 'absoluteRenderBounds', {
    get() {
      const hasShadow = (title.effects || []).some(e => e.type === 'DROP_SHADOW' && e.visible !== false);
      return hasShadow ? { x: 10, y: 20, width: 20, height: 20 } : { x: 12, y: 22, width: 10, height: 10 };
    },
    set() {},
    enumerable: true,
    configurable: true,
  });

  // 5) ROUNDED_RECTANGLE with cornerSmoothing + dashed stroke
  const rrSmooth = makeNode('ROUNDED_RECTANGLE', 'Squircle Pill', {
    id: '1:14', x: 10, y: 130, width: 100, height: 40, cornerRadius: 16, cornerSmoothing: 0.6,
    fills: [{ type: 'SOLID', color: { r: 0.2, g: 0.6, b: 0.4 }, opacity: 1, visible: true }],
    strokes: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1, visible: true }],
    strokeWeight: 2, strokeAlign: 'INSIDE', dashPattern: [4, 2],
    absoluteTransform: [[1, 0, 10], [0, 1, 130]],
    absoluteBoundingBox: { x: 10, y: 130, width: 100, height: 40 },
    absoluteRenderBounds: { x: 10, y: 130, width: 100, height: 40 },
  });

  const frame = makeNode('FRAME', 'Main Banner', {
    id: '1:1', x: 0, y: 0, width: 200, height: 200, clipsContent: true,
    fills: [{ type: 'SOLID', color: { r: 0.05, g: 0.05, b: 0.08 }, opacity: 1, visible: true }],
    children: [rrUniform, rrPhoto1, rrPhoto2, title, rrSmooth],
    absoluteTransform: [[1, 0, 0], [0, 1, 0]],
    absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 200 },
    absoluteRenderBounds: { x: 0, y: 0, width: 200, height: 200 },
  });
  page.appendChild(frame);
  page.selection = [frame];

  // Use a real class with #private fields (matching OpenPencil's FigmaAPI) so receiver binding is always verified.
  class MockFigmaAPI {
    #page;
    #root;
    #nodes;
    #images;
    constructor() {
      this.#page = page;
      this.#root = docRoot;
      this.#nodes = nodes;
      this.#images = images;
      this.mixed = MIXED;
    }
    get root() { return this.#root; }
    get currentPage() { return this.#page; }
    set currentPage(p) { this.#page = p; }
    async getNodeByIdAsync(id) { return this.#nodes.get(id) || null; }
    async setCurrentPageAsync(p) { this.#page = p; }
    async loadFontAsync(fn) {
      throw new Error(`The font "${fn.family} ${fn.style}" could not be loaded`);
    }
    createFrame() {
      const f = makeNode('FRAME', 'Frame', { x: 0, y: 0, width: 100, height: 100 });
      this.#page.appendChild(f);
      return f;
    }
    createRectangle() {
      tempRectCreated++;
      const r = makeNode('RECTANGLE', 'Rectangle', { x: 0, y: 0, width: 100, height: 100 });
      this.#page.appendChild(r);
      return r;
    }
    group(items, parent) {
      const g = makeNode('GROUP', 'Group', { children: [] });
      parent.appendChild(g);
      for (const item of items) g.appendChild(item);
      return g;
    }
    flatten(items, parent) {
      const v = makeNode('VECTOR', items[0].name, {
        width: items[0].width, height: items[0].height,
        fills: items[0].fills,
        fillGeometry: [{ windingRule: 'NONZERO', data: 'M0 0H10V10H0Z' }],
        absoluteTransform: items[0].absoluteTransform,
      });
      parent.appendChild(v);
      return v;
    }
    getImageByHash(hash) {
      const bytes = this.#images.get(hash);
      if (!bytes) return null;
      return {
        hash,
        async getBytesAsync() { return new Uint8Array(bytes); },
        async getSizeAsync() { return { width: 40, height: 20 }; },
      };
    }
    base64Encode(bytes) { return Buffer.from(bytes).toString('base64'); }
  }
  const figma = new MockFigmaAPI();

  return { figma, page, frame, nodes, stats: () => ({ tempRectCreated }) };
}

async function startMockOpenPencilServer(scene, options = {}) {
  let token = options.authToken || 'secret-token-1';
  let scope = options.scope || 'document';
  const calls = [];
  let selectedIds = [scene.frame.id];

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const auth = req.headers.authorization || '';
    if (token && auth !== 'Bearer ' + token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: '0.17.0-mock', scope }));
      return;
    }
    if (req.method === 'POST' && req.url === '/rpc') {
      const { command, args = {} } = JSON.parse(bodyText);
      calls.push({ command, args });
      const target = {
        documentId: args.document_id || 'tab-1',
        documentName: 'Mock Banner.fig',
        pageId: scene.page.id,
        pageName: scene.page.name,
      };
      try {
        if (command === 'list_documents') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            result: {
              documents: [{
                id: 'tab-1',
                name: 'Mock Banner.fig',
                active: true,
                current_page_id: scene.page.id,
                current_page_name: scene.page.name,
                pages: [{ id: scene.page.id, name: scene.page.name }],
              }],
            },
          }));
          return;
        }
        if (command === 'selection') {
          const items = selectedIds.map(id => scene.nodes.get(id)).filter(Boolean).map(n => ({
            id: n.id, name: n.name, type: n.type, width: n.width, height: n.height,
          }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: items, target }));
          return;
        }
        if (command === 'activate_document') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: { activated: true }, target }));
          return;
        }
        if (command === 'tool') {
          if (args.name === 'set_selection' && Array.isArray(args.args?.ids)) {
            selectedIds = args.args.ids.slice();
            scene.page.selection = selectedIds.map(id => scene.nodes.get(id)).filter(Boolean);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: { ok: true }, target }));
          return;
        }
        if (command === 'eval') {
          if (scope === 'selection') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'This session only shares the selection' }));
            return;
          }
          const fn = new AsyncFunction('figma', args.code);
          const result = await fn(scene.figma);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result: result ?? null, target }));
          return;
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Unknown command: ' + command }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error.message || String(error) }));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    port: server.address().port,
    calls,
    setToken(next) { token = next; },
    setScope(next) { scope = next; },
    setSelection(ids) {
      selectedIds = ids.slice();
      scene.page.selection = selectedIds.map(id => scene.nodes.get(id)).filter(Boolean);
    },
    getSelectionIds: () => selectedIds.slice(),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function testCodeJsCompatibility() {
  const source = fs.readFileSync(path.join(root, 'figma-plugin/code.js'), 'utf8');
  assert.equal(/\bimport\s*(?:\(|\/[/*]|<!--|-->)/.test(source), false, 'code.js must pass Figma sandbox scanner');

  const scene = createMockOpenPencilScene();
  const messages = [];
  const overrides = {
    showUI() {},
    on() {},
    commitUndo() {},
    notify() {},
    ui: { postMessage(m) { messages.push(m); } },
  };
  const figma = new Proxy(scene.figma, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
    set(target, prop, value) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) { overrides[prop] = value; return true; }
      target[prop] = value;
      return true;
    },
  });
  const ctx = vm.createContext({ figma, __html__: '', console, setTimeout, clearTimeout });
  vm.runInContext(source, ctx);

  // 1) Identity imageTransform must NOT be flagged as crop
  const photoNode = scene.nodes.get('1:11');
  assert.equal(ctx._isIdentityMatrix([[1, 0, 0], [0, 1, 0]]), true);
  assert.equal(ctx._isIdentityMatrix([[0.5, 0, 0.2], [0, 0.5, 0.1]]), false);
  ctx._rasterOptions = { effects: false, paints: false, imageCrops: false, masks: false, booleans: false };
  assert.equal(ctx._singleImageNeedsRaster(photoNode, []), false, 'OpenPencil identity imageTransform must not trigger imageCrops rasterization');

  const croppedNode = {
    ...photoNode,
    id: '1:99',
    fills: [{ type: 'IMAGE', imageHash: 'hash-banner', scaleMode: 'FILL', imageTransform: [[0.5, 0, 0.2], [0, 0.5, 0.1]], visible: true }],
  };
  assert.throws(() => ctx._singleImageNeedsRaster(croppedNode, []), /图片裁剪/, 'Non-identity imageTransform must still require imageCrops');

  // 2) ROUNDED_RECTANGLE geometry synthesis (uniform & independent corners)
  const rrUniform = scene.nodes.get('1:10');
  const uniformGeo = ctx._nodeFillGeometry(rrUniform, scene.frame);
  assert.equal(uniformGeo.length, 1);
  assert.match(uniformGeo[0].data, /^M12 0L108 0C/);
  assert.equal(ctx._nativeMaskGeometrySupported(rrUniform), true, 'ROUNDED_RECTANGLE mask should be native-supported');
  assert.equal(ctx._rasterOpaqueBackdrop(rrUniform, { x: 20, y: 20, width: 40, height: 30 }), true, 'ROUNDED_RECTANGLE should close blend backdrop');

  // 3) TEXT outlineStroke() returning GROUP (OpenPencil behavior)
  const outlinedText = {
    id: '1:88', type: 'TEXT', name: 'Thin Stroke Text', width: 50, height: 20,
    strokes: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 1, visible: true }],
    strokeWeight: 0.5,
    absoluteTransform: [[1, 0, 0], [0, 1, 0]],
    clone() { return { ...this, removed: false, remove() { this.removed = true; }, outlineStroke: () => {
      const child = {
        id: 'g:1', type: 'VECTOR', fillGeometry: [{ windingRule: 'NONZERO', data: 'M0 0H5V5H0Z' }],
        fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 1, visible: true }],
        absoluteTransform: [[1, 0, 0], [0, 1, 0]],
      };
      return { id: 'g:0', type: 'GROUP', children: [child], removed: false, remove() { this.removed = true; } };
    }}; },
  };
  const parts = ctx._outlineExportStroke(outlinedText, scene.frame, true);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].paths[0].d, 'M0 0H5V5H0Z');

  // 4) Full exportSelectionSVG with deferHashImages + skipReferences
  messages.length = 0;
  await ctx.exportSelectionSVG(true, true, true, true, true, false, {
    target: 'aep',
    rasterize: { effects: true, paints: true, imageCrops: false, masks: true, booleans: true },
    skipReferences: true,
    deferHashImages: true,
  });
  const ship = messages.find(m => m.type === 'ship');
  assert.ok(ship, 'Must emit ship message: ' + JSON.stringify(messages.filter(m => m.type === 'error')));
  assert.ok(ship.nodes.some(n => n.name === 'Card BG' && n.prim && n.prim.k === 'rect' && n.prim.r === 12), 'ROUNDED_RECTANGLE must export as parametric rect');
  assert.ok(ship.nodes.some(n => n.name === 'Squircle Pill' && n.outlinedStrokes && n.outlinedStrokes.length === 1), 'ROUNDED_RECTANGLE with cornerSmoothing + dash must outline via temp RECTANGLE');
  assert.ok(scene.stats().tempRectCreated >= 2, 'Expected temp RECTANGLE proxy for cornerSmoothing and dashed stroke');
  const deferred = messages.filter(m => m.type === 'image-deferred');
  assert.equal(deferred.length, 2, 'Both IMAGE fills should be deferred without rasterizing identity imageTransform');
  assert.deepEqual(ship.referenceIds, ['1:1']);
  console.log('PASS: code.js OpenPencil compatibility (ROUNDED_RECTANGLE, imageTransform, text GROUP outline, deferred images)');
}

async function testPngHelper() {
  const buf = solidPng(4, 3, 12, 34, 56, 200);
  assert.equal(detectImageExt(buf), 'png');
  assert.deepEqual(readImageDimensions(buf), { width: 4, height: 3 });
  const decoded = decodePngRgba(buf);
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 3);
  assert.deepEqual(Array.from(decoded.data.slice(0, 4)), [12, 34, 56, 200]);

  const full = (() => {
    const rgba = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      rgba[i * 4] = 0; rgba[i * 4 + 1] = 0; rgba[i * 4 + 2] = 0; rgba[i * 4 + 3] = 128;
    }
    rgba[0] = 255; rgba[1] = 255; rgba[2] = 255; rgba[3] = 255;
    return encodePngRgba(4, 4, rgba).toString('base64');
  })();
  const clean = solidPng(1, 1, 255, 255, 255, 255).toString('base64');
  const shadowB64 = resolveShadowBaseNode(full, { data: clean, dx: 0, dy: 0, w: 1, h: 1 });
  const shadow = decodePngRgba(Buffer.from(shadowB64, 'base64'));
  assert.equal(shadow.data[3], 0, 'Foreground pixel must be cleared from shadow');
  assert.equal(shadow.data[4 + 3], 128, 'Shadow-only pixel must preserve alpha');
  console.log('PASS: openpencil/png.cjs codec and headless shadow extraction');
}

async function testClientAndRunnerAndExport() {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'f2a-openpencil-test-'));
  const scene = createMockOpenPencilScene();
  const mock = await startMockOpenPencilServer(scene, { authToken: 'tok-1' });
  const discPath = path.join(tmpDir, 'mcp.json');
  await fsp.writeFile(discPath, JSON.stringify({
    pid: process.pid,
    httpPort: mock.port,
    authRequired: true,
    authToken: 'tok-1',
    version: '0.17.0-mock',
    scope: 'document',
  }));

  try {
    // Client discovery + health + token rotation retry
    assert.equal(readDiscovery({ discoveryPath: path.join(tmpDir, 'missing.json') }), null);
    const client = createClient({ discoveryPath: discPath });
    const h1 = await client.health();
    assert.equal(h1.connected, true);
    assert.equal(h1.version, '0.17.0-mock');

    // Rotate token on server & discovery file; cached client must auto-retry on 401
    mock.setToken('tok-2');
    await fsp.writeFile(discPath, JSON.stringify({
      pid: process.pid, httpPort: mock.port, authRequired: true, authToken: 'tok-2', version: '0.17.0-mock', scope: 'document',
    }));
    const docs = await client.listDocuments();
    assert.equal(docs.length, 1);
    assert.equal(docs[0].name, 'Mock Banner.fig');

    // Selection-only scope produces friendly Chinese error
    mock.setScope('selection');
    await assert.rejects(() => client.evalCode('return 1'), err => err instanceof OpenPencilError && err.code === 'selection_scope' && /仅共享选区/.test(err.message));
    mock.setScope('document');

    // Staged 3-phase runner export
    const runner = createRunner(client);
    mock.calls.length = 0;
    const exported = await runner.exportSelection({
      target: 'aep',
      useNodes: true,
      organize: true,
      precompLayers: true,
      ignoreHidden: true,
      convertMasks: true,
      nativeImageMasks: true,
      rasterScale: 1,
      rasterize: { effects: true, paints: true, imageCrops: false, masks: true, booleans: true },
    }, { documentId: 'tab-1' }, { resolveHeadlessShadows: true, throwOnError: true });

    assert.ok(exported && exported.packet);
    // Deduplication check: 2 IMAGE nodes share 'hash-banner', so eval calls should be 1 (main) + 1 (hash) + 1 (reference) = 3!
    const evalCalls = mock.calls.filter(c => c.command === 'eval');
    assert.equal(evalCalls.length, 3, 'Expected 3 staged eval RPCs (extract + 1 unique image hash + 1 reference), got ' + evalCalls.length);
    assert.equal(exported.packet.images.length, 4, '2 deferred photo fills + 1 shadow + 1 reference');
    assert.ok(exported.packet.images.every(im => !im.shadowBase), 'Headless shadow extraction must clear shadowBase');
    assert.ok(exported.packet.images.some(im => im.reference), 'Reference image must be appended');

    // Feed packet into F2A AEP packet normalizer AND Web bundle writer!
    exported.packet.aeVersion = '26.0';
    exported.packet.duration = 10;
    exported.packet.frameRate = 30;
    const normalized = normalize(exported.packet);
    assert.equal(normalized.name, 'Main Banner');
    assert.ok(normalized.images.length >= 3);

    const webDir = path.join(tmpDir, 'web-out');
    const webResult = await writeWebBundle(exported.packet, webDir);
    assert.equal(webResult.warnings.length, 0);
    await fsp.access(path.join(webDir, 'index.html'));
    await fsp.access(path.join(webDir, 'style.css'));
    await fsp.access(path.join(webDir, 'main.js'));

    // Mark raster / unmark / locateLayer / MCP execute
    const marked = await runner.markRaster(true, { documentId: 'tab-1' });
    assert.ok(marked.some(m => m.type === 'mark-result' && /已标记 1/.test(m.message)));
    assert.equal(scene.frame.name, '*Main Banner');
    await runner.markRaster(false, { documentId: 'tab-1' });
    assert.equal(scene.frame.name, 'Main Banner');

    const located = await runner.locateLayer('1:10', { documentId: 'tab-1' });
    assert.equal(located.ok, true);
    assert.ok(mock.calls.some(c => c.command === 'tool' && c.args.name === 'zoom_to_fit' && c.args.args.ids[0] === '1:10'));
    mock.setSelection(['1:1']);

    const mcpSel = await runner.executeMcpCommand('get_selection', {}, { documentId: 'tab-1' });
    assert.equal(mcpSel.selectionCount, 1);

    // CLI openpencil-export.cjs tests
    const listOut = await runExport(parseExportArgs(['--list-documents', '--json']), { client, quiet: true });
    assert.equal(listOut.connected, true);
    assert.equal(listOut.documents.length, 1);

    const cliWebDir = path.join(tmpDir, 'cli-web');
    const cliWeb = await runExport(parseExportArgs(['--format', 'web', '--output', cliWebDir, '--node', '1:1']), { client, quiet: true });
    assert.equal(cliWeb.format, 'web');
    await fsp.access(path.join(cliWebDir, 'index.html'));

    const cliPacketPath = path.join(tmpDir, 'packet.json');
    const cliPacket = await runExport(parseExportArgs(['--format', 'packet', '--output', cliPacketPath, '--node', '1:1']), { client, quiet: true });
    assert.equal(cliPacket.format, 'packet');
    const savedPacket = JSON.parse(await fsp.readFile(cliPacketPath, 'utf8'));
    assert.equal(savedPacket.name, 'Main Banner');

    // CLI --format ae against mock AE bridge
    const aeMsgs = [];
    const aeServer = http.createServer(async (req, res) => {
      const c = []; for await (const d of req) c.push(d);
      aeMsgs.push(JSON.parse(Buffer.concat(c).toString('utf8')));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, shapes: 3 }));
    });
    aeServer.listen(0, '127.0.0.1');
    await once(aeServer, 'listening');
    try {
      const aeRes = await runExport(parseExportArgs(['--format', 'ae', '--ae-port', String(aeServer.address().port), '--node', '1:1']), { client, quiet: true });
      assert.equal(aeRes.format, 'ae');
      assert.equal(aeMsgs[0].type, 'svg');
      assert.equal(aeMsgs[aeMsgs.length - 1].type, 'images-complete');
    } finally {
      await new Promise(r => aeServer.close(r));
    }

    // Bridge HTTP + WebSocket panel + settings + headless MCP relay end-to-end
    const relay = startMcpRelay({ port: 0, commandTimeout: 15000, idleTimeout: 60000 });
    await once(relay.server, 'listening');
    const relayPort = relay.server.address().port;

    const settingsPath = path.join(tmpDir, 'settings.json');
    const topmostCalls = [];
    const popoutOpens = [];
    const iconKeeperCalls = [];
    let iconKeeperStopped = false;
    const bridge = startBridge({
      port: 0,
      client,
      settingsPath,
      autoStartAep: false,
      mcp: true,
      mcpPort: relayPort,
      pollIntervalMs: 5000,
      topmost: true,
      topmostSupported: true,
      setWindowTopmost: async (title, flag) => {
        topmostCalls.push({ title, flag });
        return { ok: true, supported: true, found: true, topmost: flag };
      },
      focusWindow: async () => ({ ok: true, supported: true, found: false }),
      openAppWindow: (url, opts) => {
        popoutOpens.push({ url, opts });
        return { mode: 'app', binary: 'mock-edge' };
      },
      ensureWindowIcon: (title, opts) => {
        iconKeeperCalls.push({ title, opts });
        return { ok: true, supported: true, reused: false };
      },
      stopWindowIcon: () => {
        iconKeeperStopped = true;
      },
      quiet: true,
    });
    await once(bridge.server, 'listening');
    const bridgePort = bridge.server.address().port;

    try {
      // Wait for headless MCP session to register in relay
      let sessions = [];
      for (let i = 0; i < 40; i++) {
        const res = await fetch('http://127.0.0.1:' + relayPort + '/sessions').then(r => r.json());
        sessions = res.sessions || [];
        if (sessions.length) break;
        await new Promise(r => setTimeout(r, 50));
      }
      assert.equal(sessions.length, 1, 'Headless OpenPencil MCP bridge should register session');
      assert.match(sessions[0].name, /OpenPencil: Mock Banner\.fig/);

      // Execute MCP command via relay -> headless OpenPencil bridge -> mock OpenPencil
      const cmdRes = await fetch('http://127.0.0.1:' + relayPort + '/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessions[0].id, command: 'get_selection', params: {} }),
      }).then(r => r.json());
      assert.equal(cmdRes.result.selectionCount, 1);

      // Execute f2a_export_aep via relay (aep-part chunked transfer!)
      const aepRes = await fetch('http://127.0.0.1:' + relayPort + '/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessions[0].id, command: 'f2a_export_aep', params: { aeVersion: '26.0', duration: 8, frameRate: 24 } }),
      }).then(r => r.json());
      assert.equal(aepRes.result.name, 'Main Banner');
      assert.equal(aepRes.result.duration, 8);
      assert.equal(aepRes.result.frameRate, 24);
      assert.equal(aepRes.result.images.length, 4);

      // Host HTML + Health + WebSocket panel round-trip + topmost toggle
      const html = await fetch('http://127.0.0.1:' + bridgePort + '/').then(r => r.text());
      assert.ok(html.includes('sandbox="allow-scripts"'));
      assert.ok(!html.includes('__F2A_UI_HTML__'));
      assert.ok(!html.includes('__F2A_WINDOW_TITLE__'));
      assert.ok(html.includes('<title>F2A · OpenPencil'));
      assert.ok(html.includes('id="op-pin"'));
      assert.ok(!html.includes('id="op-doc"'), 'Document dropdown must be removed in favor of active foreground document');
      assert.ok(!html.includes('id="op-sel"'), 'Selection count badge must be removed');
      assert.ok(!html.includes('id="op-refresh"'), 'Manual refresh button must be removed');
      assert.ok(!html.includes('连接已断开，重连中'), 'Disconnect reconnect banner text must be removed');
      assert.ok(html.includes('href="/icon-256.png'), 'High-DPI PNG app icon must be linked');
      assert.ok(html.includes('.wrap > .status { display: none; }'), 'Redundant AE/MCP status rows inside embedded ui.html must be hidden');
      assert.ok(html.includes('.send-settings { margin-top: 0 !important; }'), 'Top gap above image folder settings must be tightened');
      assert.ok(html.includes('renderWindowState({ supported: true, topmost: next })'), 'Pin button must update optimistically for instant animation');
      assert.ok(html.includes('导出为 AEP 工程'));

      const iconPngRes = await fetch('http://127.0.0.1:' + bridgePort + '/icon-256.png');
      assert.equal(iconPngRes.status, 200);
      const iconPngBuf = Buffer.from(await iconPngRes.arrayBuffer());
      assert.deepEqual(readImageDimensions(iconPngBuf), { width: 256, height: 256 });
      const icoRes = await fetch('http://127.0.0.1:' + bridgePort + '/favicon.ico');
      assert.equal(icoRes.status, 200);

      const health = await fetch('http://127.0.0.1:' + bridgePort + '/health').then(r => r.json());
      assert.equal(health.service, 'f2a-openpencil');
      assert.equal(health.connected, true);
      assert.equal(health.topmost, true);

      const wsMessages = [];
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Panel WebSocket timeout')), 8000);
        let gotSettings = false, gotUnpinned = false;
        const ws = connectRawWebSocket('ws://127.0.0.1:' + bridgePort + '/ws', {
          onOpen() {
            ws.send(JSON.stringify({ type: 'plugin-message', pluginMessage: { type: 'save-settings', settings: { organize: false, 'raster-scale': '2' } } }));
            ws.send(JSON.stringify({ type: 'plugin-message', pluginMessage: { type: 'load-settings' } }));
            ws.send(JSON.stringify({ type: 'set-topmost', topmost: false }));
          },
          onMessage(text) {
            const m = JSON.parse(text);
            wsMessages.push(m);
            if (m.type === 'plugin-message' && m.pluginMessage?.type === 'settings-loaded' && m.pluginMessage.settings) {
              gotSettings = true;
            }
            if (m.type === 'window-state' && m.topmost === false) {
              gotUnpinned = true;
            }
            if (gotSettings && gotUnpinned) {
              clearTimeout(timer);
              ws.close();
              resolve();
            }
          },
        });
      });
      const loaded = wsMessages.find(m => m.type === 'plugin-message' && m.pluginMessage?.type === 'settings-loaded');
      assert.deepEqual(loaded.pluginMessage.settings, { organize: false, 'raster-scale': '2' });
      assert.ok(topmostCalls.some(c => c.flag === true), 'Initial topmost should be requested');
      assert.ok(topmostCalls.some(c => c.flag === false), 'WebSocket set-topmost toggle should invoke helper');

      // Test POST /window/popout (used by AE CEP panel without spawning inside CEP)
      const popRes = await fetch('http://127.0.0.1:' + bridgePort + '/window/popout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topmost: true }),
      }).then(r => r.json());
      assert.equal(popRes.ok, true);
      await new Promise(r => setTimeout(r, 180));
      assert.equal(popoutOpens.length, 1, 'External bridge should launch app window on /window/popout');
      assert.ok(iconKeeperCalls.length >= 1, 'Bridge must invoke native high-DPI window icon keeper for standalone window');
    } finally {
      await bridge.close();
      assert.equal(iconKeeperStopped, true, 'Bridge close must clean up window icon keeper');
      relay.server.closeAllConnections();
      await new Promise(r => relay.server.close(r));
    }

    // Window helper & panel arg parsing checks
    assert.equal(windowTitleForPort(7369), 'F2A · OpenPencil');
    assert.equal(windowTitleForPort(7370), 'F2A · OpenPencil (:7370)');
    const appArgs = buildAppArgs('http://127.0.0.1:7369', { width: 360, height: 840, profileDir: path.join(tmpDir, 'prof') });
    assert.ok(appArgs.includes('--app=http://127.0.0.1:7369'));
    assert.ok(appArgs.includes('--window-size=360,840'));
    assert.ok(appArgs.some(a => a.startsWith('--user-data-dir=')));
    if (process.platform === 'win32') {
      assert.ok(findAppBrowser(), 'Windows should detect Edge or Chrome for standalone app window');
    }

    const panelArgs = parsePanelArgs(['--port', '7370', '--workspace', '--headless']);
    assert.deepEqual({ port: panelArgs.port, workspace: panelArgs.workspace, mcp: panelArgs.mcp, open: panelArgs.open, topmost: panelArgs.topmost },
      { port: 7370, workspace: true, mcp: true, open: false, topmost: false });
    const miniArgs = parsePanelArgs(['--width', '380', '--height', '860', '--auto-exit']);
    assert.deepEqual({ width: miniArgs.width, height: miniArgs.height, topmost: miniArgs.topmost, autoExit: miniArgs.autoExit, useDefaultBrowser: miniArgs.useDefaultBrowser },
      { width: 380, height: 860, topmost: true, autoExit: true, useDefaultBrowser: false });

    // Privacy scan on all new files
    const identifiers = [path.basename(os.homedir()), os.hostname()];
    for (const rel of [
      'openpencil/client.cjs', 'openpencil/png.cjs', 'openpencil/runner.cjs', 'openpencil/host.html',
      'openpencil/bridge.cjs', 'openpencil/window.cjs', 'openpencil/launcher.cjs', 'openpencil/set-topmost.ps1',
      'openpencil/window-icon.ps1', 'openpencil/start-panel.cmd', 'client/openpencilPanel.js',
      'scripts/openpencil-panel.cjs', 'scripts/openpencil-export.cjs',
    ]) {
      const buf = await fsp.readFile(path.join(root, rel));
      assert.deepEqual(privacyIssues(buf, identifiers), [], 'Privacy issue in ' + rel);
    }

    const winIconSrc = await fsp.readFile(path.join(root, 'openpencil/window-icon.ps1'), 'utf8');
    assert.ok(!/WM_SETICON\s*,\s*ICON_SMALL2/.test(winIconSrc), 'WM_SETICON must never pass ICON_SMALL2 or Win32 overwrites ICON_BIG with hSmall');
    assert.ok(winIconSrc.includes('ICON_BIG') && winIconSrc.includes('ICON_SMALL'));

    const cmdBuf = await fsp.readFile(path.join(root, 'openpencil/start-panel.cmd'), 'utf8');
    assert.ok(/^[\x00-\x7f]*$/.test(cmdBuf), 'start-panel.cmd must be pure ASCII so Windows cmd.exe never fails in non-UTF8 codepages');
    assert.ok(cmdBuf.includes('\r\n'), 'start-panel.cmd must use CRLF line endings');

    // AE CEP panel integration check (client/openpencilPanel.js + openpencil/launcher.cjs)
    const aeHtml = await fsp.readFile(path.join(root, 'client/index.html'), 'utf8');
    assert.ok(aeHtml.includes('id="f2o-tab-openpencil"'));
    assert.ok(aeHtml.indexOf('id="f2o-tab-openpencil"') < aeHtml.indexOf('id="f2o-tab-motion"'), 'OpenPencil tab must appear before Motion Library tab');
    assert.ok(!aeHtml.includes('id="mk-figbar"'), 'Top bridge status row must be removed from AE panel');
    assert.ok(!aeHtml.includes('id="mk-mcp-label"'), 'Top MCP status row must be removed from AE panel');
    assert.ok(aeHtml.includes('id="f2o-frame"'));
    assert.ok(aeHtml.includes('src="openpencilPanel.js"'));

    const launcher = require('../openpencil/launcher.cjs');
    assert.equal(typeof launcher.ensurePanelServer, 'function');
    assert.equal(typeof launcher.openFloatingWindow, 'function');

    const opPanelSrc = await fsp.readFile(path.join(root, 'client/openpencilPanel.js'), 'utf8');
    const mkEl = id => {
      const cls = new Set();
      return {
        id, hidden: id === 'f2o-shell' || id === 'f2o-notice', className: '', textContent: '', src: '', attrs: {},
        classList: {
          toggle(name, force) { const on = force == null ? !cls.has(name) : !!force; if (on) cls.add(name); else cls.delete(name); return on; },
          contains(name) { return cls.has(name); },
        },
        setAttribute(k, v) { this.attrs[k] = v; },
      };
    };
    const dom = {
      'f2o-tab-motion': mkEl('f2o-tab-motion'),
      'f2o-tab-openpencil': mkEl('f2o-tab-openpencil'),
      'f2o-dot': mkEl('f2o-dot'),
      'f2o-popout': mkEl('f2o-popout'),
      'f2o-shell': mkEl('f2o-shell'),
      'f2o-frame': mkEl('f2o-frame'),
      'f2o-notice': mkEl('f2o-notice'),
      'f2o-notice-text': mkEl('f2o-notice-text'),
      'f2o-retry': mkEl('f2o-retry'),
    };
    const motionShellEl = mkEl('motion-shell');
    const lsStore = new Map();
    let ensureCalls = 0, popoutCalls = 0;
    const logs = [];
    const aeCtx = vm.createContext({
      window: {
        __adobe_cep__: { getSystemPath: () => 'file:///ext' },
        MKLog: (t, tone) => logs.push({ t, tone }),
      },
      document: {
        getElementById: id => dom[id] || null,
        querySelector: sel => sel === '.f2m-shell' ? motionShellEl : null,
      },
      localStorage: {
        getItem: k => lsStore.has(k) ? lsStore.get(k) : null,
        setItem: (k, v) => lsStore.set(k, String(v)),
      },
      require: mod => {
        if (mod.endsWith('/openpencil/launcher.cjs')) {
          return {
            health(cb) { cb(null, { service: 'f2a-openpencil', version: 1, connected: true, openpencilVersion: '0.17.0', scope: 'document' }); },
            ensurePanelServer(cb) { ensureCalls++; cb(null, { service: 'f2a-openpencil', version: 1, connected: true, openpencilVersion: '0.17.0', scope: 'document' }); },
            openFloatingWindow(cb) { popoutCalls++; cb(null); },
          };
        }
        throw new Error('Unexpected require: ' + mod);
      },
      setTimeout() { return 1; },
      clearTimeout() {},
    });
    vm.runInContext(opPanelSrc, aeCtx);
    assert.equal(ensureCalls, 1, 'AE panel must auto-start OpenPencil bridge on boot');
    assert.equal(dom['f2o-dot'].className, 'f2o-dot on', 'Connected OpenPencil must light up tab dot');
    assert.equal(motionShellEl.hidden, false, 'Default workspace remains Motion Library');
    assert.equal(dom['f2o-shell'].hidden, true);
    assert.equal(dom['f2o-frame'].src, '', 'Iframe stays lazy until OpenPencil tab is opened');

    dom['f2o-tab-openpencil'].onclick();
    assert.equal(motionShellEl.hidden, true);
    assert.equal(dom['f2o-shell'].hidden, false);
    assert.equal(dom['f2o-frame'].src, 'http://127.0.0.1:7369/?embed=ae');
    assert.equal(lsStore.get('f2a.activeWorkspace'), 'openpencil');

    let stopped = false;
    dom['f2o-popout'].onclick({ stopPropagation() { stopped = true; } });
    assert.equal(stopped, true, 'Popout icon click inside OpenPencil tab must stopPropagation');
    assert.equal(popoutCalls, 1, 'Popout button must invoke openFloatingWindow');
    assert.equal(dom['f2o-frame'].src, 'http://127.0.0.1:7369/?embed=ae', 'Embedded iframe must stay mounted when popped out');
    assert.equal(opPanelSrc.includes('window.open'), false, 'AE CEP panel must never call window.open');

    assert.ok(renderHostHtml().includes('f2a-ui'));
    console.log('PASS: OpenPencil client, 3-stage runner, Web/AEP packet, CLI, bridge panel, AE CEP integration, headless MCP relay, and privacy checks');
  } finally {
    await mock.close();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

(async () => {
  await testCodeJsCompatibility();
  await testPngHelper();
  await testClientAndRunnerAndExport();
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
