/**
 * Behavioural smoke test for dsh-spotlight's client half.
 *
 * The bundle is a browser module in the `window.__ModuleLoader__.load({id,
 * factory})` shape, so this test evaluates it in a VM with the smallest DOM,
 * React, and Cordis-context doubles the module actually touches. It verifies
 * the two contracts that matter for boot and for the palette itself:
 *
 *  - applying the plugin registers exactly one owned stylesheet, one locale
 *    namespace, the built-in commands, the `spotlight` service, the keyboard
 *    listener, and one `shell.overlay` entry without throwing;
 *  - the registered component renders, filters, runs a command, and closes.
 *
 * Run with `npm test`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

/* ------------------------------------------------------------------ *
 * Minimal browser doubles.
 * ------------------------------------------------------------------ */
function createDocument() {
  const styleTags = [];
  const listeners = new Map();
  const activeElement = { focus() { this.focused = true; }, focused: false };
  const document = {
    activeElement,
    modal: null,
    dispatched: [],
    menuOpen: false,
    menuClicks: 0,
    settingsOpened: false,
    sidebarClicks: 0,
    sidebarScope: {
      querySelectorAll(selector) {
        if (selector !== 'button') return [];
        return [
          {
            getAttribute(name) { return name === 'aria-label' ? '搜索会话' : null; },
            click() { document.sidebarClicks += 1; },
          },
          {
            getAttribute(name) { return name === 'aria-label' ? '添加工作区' : null; },
            click() { document.sidebarClicks += 1; },
          },
        ];
      },
    },
    launcher: {
      click() { document.menuOpen = true; },
    },
    menu: {
      innerText: '设置\n⌥\n⌘\n,',
      click() { document.menuClicks += 1; document.settingsOpened = true; document.menuOpen = false; },
    },
    body: {
      dispatchEvent(event) { document.dispatched.push(event); return true; },
    },
    head: {
      appendChild(node) { if (node && node.tagName === 'STYLE') styleTags.push(node); },
    },
    querySelector(selector) {
      if (selector.includes('settings.launcher')) return document.launcher;
      if (selector.includes('sidebar.workspaces')) return document.sidebarScope;
      if (selector.includes('settings.section')) return document.settingsOpened ? {} : null;
      if (selector.includes('aria-modal')) return document.modal;
      const match = /^style\[data-plugin-css="(.+)"\]$/.exec(selector);
      if (!match) return null;
      return styleTags.find((tag) => tag.dataset.pluginCss === match[1]) ?? null;
    },
    querySelectorAll(selector) {
      return selector === '[role="menuitem"]' && document.menuOpen ? [document.menu] : [];
    },
    createElement(tagName) {
      return {
        tagName: String(tagName).toUpperCase(),
        dataset: {},
        textContent: '',
        remove() { const index = styleTags.indexOf(this); if (index >= 0) styleTags.splice(index, 1); },
      };
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    removeEventListener(type, listener) {
      const rows = listeners.get(type) ?? [];
      const index = rows.indexOf(listener);
      if (index >= 0) rows.splice(index, 1);
    },
    dispatchKey(event) {
      for (const listener of [...(listeners.get('keydown') ?? [])]) listener(event);
    },
    keydownListeners: () => listeners.get('keydown') ?? [],
    styleTags,
  };
  return document;
}

/**
 * Hook-aware function-component renderer: state, refs, callbacks, and effects
 * with dependency comparison. It is intentionally tiny; it exists to execute
 * the palette code path, not to emulate React.
 */
function createRenderer() {
  const hooks = [];
  let cursor = 0;
  let pending = [];

  const React = {
    createElement(type, props, ...children) {
      const merged = { ...(props ?? {}) };
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      return { type, props: merged };
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = hooks[index];
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useCallback(fn) { return fn; },
    useEffect(fn, deps) {
      const index = cursor++;
      const previous = hooks[index];
      const changed = !previous
        || !deps
        || !previous.deps
        || deps.length !== previous.deps.length
        || deps.some((value, i) => !Object.is(value, previous.deps[i]));
      if (changed) pending.push({ index, fn, deps, previous });
    },
  };

  function commit() {
    for (const row of pending) {
      if (row.previous && typeof row.previous.cleanup === 'function') row.previous.cleanup();
    }
    for (const row of pending) {
      const cleanup = row.fn();
      hooks[row.index] = {
        ...(hooks[row.index] ?? {}),
        deps: row.deps,
        cleanup: typeof cleanup === 'function' ? cleanup : undefined,
      };
    }
    pending = [];
  }

  function render(element) {
    if (element === null || element === undefined || typeof element === 'boolean') return null;
    if (typeof element === 'string' || typeof element === 'number') return String(element);
    if (typeof element.type === 'function') {
      cursor = 0;
      const output = element.type(element.props);
      commit();
      return render(output);
    }
    return element;
  }

  function collect(element, out = []) {
    if (element === null || element === undefined) return out;
    if (typeof element === 'string') { out.push({ text: element }); return out; }
    out.push(element);
    const children = element.props?.children;
    if (Array.isArray(children)) for (const child of children) collect(child, out);
    else collect(children, out);
    return out;
  }

  return { React, render, collect };
}

/* ------------------------------------------------------------------ *
 * Service and context doubles.
 * ------------------------------------------------------------------ */
function makeContext(document, renderer) {
  const calls = {
    provide: [],
    localeRegister: [],
    setLocale: [],
    setTheme: [],
    selectPanel: [],
    toggleSidebar: 0,
    startSession: 0,
    registeredSlots: [],
    shortcutRegister: [],
    shortcutInvoke: [],
    commandsExecute: [],
    archiveSession: [],
    effects: [],
    slotSubscriptions: [],
    settingsSectionOpen: [],
  };

  /* The settings shell double: what `sidebar.settings` entries expose, with
   * the same `actions.openSection(id)` face the real shell's store has. */
  const settingsShell = {
    actions: {
      openSection(id) { calls.settingsSectionOpen.push(id); },
    },
  };
  const slotEntries = new Map([
    ['sidebar.settings', [{ store: { create: () => settingsShell } }]],
    ['settings.section', [
      { options: { id: 'general', order: 0, label: '通用' } },
      { options: { id: 'models', order: 1, label: () => '模型' } },
    ]],
  ]);

  const dictionaries = new Map();
  const locale = {
    active: 'zh',
    register(ns, localeOrDicts, dict) {
      calls.localeRegister.push([ns, localeOrDicts, dict]);
      const pairs = typeof localeOrDicts === 'string' ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts);
      for (const [id, entries] of pairs) dictionaries.set(id, { ...(dictionaries.get(id) ?? {}), ...entries });
      return () => { for (const [id] of pairs) dictionaries.delete(id); };
    },
    bind() {
      return (key) => {
        const dict = dictionaries.get(locale.active) ?? dictionaries.get('en') ?? {};
        return dict[key] ?? key;
      };
    },
    setLocale(id) { calls.setLocale.push(id); },
  };
  dictionaries.set('zh', {});

  const theme = { setTheme(id) { calls.setTheme.push(id); } };
  const layout = {
    selectPanel(id) {
      if (id !== 'plugins') throw new Error(`layout.selectPanel: main panel "${id}" is not registered`);
      calls.selectPanel.push(id);
    },
    toggleSidebar() { calls.toggleSidebar += 1; },
  };
  const shortcuts = {
    // Mirrors the shipped service: catalog + internal registry, no `invoke` method.
    platform: 'macos',
    runtime: 'web',
    catalog: {
      getSnapshot: () => [
        { id: 'settings.open', label: '打开设置', binding: { code: 'Comma', modifiers: ['meta', 'alt'] }, aria: 'Option+Command+,' },
        { id: 'shortcuts.open', label: '快捷键速查', binding: { code: 'Slash', modifiers: ['meta'] }, aria: 'Command+/' },
        {
          id: 'session.archive',
          label: '归档会话',
          aliases: ['archive session'],
          aria: 'Shift+Command+A',
          keys: ['⇧', '⌘', 'A'],
          binding: { code: 'KeyA', modifiers: ['meta', 'shift'] },
        },
        {
          id: 'sidebar.right.toggle',
          label: '展开/收起右侧栏',
          aliases: ['right sidebar'],
          aria: 'Shift+Command+B',
          binding: { code: 'KeyB', modifiers: ['meta', 'shift'] },
        },
        {
          id: 'workspace.files',
          label: '工作区文件',
          aliases: ['workspace files'],
          aria: 'Option+Command+P',
          binding: { code: 'KeyP', modifiers: ['meta', 'alt'] },
        },
        {
          id: 'session.fork',
          label: '分叉会话',
          aliases: ['fork session'],
          aria: 'Shift+Command+F',
          binding: { code: 'KeyF', modifiers: ['meta', 'shift'] },
        },
        { id: 'page.close', label: '关闭当前页面', aria: 'Option+Command+W', binding: { code: 'KeyW', modifiers: ['meta', 'alt'] } },
        { id: 'browser.refresh', label: '刷新', aria: 'Command+R', binding: { code: 'KeyR', modifiers: ['meta'] } },
      ],
      subscribe(listener) { calls.catalogSubscribers = [...(calls.catalogSubscribers ?? []), listener]; return () => { /* unsubscribe */ }; },
    },
    registry: {
      invoke(id, context) { calls.shortcutInvoke.push([id, context]); },
    },
    register(command) {
      calls.shortcutRegister.push(command);
      return () => { /* remove one command */ };
    },
  };
  const uiWorkspace = {
    startSession() { calls.startSession += 1; },
    selection: { getSnapshot: () => ({ sessionId: 'session-test' }) },
    archiveSession(id) { calls.archiveSession.push(id); return Promise.resolve(); },
  };
  const remote = {
    commands: {
      execute(sessionId, line, attachments) {
        calls.commandsExecute.push([sessionId, line, attachments]);
        return Promise.resolve({ ok: true });
      },
    },
  };

  const services = new Map([
    ['locale', locale],
    ['theme', theme],
    ['layout', layout],
    ['shortcuts', shortcuts],
    ['uiWorkspace', uiWorkspace],
    ['remote', remote],
  ]);

  const ctx = {
    get(name) { return services.get(name); },
    provide(name, value) {
      calls.provide.push([name, value]);
      return () => { calls.provide.pop(); };
    },
    effect(body, label) {
      const dispose = body();
      const row = { label, dispose };
      calls.effects.push(row);
      return () => { void dispose; };
    },
    slots: {
      inject(key, callback) {
        const dispose = callback();
        return () => { if (typeof dispose === 'function') dispose(); };
      },
      register(meta, component) {
        calls.registeredSlots.push({ meta, component });
        return () => { calls.registeredSlots.pop(); };
      },
      entries(name) { return slotEntries.get(name) ?? []; },
      subscribe(name, listener) {
        calls.slotSubscriptions.push([name, listener]);
        return () => { calls.slotSubscriptions = calls.slotSubscriptions.filter((row) => row[1] !== listener); };
      },
    },
  };

  return { ctx, calls, locale, theme, layout, shortcuts, uiWorkspace, renderer, document };
}

/* ------------------------------------------------------------------ *
 * Load the bundle.
 * ------------------------------------------------------------------ */
const document = createDocument();
const renderer = createRenderer();
const registrations = [];
const window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
class KeyboardEvent {
  constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
}

const sandbox = {
  window,
  document,
  React: renderer.React,
  KeyboardEvent,
  requestAnimationFrame: (fn) => { fn(); return 1; },
  cancelAnimationFrame() {},
  console,
  setTimeout,
  clearTimeout,
};
vm.runInNewContext(source, sandbox, { filename: 'client.js' });

assert.equal(registrations.length, 1, 'client.js registers exactly one module');
const module = registrations[0];
assert.equal(module.id, 'dsh-spotlight');
const plugin = module.factory((specifier) => {
  if (specifier === 'react') return renderer.React;
  throw new Error(`unexpected require: ${specifier}`);
});
assert.equal(typeof plugin.apply, 'function');
assert.deepEqual([...plugin.inject], ['slots']);

/* ------------------------------------------------------------------ *
 * Apply.
 * ------------------------------------------------------------------ */
const environment = makeContext(document, renderer);
assert.doesNotThrow(() => plugin.apply(environment.ctx), 'apply must not throw (the previous `styles is not defined` boot failure)');

assert.equal(document.styleTags.length, 1, 'apply injects exactly one owned stylesheet');
assert.equal(document.styleTags[0].dataset.pluginCss, 'dsh-spotlight/client.css');
assert.match(document.styleTags[0].textContent, /dsh-spotlight-panel/);

assert.equal(environment.calls.localeRegister.length, 1, 'dictionaries register once through the object form');
const [namespace, dictionaries] = environment.calls.localeRegister[0];
assert.equal(namespace, 'dsh-spotlight');
assert.ok(dictionaries.en && dictionaries.zh, 'both shipped locales are present');
assert.equal(dictionaries['zh-CN'], undefined, 'no undecodable zh-CN namespace is registered');

assert.equal(environment.calls.provide.length, 1);
assert.equal(environment.calls.provide[0][0], 'spotlight');
for (const method of ['register', 'list', 'open', 'close', 'toggle', 'isOpen']) {
  assert.equal(typeof environment.calls.provide[0][1][method], 'function', `spotlight.${method} is exposed`);
}

assert.equal(environment.calls.registeredSlots.length, 1, 'one shell.overlay entry is registered');
const slot = environment.calls.registeredSlots[0];
assert.equal(slot.meta.name, 'shell.overlay');
assert.equal(slot.meta.id, 'dsh-spotlight');
assert.equal(typeof slot.component, 'function');

assert.equal(document.keydownListeners().length, 1, 'one capture keydown listener is installed');

/* ------------------------------------------------------------------ *
 * Built-in commands.
 * ------------------------------------------------------------------ */
const spotlight = environment.calls.provide[0][1];

/* The palette opener is a real shortcut command, not only a raw listener. */
assert.equal(environment.calls.shortcutRegister.length, 1, 'one shell shortcut command is registered');
const openShortcut = environment.calls.shortcutRegister[0];
assert.equal(openShortcut.id, 'dsh-spotlight.open');
assert.equal(openShortcut.defaults['desktop:macos'].code, 'KeyP');
assert.equal(openShortcut.defaults['desktop:macos'].modifiers.join(','), 'primary,shift');
assert.equal(openShortcut.defaults['web:macos'].code, 'KeyP');
assert.equal(openShortcut.defaults['web:macos'].modifiers.join(','), 'primary,shift');
assert.equal(openShortcut.defaults['web:linux'], undefined, 'unsupported web:linux default is omitted, not rejected');
assert.match(openShortcut.label(), /Spotlight/);
assert.equal(openShortcut.regions.join(','), 'page,editable,terminal');
assert.equal(openShortcut.modals.join(','), 'other');
assert.equal(openShortcut.resolve({}).status, 'handled');
openShortcut.resolve({}).run();
assert.equal(spotlight.isOpen(), true, 'running the registered shortcut opens the palette');
openShortcut.resolve({}).run();
assert.equal(spotlight.isOpen(), false, 'running it again closes the palette');
const commands = spotlight.list();
for (const id of [
  'dsh-spotlight.open-settings',
  'dsh-spotlight.open-plugins',
  'dsh-spotlight.search-sessions',
  'dsh-spotlight.add-workspace',
  'dsh-spotlight.keyboard-shortcuts',
  'dsh-spotlight.new-session',
  'dsh-spotlight.compact-session',
  'dsh-spotlight.archive-session',
  'dsh-spotlight.toggle-rightbar',
  'dsh-spotlight.workspace-files',
  'dsh-spotlight.toggle-sidebar',
  'dsh-spotlight.theme-dark',
  'dsh-spotlight.theme-light',
  'dsh-spotlight.theme-system',
  'dsh-spotlight.locale-en',
  'dsh-spotlight.locale-zh',
]) {
  assert.ok(commands.some((command) => command.id === id), `command ${id} is registered`);
}

// The shortcut directory mirrors the remaining configurable shell commands.
assert.ok(commands.some((command) => command.id === 'dsh-spotlight.shortcut.session.fork'), 'remaining shortcuts are exposed');
for (const id of ['session.archive', 'sidebar.right.toggle', 'workspace.files']) {
  assert.ok(!commands.some((command) => command.id === `dsh-spotlight.shortcut.${id}`), `curated shortcut ${id} is not duplicated`);
}
assert.ok(!commands.some((command) => command.id === 'dsh-spotlight.shortcut.page.close'), 'window-closing shortcut stays out of the palette');
assert.ok(!commands.some((command) => command.id === 'dsh-spotlight.shortcut.browser.refresh'), 'page-refresh shortcut stays out of the palette');

/* Settings sections become one palette command each, localized by the shell's
 * own labels; running one opens the panel directly on that section. */
const sectionCommands = commands.filter((command) => command.id.startsWith('dsh-spotlight.settings-section.'));
assert.deepEqual([...sectionCommands.map((command) => command.title)], ['设置 → 通用', '设置 → 模型'], 'sections sort by order and resolve function labels');
assert.ok(sectionCommands.every((command) => command.keywords.includes('设置')), 'section commands carry settings keywords');
assert.ok(environment.calls.slotSubscriptions.some(([name]) => name === 'settings.section'), 'section catalog tracks slot declarations');

const run = (id) => commands.find((command) => command.id === id).run(environment.ctx);
run('dsh-spotlight.settings-section.models');
assert.deepEqual(environment.calls.settingsSectionOpen, ['models'], 'section command opens the settings store on that section');
const registry = environment.shortcuts.registry;
const invokeBefore = environment.calls.shortcutInvoke.length;
run('dsh-spotlight.open-settings');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(environment.calls.shortcutInvoke.length, invokeBefore + 1, 'Settings invokes the shell registry when available');
assert.equal(environment.calls.shortcutInvoke.at(-1)[0], 'settings.open');

// Without the registry, Web replays the effective binding.
environment.shortcuts.registry = undefined;
const dispatchedBefore = document.dispatched.length;
run('dsh-spotlight.open-settings');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(document.dispatched.length, dispatchedBefore + 1, 'Settings falls back to the shell binding on Web');
assert.equal(document.dispatched.at(-1).code, 'Comma');
assert.equal(document.dispatched.at(-1).metaKey, true);
assert.equal(document.dispatched.at(-1).altKey, true);

// The Desktop shell dispatches configurable commands from its native bridge,
// so without the registry the synthetic path is skipped and the launcher is used.
environment.shortcuts.runtime = 'desktop';
run('dsh-spotlight.open-settings');
await new Promise((resolve) => setTimeout(resolve, 80));
assert.equal(document.menuClicks, 1, 'Desktop opens Settings through the shell launcher menu');
assert.equal(document.settingsOpened, true);

// Back on Web, the Keyboard Shortcuts command replays `shortcuts.open`.
environment.shortcuts.runtime = 'web';
const keyboardDispatchedBefore = document.dispatched.length;
run('dsh-spotlight.keyboard-shortcuts');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(document.dispatched.length, keyboardDispatchedBefore + 1, 'Keyboard Shortcuts replays the shell binding');
assert.equal(document.dispatched.at(-1).code, 'Slash');
assert.equal(document.dispatched.at(-1).metaKey, true);
environment.shortcuts.registry = registry;
const keyboardInvokeBefore = environment.calls.shortcutInvoke.length;
run('dsh-spotlight.keyboard-shortcuts');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(environment.calls.shortcutInvoke.length, keyboardInvokeBefore + 1, 'Keyboard Shortcuts invokes the shell registry');
assert.equal(environment.calls.shortcutInvoke.at(-1)[0], 'shortcuts.open');
run('dsh-spotlight.open-plugins');
assert.deepEqual(environment.calls.selectPanel, ['plugins'], 'Plugins selects the registered main panel');
run('dsh-spotlight.search-sessions');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(document.sidebarClicks, 1, 'Search Sessions activates the sidebar search control');
run('dsh-spotlight.add-workspace');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(document.sidebarClicks, 2, 'Add Workspace activates the sidebar add control');

const invokedBefore = environment.calls.shortcutInvoke.length;
run('dsh-spotlight.archive-session');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(environment.calls.shortcutInvoke.length, invokedBefore + 1, 'Archive Current Session invokes the shell registry');
assert.equal(environment.calls.shortcutInvoke.at(-1)[0], 'session.archive');
assert.equal(environment.calls.shortcutInvoke.at(-1)[1].modal, null);

run('dsh-spotlight.toggle-rightbar');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(environment.calls.shortcutInvoke.at(-1)[0], 'sidebar.right.toggle');

run('dsh-spotlight.workspace-files');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(environment.calls.shortcutInvoke.at(-1)[0], 'workspace.files');

run('dsh-spotlight.shortcut.session.fork');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(environment.calls.shortcutInvoke.at(-1)[0], 'session.fork', 'a mirrored shortcut invokes the shell registry');

run('dsh-spotlight.compact-session');
await new Promise((resolve) => setTimeout(resolve, 20));
const compactCall = environment.calls.commandsExecute.at(-1);
assert.equal(compactCall[0], 'session-test');
assert.equal(compactCall[1], '/compact');
assert.equal(compactCall[2].length, 0, 'compact executes without attachments');

run('dsh-spotlight.new-session');
assert.equal(environment.calls.startSession, 1);
run('dsh-spotlight.toggle-sidebar');
assert.equal(environment.calls.toggleSidebar, 1);
run('dsh-spotlight.theme-dark');
run('dsh-spotlight.theme-light');
run('dsh-spotlight.theme-system');
assert.deepEqual(environment.calls.setTheme, ['dark', 'light', 'system'], 'all three theme preferences are reachable');
run('dsh-spotlight.locale-en');
run('dsh-spotlight.locale-zh');
assert.deepEqual(environment.calls.setLocale, ['en', 'zh'], 'the Chinese locale id is the registered `zh`, not `zh-CN`');

/* ------------------------------------------------------------------ *
 * Keyboard.
 * ------------------------------------------------------------------ */
function key(overrides) {
  let prevented = false;
  let stopped = false;
  document.dispatchKey({
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    target: { tagName: 'BODY' },
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
    ...overrides,
  });
  return { prevented, stopped };
}

let result = key({ key: '?', code: 'Slash', metaKey: true, shiftKey: true });
assert.ok(spotlight.isOpen(), 'Cmd+Shift+Slash opens the palette');
assert.ok(result.prevented && result.stopped);
key({ key: 'Escape' });
assert.equal(spotlight.isOpen(), false, 'Escape closes it');

result = key({ key: '/', code: 'Slash' });
assert.ok(spotlight.isOpen(), 'bare / opens it outside a typing target');
assert.ok(result.prevented);
key({ key: 'Escape' });

key({ key: '/', code: 'Slash', target: { tagName: 'INPUT' } });
assert.equal(spotlight.isOpen(), false, 'bare / does not steal input typing');

// A modal layer marks the app inert; opening the palette there would put a
// visible input in a subtree that cannot take focus.
document.modal = { role: 'dialog' };
result = key({ key: '?', code: 'Slash', metaKey: true, shiftKey: true });
assert.equal(spotlight.isOpen(), false, 'the shortcut is ignored while a modal is open');
assert.equal(result.prevented, false);
document.modal = null;

/* ------------------------------------------------------------------ *
 * Rendering, filtering, and execution.
 * ------------------------------------------------------------------ */
spotlight.open();
const slotElement = slot.component({});
assert.equal(typeof slotElement.type, 'function', 'the slot renders the Palette component, not its return value');
let tree = renderer.collect(renderer.render(slotElement));
let input = tree.find((node) => node.type === 'input' && node.props.className === 'dsh-spotlight-input');
assert.ok(input, 'the palette renders its search input');

// Nested function components are rendered by render(), so the tree is flat.
const classes = tree.map((node) => node.props?.className).filter(Boolean);
assert.ok(classes.includes('dsh-spotlight-panel'), 'the panel is rendered');

// Filter to the theme commands.
input.props.onChange({ target: { value: 'theme' } });
tree = renderer.collect(renderer.render(slotElement));
const items = tree.filter((node) => node.type === 'li' && String(node.props.className).includes('dsh-spotlight-item'));
assert.ok(items.length >= 3, 'filtering keeps the theme commands');
assert.ok(items.some((item) => renderer.collect(item).some((node) => node.text === '主题：深色')), 'the active locale dictionary supplies command titles');

// Run the highlighted command; the first filtered row is Theme: Dark.
const before = environment.calls.setTheme.length;
items[0].props.onClick();
assert.equal(environment.calls.setTheme.length, before + 1, 'clicking a row runs its command');
assert.equal(environment.calls.setTheme.at(-1), 'dark');
assert.equal(spotlight.isOpen(), false, 'running a command closes the palette');

// Closed palette renders nothing.
assert.equal(renderer.render(slotElement), null);

/* ------------------------------------------------------------------ *
 * Re-apply (HMR / disable-enable) is idempotent for the stylesheet and
 * reusable for the locale namespace.
 * ------------------------------------------------------------------ */
const second = makeContext(document, renderer);
const secondGet = second.ctx.get.bind(second.ctx);
second.ctx.get = (name) => (name === 'locale' ? environment.locale : secondGet(name));
assert.doesNotThrow(() => plugin.apply(second.ctx), 'a re-apply must not throw');
assert.equal(document.styleTags.length, 1, 're-apply does not duplicate the stylesheet');
assert.equal(environment.calls.localeRegister.length, 1, 'a live namespace from the earlier mount is reused');

console.log('dsh-spotlight: client verification passed');
