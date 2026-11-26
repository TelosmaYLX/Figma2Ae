const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'client/style.css'), 'utf8');
const source = fs.readFileSync(path.join(root, 'client/main.js'), 'utf8');

// Markup: the console carries a keyboard-focusable separator grip on its top edge.
assert.match(html, /<div class="mk-console-resize" id="mk-log-resize" role="separator" aria-orientation="horizontal" aria-label="调整日志高度" tabindex="0"/, 'the console carries a top-edge resize grip');
// Style: the height is a variable instead of a hard flex basis, and the grip hides when collapsed.
assert.match(css, /\.mk-console\{[^}]*flex:0 0 var\(--log-height,72px\)/, 'the console height comes from a variable, not one fixed basis');
// margin-top:auto keeps the console docked to the panel bottom when the collapsed motion library
// leaves free space above it; without it a drag grew downward and clamped itself to the minimum.
assert.match(css, /\.mk-console\{[^}]*margin:auto 14px 2px/, 'the console stays docked to the panel bottom');
assert.match(css, /\.mk-console-resize\{[^}]*cursor:ns-resize/, 'the grip shows a vertical resize cursor');
assert.match(css, /\.mk-console\.is-collapsed \.mk-console-resize\{display:none;?\}/, 'the grip disappears while the console is collapsed');

// Minimal DOM: elements carry class/style/listener state, and the console reports a rect derived
// from its own --log-height variable so drags start from the visible height.
function panel(options) {
  options = options || {};
  const state = { innerHeight: options.innerHeight || 600 };
  const nodes = {};
  function el(tag) {
    const listeners = {}, classes = new Set(), vars = {};
    const node = {
      tagName: tag, className: '', children: [], textContent: '', hidden: false,
      scrollTop: 0, scrollHeight: 0, _html: '',
      classList: {
        add() { for (const name of arguments) classes.add(name); },
        remove() { for (const name of arguments) classes.delete(name); },
        toggle(name, force) {
          const on = force == null ? !classes.has(name) : !!force;
          if (on) classes.add(name); else classes.delete(name);
          return on;
        },
        contains(name) { return classes.has(name); }
      },
      style: {
        setProperty(name, value) { vars[name] = String(value); },
        getPropertyValue(name) { return vars[name] || ''; }
      },
      appendChild(child) { node.children.push(child); return child; },
      removeChild(child) {
        const at = node.children.indexOf(child);
        if (at < 0) throw new Error('not a child');
        node.children.splice(at, 1); return child;
      },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      removeEventListener(type, fn) {
        const list = listeners[type] || [];
        const at = list.indexOf(fn);
        if (at >= 0) list.splice(at, 1);
      },
      dispatch(type, ev) { (listeners[type] || []).slice().forEach(fn => fn(ev || {})); },
      setAttribute(name, value) { node[name] = value; },
      setPointerCapture() {},
      releasePointerCapture() {},
      getBoundingClientRect() {
        const height = parseFloat(vars['--log-height']) || 72;
        const bottom = state.innerHeight - 12;
        return { top: bottom - height, bottom, height, left: 0, right: 400, width: 400 };
      }
    };
    Object.defineProperty(node, 'firstChild', { get: () => node.children[0] || null });
    Object.defineProperty(node, 'innerHTML', {
      get: () => node._html,
      set(value) { node._html = value; if (!value) node.children = []; }
    });
    return node;
  }
  const consoleEl = el('section');
  consoleEl.classList.add('mk-console');
  const store = new Map(options.stored ? [['f2a.logHeight', String(options.stored)]] : []);
  const localStorage = {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); }
  };
  const winListeners = {};
  const window = {
    get innerHeight() { return state.innerHeight; },
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const list = winListeners[type] || [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    dispatch(type, ev) { (winListeners[type] || []).slice().forEach(fn => fn(ev || {})); }
  };
  const bodyEl = el('body');
  const document = {
    body: bodyEl,
    getElementById(id) { return nodes[id] || (nodes[id] = el('div')); },
    createElement(tag) { return el(tag); },
    addEventListener() {},
    querySelector(selector) { return selector === '.mk-console' ? consoleEl : null; }
  };
  vm.runInContext(source, vm.createContext({
    window, document, localStorage, console, setTimeout() {}, clearTimeout() {},
    Date, navigator: { platform: 'win32' }
  }));
  return {
    consoleEl, bodyEl, nodes, store, state, window,
    height: () => parseFloat(consoleEl.style.getPropertyValue('--log-height')) || null,
    grip: nodes['mk-log-resize']
  };
}

// Default: the console opens at its previous 72px, still inside the clamped range.
{
  const p = panel();
  assert.equal(p.height(), 72, 'the console opens at the default height');
}

// Drag up grows the console; releasing stores the exact height.
{
  const p = panel();
  p.grip.dispatch('pointerdown', { button: 0, clientY: 300, pointerId: 1 });
  p.window.dispatch('pointermove', { clientY: 240 });
  assert.equal(p.height(), 132, 'dragging up 60px adds 60px to the console');
  assert.equal(p.grip['aria-valuenow'], '132', 'the separator reports the height it now sets');
  assert.equal(p.grip['aria-valuemin'], '56');
  assert.equal(p.grip['aria-valuemax'], String(600 - 12 - 200));
  assert.ok(p.consoleEl.classList.contains('is-resizing'), 'the console marks an active drag');
  p.window.dispatch('pointerup', {});
  assert.equal(p.height(), 132);
  assert.deepEqual([...p.store], [['f2a.logHeight', '132']], 'the chosen height is remembered');
  assert.equal(p.consoleEl.classList.contains('is-resizing'), false, 'releasing clears the drag state');
}

// Clamps: the motion library above always keeps 200px, and the console keeps its header.
{
  const p = panel();
  p.grip.dispatch('pointerdown', { button: 0, clientY: 300, pointerId: 1 });
  p.window.dispatch('pointermove', { clientY: -800 });
  assert.equal(p.height(), 600 - 12 - 200, 'a tall drag stops where the rest of the panel needs its space');
  p.window.dispatch('pointerup', {});
  assert.equal(p.store.get('f2a.logHeight'), '388');
  p.grip.dispatch('pointerdown', { button: 0, clientY: 300, pointerId: 2 });
  p.window.dispatch('pointermove', { clientY: 900 });
  assert.equal(p.height(), 56, 'dragging down stops at the readable minimum');
  p.window.dispatch('pointerup', {});
  assert.equal(p.store.get('f2a.logHeight'), '56');
}

// A collapsed console ignores the grip; the stored height is restored when it unfolds.
{
  const p = panel({ stored: 180 });
  assert.equal(p.height(), 180, 'the saved height is restored on load');
  p.consoleEl.classList.add('is-collapsed');
  p.grip.dispatch('pointerdown', { button: 0, clientY: 300, pointerId: 1 });
  p.window.dispatch('pointermove', { clientY: 200 });
  assert.equal(p.height(), 180, 'a collapsed console cannot be resized');
  p.consoleEl.classList.remove('is-collapsed');
  assert.equal(p.height(), 180, 'expanding keeps the remembered height');
}

// Stored values are clamped on load, and defaults survive invalid storage.
{
  assert.equal(panel({ stored: 9999 }).height(), 388, 'an oversized stored height is clamped on load');
  assert.equal(panel({ stored: 10 }).height(), 56, 'an undersized stored height is clamped on load');
  assert.equal(panel({ stored: 'nonsense' }).height(), 72, 'invalid storage falls back to the default');
  assert.equal(panel({ stored: 240 }).height(), 240);
}

// Keyboard and double-click controls.
{
  const p = panel();
  p.grip.dispatch('keydown', { key: 'ArrowUp' });
  assert.equal(p.height(), 88, 'ArrowUp grows the console by 16px');
  p.grip.dispatch('keydown', { key: 'ArrowUp', shiftKey: true });
  assert.equal(p.height(), 136, 'Shift+ArrowUp grows it faster');
  p.grip.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(p.height(), 120);
  p.grip.dispatch('keydown', { key: 'ArrowDown', shiftKey: true });
  assert.equal(p.height(), 72);
  p.grip.dispatch('keydown', { key: 'Tab' });
  assert.equal(p.height(), 72, 'other keys leave the height alone');
  p.grip.dispatch('pointerdown', { button: 0, clientY: 300, pointerId: 1 });
  p.window.dispatch('pointermove', { clientY: 100 });
  p.window.dispatch('pointerup', {});
  assert.equal(p.height(), 272);
  p.grip.dispatch('dblclick', {});
  assert.equal(p.height(), 72, 'double-click restores the default height');
  assert.equal(p.store.get('f2a.logHeight'), '72');
}

// Shrinking the AE panel re-clamps the remembered height instead of overflowing.
{
  const p = panel({ stored: 300 });
  assert.equal(p.height(), 300);
  p.state.innerHeight = 300;
  p.window.dispatch('resize', {});
  assert.equal(p.height(), 300 - 12 - 200, 'the panel resize pulls the console back into range');
}

// Releasing outside the grip must not throw when pointer capture is unavailable.
{
  const p = panel();
  p.window.dispatch('pointermove', { clientY: 200 });
  p.window.dispatch('pointerup', {});
  assert.equal(p.height(), 72, 'a move without a pending drag is ignored');
}

// Sticky-drag safeguards: moving with buttons === 0, window blur, mouseup fallback, and iframe suppression.
{
  const p = panel();
  assert.match(css, /body\.mk-log-dragging iframe\{pointer-events:none !important;?\}/, 'iframe must not swallow pointerup while dragging');
  p.grip.dispatch('pointerdown', { button: 0, clientY: 300, pointerId: 1 });
  assert.ok(p.bodyEl.classList.contains('mk-log-dragging'), 'dragging marks body so embedded iframes ignore pointer events');
  p.window.dispatch('pointermove', { clientY: 250, buttons: 1 });
  assert.equal(p.height(), 122);
  // Simulate pointerup swallowed outside/over host: next pointermove arrives with buttons === 0
  p.window.dispatch('pointermove', { clientY: 190, buttons: 0 });
  assert.equal(p.height(), 122, 'releasing the button outside the panel stops the drag immediately');
  assert.equal(p.consoleEl.classList.contains('is-resizing'), false);
  assert.equal(p.bodyEl.classList.contains('mk-log-dragging'), false);

  // Blur (focus switch to AE) and lostpointercapture / mouseup also cleanly end drag
  p.grip.dispatch('pointerdown', { button: 0, clientY: 300, pointerId: 2 });
  p.window.dispatch('pointermove', { clientY: 260, buttons: 1 });
  assert.equal(p.height(), 162);
  p.window.dispatch('blur', {});
  p.window.dispatch('pointermove', { clientY: 200, buttons: 1 });
  assert.equal(p.height(), 162, 'window blur terminates active drag');

  p.grip.dispatch('pointerdown', { button: 0, clientY: 300, pointerId: 3 });
  p.window.dispatch('mouseup', {});
  p.window.dispatch('pointermove', { clientY: 200, buttons: 1 });
  assert.equal(p.height(), 162, 'mouseup fallback terminates active drag');
}

console.log('PASS: resizable log console — default height, drag/store, min/max clamps, collapse, restore, keyboard, double-click and panel-resize re-clamp');
