window.__ModuleLoader__.load({
  id: 'dsh-spotlight',
  factory(require) {
    const React = require('react');
    const { useState, useEffect, useRef, useCallback } = React;
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-spotlight';
    /** Stable id for the one stylesheet this bundle owns. */
    const STYLE_ID = 'dsh-spotlight/client.css';

    /* ------------------------------------------------------------------ *
     * Module-level store: open state + command registry.
     * Other client plugins reach the same registry through the
     * 'spotlight' service this module provides on the shared context.
     * ------------------------------------------------------------------ */
    const listeners = new Set();
    const commands = new Map(); // id -> definition
    let open = false;
    /** True while replaying another command's shortcut; ignore our own handler. */
    let synthesizing = false;

    function notify() { for (const fn of [...listeners]) { try { fn(); } catch (e) { /* listener error isolated */ } } }
    const store = {
      isOpen: () => open,
      open() { if (!open) { open = true; notify(); } },
      close() { if (open) { open = false; notify(); } },
      toggle() { open ? store.close() : store.open(); },
      subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
      register(def) {
        if (!def || typeof def.id !== 'string' || !def.id) throw new Error('spotlight: command needs a non-empty id');
        if (typeof def.run !== 'function') throw new Error(`spotlight: command ${def.id} needs run()`);
        const entry = {
          ...def,
          group: typeof def.group === 'string' ? def.group : '',
          keywords: Array.isArray(def.keywords)
            ? def.keywords.filter((k) => typeof k === 'string' || typeof k === 'number').map(String)
            : [],
          title: typeof def.title === 'string' ? def.title : undefined,
          hint: typeof def.hint === 'string' ? def.hint : '',
        };
        commands.set(entry.id, entry);
        notify();
        return () => {
          // Only the registration that still owns the id may remove it.
          if (commands.get(entry.id) === entry) { commands.delete(entry.id); notify(); }
        };
      },
      list: () => Array.from(commands.values()),
    };

    /* ------------------------------------------------------------------ *
     * Small helpers around optional client services.
     * ------------------------------------------------------------------ */
    function svc(ctx, name) { try { return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined; } catch (e) { return undefined; } }

    function isTypingTarget(target) {
      if (!target || typeof target !== 'object') return false;
      const tag = String(target.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (target.isContentEditable === true) return true;
      try {
        return typeof target.closest === 'function'
          && target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null;
      } catch (e) { return false; }
    }

    function selectPanel(ctx, candidates) {
      const layout = svc(ctx, 'layout');
      if (!layout || typeof layout.selectPanel !== 'function') return false;
      for (const id of candidates) {
        try { layout.selectPanel(id); return true; } catch (e) { /* try next id */ }
      }
      return false;
    }

    /**
     * Whether a modal layer is open. The shell's own shortcut dispatcher
     * blocks background commands behind `[aria-modal]`; this plugin's raw
     * listener must apply the same rule, because a modal marks the rest of
     * the tree inert and the palette input could not take focus.
     */
    function modalOpen() {
      if (typeof document === 'undefined') return false;
      try { return document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]') !== null; } catch (e) { return false; }
    }

    /**
     * Open the Settings surface. Settings is a sidebar surface, not a `main`
     * panel, so `layout.selectPanel('settings')` is expected to throw.
     *
     * The shell owns a `settings.open` shortcut command, but the shortcut
     * service exposes its catalog rather than an invoke method. Reproduce the
     * effective user binding as one synthetic keyboard event so the shell's
     * own dispatcher runs the command, including the user's custom binding and
     * modal policy. Dispatch is deferred by one task because the palette is
     * itself an `aria-modal` layer while it closes; dispatching synchronously
     * would be blocked by that modal.
     */
    function openSettings(ctx) {
      if (invokeShortcut(ctx, 'settings.open')) return true;
      const shortcuts = svc(ctx, 'shortcuts');
      if (shortcuts && typeof shortcuts.invoke === 'function') {
        try {
          shortcuts.invoke('settings.open', {
            region: 'page',
            modal: null,
            element: typeof document !== 'undefined' ? document.activeElement : null,
          });
          return true;
        } catch (e) { /* fall through to the catalog binding */ }
      }
      if (shortcuts) {
        try {
          const catalog = shortcuts.catalog && typeof shortcuts.catalog.getSnapshot === 'function'
            ? shortcuts.catalog.getSnapshot()
            : [];
          const row = Array.isArray(catalog) ? catalog.find((entry) => entry && entry.id === 'settings.open') : undefined;
          if (row && row.binding && row.binding.code && row.binding.secondCode === undefined) {
            // The Desktop shell dispatches configurable commands from its native
            // keyboard bridge, not from DOM keydown, so a synthetic event only
            // works on Web. Fall through to the launcher path on Desktop.
            if (shortcuts.runtime !== 'desktop' && dispatchBinding(row.binding, shortcuts)) return true;
          }
        } catch (e) { /* fall through to the launcher probe */ }
      }
      if (openSettingsThroughLauncher()) return true;
      return selectPanel(ctx, ['settings', 'preference', 'preferences']);
    }

    /**
     * Open the shell's keyboard-shortcut reference. Web can replay the
     * `shortcuts.open` binding; Desktop cannot consume a synthetic event, so it
     * opens Settings through the launcher and selects the Shortcuts section.
     */
    function openShortcuts(ctx) {
      if (invokeShortcut(ctx, 'shortcuts.open')) return true;
      const shortcuts = svc(ctx, 'shortcuts');
      if (shortcuts) {
        try {
          const catalog = shortcuts.catalog && typeof shortcuts.catalog.getSnapshot === 'function'
            ? shortcuts.catalog.getSnapshot()
            : [];
          const row = Array.isArray(catalog) ? catalog.find((entry) => entry && entry.id === 'shortcuts.open') : undefined;
          if (row && row.binding && row.binding.code && row.binding.secondCode === undefined) {
            if (shortcuts.runtime !== 'desktop' && dispatchBinding(row.binding, shortcuts)) return true;
          }
        } catch (e) { /* fall through to the settings section */ }
      }
      return openSettingsThroughLauncher(/^(快捷键|keyboard shortcuts)/i);
    }

    /**
     * Desktop fallback: open the shell's account/settings menu and select its
     * Settings row. `settings.launcher` is the shell-owned slot; the row text is
     * localized by the same settings shell (`Settings` / `设置`) and carries the
     * shortcut keycaps, so match the leading label only.
     */
    function openSettingsThroughLauncher(section) {
      if (typeof document === 'undefined') return false;
      const launcher = document.querySelector('[data-slot="settings.launcher"] button, [data-slot="settings.launcher"] [role="button"]');
      if (!launcher || typeof launcher.click !== 'function') return false;
      let attempts = 0;
      const selectSection = () => {
        try {
          const dialogs = [...document.querySelectorAll('[role="dialog"]')];
          const candidates = dialogs.flatMap((dialog) => [...dialog.querySelectorAll('button, a, [role="tab"], [role="menuitem"], [role="button"]')]);
          const target = candidates.find((element) => section.test(String(element.innerText || '').trim()));
          if (target) { target.click(); return; }
        } catch (e) { /* keep polling while the settings panel mounts */ }
        attempts += 1;
        if (attempts < 20 && typeof setTimeout === 'function') setTimeout(selectSection, 25);
      };
      const select = () => {
        try {
          if (document.querySelector('[data-slot="settings.section"]')) {
            if (section && typeof setTimeout === 'function') setTimeout(selectSection, 0);
            return;
          }
          const items = [...document.querySelectorAll('[role="menuitem"]')];
          const item = items.find((element) => /^(Settings|设置)(\n|$)/.test(String(element.innerText || '').trim()));
          if (item) {
            item.click();
            if (section && typeof setTimeout === 'function') setTimeout(selectSection, 0);
            return;
          }
        } catch (e) { /* keep polling while the menu mounts */ }
        attempts += 1;
        if (attempts < 20) { if (typeof setTimeout === 'function') setTimeout(select, 25); return; }
        // Close the menu this fallback opened when it never produced Settings.
        try {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
        } catch (e) { /* nothing else to do */ }
      };
      const open = () => {
        try { launcher.click(); } catch (e) { return; }
        if (typeof setTimeout === 'function') setTimeout(select, 0);
        else select();
      };
      if (typeof setTimeout === 'function') setTimeout(open, 0);
      else open();
      return true;
    }

    /**
     * Click a control owned by the Workspace sidebar. The sidebar exposes
     * these actions as buttons with a localized `aria-label` (and sometimes a
     * title), so match either shipped wording and defer one task to let the
     * palette overlay unmount first. This is the Desktop-safe path for
     * actions that have no public client service.
     */
    function clickSidebarButton(pattern) {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return false;
      const scope = (function () {
        try { return document.querySelector('[data-slot="sidebar.workspaces"]') || document; } catch (e) { return document; }
      })();
      if (!scope || typeof scope.querySelectorAll !== 'function') return false;
      let button;
      try {
        button = [...scope.querySelectorAll('button')].find((element) => {
          const text = String(element.getAttribute('aria-label') || element.getAttribute('title') || '').trim();
          return text !== '' && pattern.test(text);
        });
      } catch (e) { return false; }
      if (!button) return false;
      const click = () => { try { button.click(); } catch (e) { /* element went away */ } };
      if (typeof setTimeout === 'function') setTimeout(click, 0);
      else click();
      return true;
    }

    /**
     * The on-screen Session id. `uiWorkspace.selection` is the authoritative
     * selection; `sidebarRight.mounted` is the same id from the surface that
     * owns the right column, and covers compositions where the Workspace
     * service is absent.
     */
    function currentSessionId(ctx) {
      try {
        const selected = svc(ctx, 'uiWorkspace')?.selection?.getSnapshot?.();
        if (selected && typeof selected.sessionId === 'string' && selected.sessionId) return selected.sessionId;
      } catch (e) { /* fall through to the sidebar surface */ }
      try {
        const mounted = svc(ctx, 'sidebarRight')?.mounted?.getSnapshot?.();
        if (typeof mounted === 'string' && mounted) return mounted;
      } catch (e) { /* no current session */ }
      return undefined;
    }

    /**
     * Execute one registered shortcut command through the shell's own
     * registry. This is the cross-platform equivalent of pressing its
     * keybinding: it works on Desktop (where DOM key events do not reach
     * configurable commands) and on Web. The registry is an implementation
     * detail of the shortcuts service, so every step is guarded and the Web
     * synthetic-event path remains as a fallback for versions without it.
     */
    function invokeShortcut(ctx, id) {
      const shortcuts = svc(ctx, 'shortcuts');
      if (!shortcuts || typeof id !== 'string' || id === '') return false;
      let known = true;
      try {
        const catalog = shortcuts.catalog && typeof shortcuts.catalog.getSnapshot === 'function'
          ? shortcuts.catalog.getSnapshot()
          : undefined;
        if (Array.isArray(catalog)) known = catalog.some((entry) => entry && entry.id === id);
      } catch (e) { /* regard an unreadable catalog as available */ }
      if (!known) return false;
      const registry = shortcuts.registry;
      if (registry && typeof registry.invoke === 'function') {
        const run = () => {
          try {
            const target = typeof document !== 'undefined' ? document.activeElement : undefined;
            registry.invoke(id, {
              region: 'page',
              modal: null,
              target,
              element: target,
              source: 'spotlight',
            });
          } catch (e) {
            try { console.warn('dsh-spotlight: shortcut invocation failed', id, e); } catch (_) { /* ignore */ }
          }
        };
        if (typeof setTimeout === 'function') setTimeout(run, 0);
        else run();
        return true;
      }
      try {
        const catalog = shortcuts.catalog && typeof shortcuts.catalog.getSnapshot === 'function'
          ? shortcuts.catalog.getSnapshot()
          : [];
        const row = Array.isArray(catalog) ? catalog.find((entry) => entry && entry.id === id) : undefined;
        if (row && row.binding && row.binding.code && row.binding.secondCode === undefined) {
          if (shortcuts.runtime !== 'desktop' && dispatchBinding(row.binding, shortcuts)) return true;
        }
      } catch (e) { /* no fallback available */ }
      return false;
    }

    /**
     * `/compact` is a Host command, not a client shortcut. Execute it through
     * the same `remote.commands` transaction the composer uses for the current
     * Session; the Host reports an error when the agent is busy.
     */
    function compactCurrent(ctx) {
      const sessionId = currentSessionId(ctx);
      if (!sessionId) return false;
      const execute = (scope) => {
        let commands;
        try {
          const remote = svc(scope, 'remote');
          commands = remote && remote.commands;
        } catch (e) { return; }
        if (!commands || typeof commands.execute !== 'function') return;
        try {
          const task = commands.execute(sessionId, '/compact', []);
          if (task && typeof task.then === 'function') {
            task.then((result) => {
              if (result && result.ok === false) {
                try { console.warn('dsh-spotlight: compact failed', result.error); } catch (_) { /* ignore */ }
              }
            }, (error) => {
              try { console.warn('dsh-spotlight: compact failed', error); } catch (_) { /* ignore */ }
            });
          }
        } catch (e) {
          try { console.warn('dsh-spotlight: compact failed', e); } catch (_) { /* ignore */ }
        }
      };
      // `remote` is a guarded service: accessing `remote.commands` requires
      // declaring it. Wait for it on a child context instead of adding it to
      // the whole plugin (the palette must work without the remote lane).
      if (typeof ctx.inject === 'function') {
        try { ctx.inject(['remote'], execute); return true; } catch (e) { /* fall through */ }
      }
      execute(ctx);
      return true;
    }

    /** Archive the on-screen Session; the shell shortcut adds its confirmation. */
    function archiveCurrent(ctx) {
      if (invokeShortcut(ctx, 'session.archive')) return true;
      const sessionId = currentSessionId(ctx);
      const workspace = svc(ctx, 'uiWorkspace');
      if (!sessionId || !workspace || typeof workspace.archiveSession !== 'function') return false;
      try {
        const task = workspace.archiveSession(sessionId);
        if (task && typeof task.catch === 'function') task.catch((error) => {
          try { console.warn('dsh-spotlight: archive failed', error); } catch (_) { /* ignore */ }
        });
        return true;
      } catch (e) {
        try { console.warn('dsh-spotlight: archive failed', e); } catch (_) { /* ignore */ }
        return false;
      }
    }

    /** Toggle the right column, using the shell shortcut or its controller. */
    function toggleRightSidebar(ctx) {
      if (invokeShortcut(ctx, 'sidebar.right.toggle')) return true;
      const sidebar = svc(ctx, 'sidebarRight');
      if (!sidebar || typeof sidebar.toggleExpanded !== 'function') return false;
      try { sidebar.toggleExpanded(); return true; } catch (e) { return false; }
    }

    /** Open the workspace files page in the right column. */
    function openWorkspaceFiles(ctx) {
      if (invokeShortcut(ctx, 'workspace.files')) return true;
      const sidebar = svc(ctx, 'sidebarRight');
      if (!sidebar || typeof sidebar.commandTarget !== 'function' || typeof sidebar.openTabFromTarget !== 'function') return false;
      try {
        const target = sidebar.commandTarget(typeof document !== 'undefined' ? document.activeElement : undefined);
        if (target === undefined) return false;
        sidebar.openTabFromTarget('files', target);
        return true;
      } catch (e) { return false; }
    }

    /** Extra search terms for mirrored shortcuts whose catalog labels are English. */
    const SHORTCUT_KEYWORDS = {
      'session.rename': ['重命名', '改名', 'rename'],
      'session.fork': ['分叉', '复制', 'fork'],
      'pane.split': ['分栏', '拆分', 'split'],
      'pane.fullscreen.toggle': ['全屏', 'fullscreen'],
      'terminal.new': ['终端', '新建终端', 'terminal'],
      'page.refresh': ['刷新', 'refresh'],
    };

    /** Shortcuts already represented by a first-class palette command. */
    const CURATED_SHORTCUT_IDS = new Set([
      'dsh-spotlight.open',
      'settings.open',
      'shortcuts.open',
      'session.new',
      'session.search',
      'workspace.add',
      'sidebar.left.toggle',
      'session.archive',
      'sidebar.right.toggle',
      'workspace.files',
      'browser.close',
      'browser.refresh',
      'page.close',
    ]);

    /**
     * Mirror the shell's configurable shortcut directory into a "Shortcuts"
     * group. Catalog rows are already localized and carry their effective
     * keycaps, so this is how actions with no public client service (archive,
     * fork, rename, right column, workspace files, split, fullscreen, …)
     * become runnable from the palette. The list refreshes with the catalog.
     */
    function installShortcutCommands(scope) {
      const shortcuts = svc(scope, 'shortcuts');
      if (!shortcuts || !shortcuts.catalog || typeof shortcuts.catalog.subscribe !== 'function') return undefined;
      const owned = new Map();
      const sync = () => {
        let rows;
        try { rows = shortcuts.catalog.getSnapshot(); } catch (e) { return; }
        const next = new Set();
        for (const row of Array.isArray(rows) ? rows : []) {
          if (!row || typeof row.id !== 'string' || !row.id) continue;
          if (CURATED_SHORTCUT_IDS.has(row.id) || row.id.indexOf('browser.') === 0) continue;
          if (/(^|\.)(delete|remove)(\.|$)/.test(row.id)) continue;
          const commandId = 'dsh-spotlight.shortcut.' + row.id;
          next.add(commandId);
          const previous = owned.get(commandId);
          if (previous) { try { previous(); } catch (e) { /* ignore */ } owned.delete(commandId); }
          const title = typeof row.label === 'string' && row.label ? row.label : row.id;
          const hint = Array.isArray(row.keys) && row.keys.length > 0
            ? row.keys.join(' ')
            : (typeof row.aria === 'string' ? row.aria : '');
          try {
            owned.set(commandId, store.register({
              id: commandId,
              title,
              groupKey: 'group.shortcuts',
              hint,
              keywords: [row.id, ...(Array.isArray(row.aliases) ? row.aliases : []), title, hint, ...(SHORTCUT_KEYWORDS[row.id] || [])].filter(Boolean),
              run: (c) => { invokeShortcut(c, row.id); },
            }));
          } catch (e) {
            try { console.warn('dsh-spotlight: cannot expose shortcut', row.id, e); } catch (_) { /* ignore */ }
          }
        }
        for (const [commandId, dispose] of [...owned]) {
          if (next.has(commandId)) continue;
          try { dispose(); } catch (e) { /* ignore */ }
          owned.delete(commandId);
        }
      };
      let unsubscribe;
      try { unsubscribe = shortcuts.catalog.subscribe(sync); } catch (e) { unsubscribe = undefined; }
      sync();
      return () => {
        if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (e) { /* ignore */ } }
        for (const dispose of owned.values()) { try { dispose(); } catch (e) { /* ignore */ } }
        owned.clear();
      };
    }

    /**
     * Send one synthetic keydown matching a catalog binding through the
     * shell's installed keyboard adapter. The adapter is a window listener and
     * deliberately does not require trusted events, so this reuses the real
     * dispatch path instead of duplicating the settings action.
     */
    function dispatchBinding(binding, shortcuts) {
      if (typeof window === 'undefined' || typeof KeyboardEvent !== 'function') return false;
      const modifiers = Array.isArray(binding.modifiers) ? binding.modifiers : [];
      const platform = shortcuts && typeof shortcuts.platform === 'string' ? shortcuts.platform : '';
      const primary = platform === 'macos' || platform === 'windows'
        ? (platform === 'macos' ? 'meta' : 'control')
        : (typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '') ? 'meta' : 'control');
      const has = (name) => modifiers.includes(name) || (name === primary && modifiers.includes('primary'));
      const keyOf = (code) => ({
        Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Backquote: '`',
        BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=',
      })[code] || '';
      const send = () => {
        try {
          const event = new KeyboardEvent('keydown', {
            code: binding.code,
            key: keyOf(binding.code),
            metaKey: has('meta'),
            ctrlKey: has('control'),
            altKey: has('alt'),
            shiftKey: has('shift'),
            bubbles: true,
            cancelable: true,
          });
          const target = typeof document !== 'undefined' && document.body ? document.body : window;
          synthesizing = true;
          try { target.dispatchEvent(event); } finally { synthesizing = false; }
        } catch (e) { synthesizing = false; /* a refused synthetic event leaves the command unavailable */ }
      };
      if (typeof setTimeout === 'function') { setTimeout(send, 0); return true; }
      send();
      return true;
    }

    /* ------------------------------------------------------------------ *
     * Built-in commands — registered through the same public registry
     * that other plugins use.
     * ------------------------------------------------------------------ */
    function registerBuiltinCommands(ctx) {
      const disposers = [];
      const add = (def) => disposers.push(store.register(def));

      add({
        id: 'dsh-spotlight.open-settings',
        titleKey: 'cmd.settings.title',
        title: 'Settings',
        groupKey: 'group.navigate',
        keywords: ['settings', 'preference', '设置', '偏好', 'shezhi'],
        run: (c) => { openSettings(c); },
      });
      add({
        id: 'dsh-spotlight.open-plugins',
        titleKey: 'cmd.plugins.title',
        title: 'Plugins',
        groupKey: 'group.navigate',
        keywords: ['plugins', 'bundle', '插件', '扩展', 'chajian'],
        run: (c) => { selectPanel(c, ['plugins', 'plugin']); },
      });
      add({
        id: 'dsh-spotlight.search-sessions',
        titleKey: 'cmd.searchSessions.title',
        title: 'Search Sessions',
        groupKey: 'group.navigate',
        keywords: ['search', 'session', 'find', '搜索', '会话', '查找', 'sousuo'],
        run: () => { clickSidebarButton(/^(搜索会话|search sessions?)/i); },
      });
      add({
        id: 'dsh-spotlight.add-workspace',
        titleKey: 'cmd.addWorkspace.title',
        title: 'Add Workspace',
        groupKey: 'group.navigate',
        keywords: ['workspace', 'add', 'folder', '工作区', '添加', '文件夹', 'gongzuoqu'],
        run: () => { clickSidebarButton(/^(添加工作区|add workspace)/i); },
      });
      add({
        id: 'dsh-spotlight.keyboard-shortcuts',
        titleKey: 'cmd.keyboardShortcuts.title',
        title: 'Keyboard Shortcuts',
        groupKey: 'group.navigate',
        keywords: ['shortcut', 'keyboard', 'keys', '快捷键', '键盘', 'kuaijie'],
        run: (c) => { openShortcuts(c); },
      });
      add({
        id: 'dsh-spotlight.new-session',
        titleKey: 'cmd.newSession.title',
        title: 'New Session',
        groupKey: 'group.session',
        keywords: ['new', 'session', 'chat', '新建', '会话', '对话', 'xinjian'],
        run: (c) => { const ws = svc(c, 'uiWorkspace'); if (ws && typeof ws.startSession === 'function') ws.startSession(); },
      });
      add({
        id: 'dsh-spotlight.compact-session',
        titleKey: 'cmd.compact.title',
        title: 'Compact Session',
        groupKey: 'group.session',
        keywords: ['compact', 'compress', 'summarize', 'history', '压缩', '摘要', '会话', 'yasuo'],
        run: (c) => { compactCurrent(c); },
      });
      add({
        id: 'dsh-spotlight.archive-session',
        titleKey: 'cmd.archive.title',
        title: 'Archive Current Session',
        groupKey: 'group.session',
        keywords: ['archive', 'session', '归档', '当前会话', '归档会话', 'guidang'],
        run: (c) => { archiveCurrent(c); },
      });
      add({
        id: 'dsh-spotlight.toggle-rightbar',
        titleKey: 'cmd.rightbar.title',
        title: 'Toggle Right Sidebar',
        groupKey: 'group.view',
        keywords: ['right', 'sidebar', 'panel', '右侧栏', '右边栏', '展开', '收起', 'youcelan'],
        run: (c) => { toggleRightSidebar(c); },
      });
      add({
        id: 'dsh-spotlight.workspace-files',
        titleKey: 'cmd.workspaceFiles.title',
        title: 'Workspace Files',
        groupKey: 'group.view',
        keywords: ['files', 'workspace', 'file', '工作区', '文件', 'wenjian'],
        run: (c) => { openWorkspaceFiles(c); },
      });
      add({
        id: 'dsh-spotlight.toggle-sidebar',
        titleKey: 'cmd.toggleSidebar.title',
        title: 'Toggle Sidebar',
        groupKey: 'group.view',
        keywords: ['sidebar', 'collapse', 'expand', '侧栏', '收起', '展开', 'celan'],
        run: (c) => { const layout = svc(c, 'layout'); if (layout && typeof layout.toggleSidebar === 'function') layout.toggleSidebar(); },
      });
      add({
        id: 'dsh-spotlight.theme-dark',
        titleKey: 'cmd.themeDark.title',
        title: 'Dark Theme',
        groupKey: 'group.appearance',
        keywords: ['dark', 'theme', '深色', '暗色', '主题', 'yans'],
        run: (c) => { const t = svc(c, 'theme'); if (t && typeof t.setTheme === 'function') t.setTheme('dark'); },
      });
      add({
        id: 'dsh-spotlight.theme-light',
        titleKey: 'cmd.themeLight.title',
        title: 'Light Theme',
        groupKey: 'group.appearance',
        keywords: ['light', 'theme', '浅色', '亮色', '主题', 'qianse'],
        run: (c) => { const t = svc(c, 'theme'); if (t && typeof t.setTheme === 'function') t.setTheme('light'); },
      });
      add({
        id: 'dsh-spotlight.theme-system',
        titleKey: 'cmd.themeSystem.title',
        title: 'System Theme',
        groupKey: 'group.appearance',
        keywords: ['system', 'auto', 'theme', '跟随系统', '自动', '主题', 'xitong'],
        run: (c) => { const t = svc(c, 'theme'); if (t && typeof t.setTheme === 'function') t.setTheme('system'); },
      });
      add({
        id: 'dsh-spotlight.locale-en',
        titleKey: 'cmd.localeEn.title',
        title: 'English',
        groupKey: 'group.appearance',
        keywords: ['language', 'english', '语言', '英文', 'yingwen'],
        run: (c) => { const l = svc(c, 'locale'); if (l && typeof l.setLocale === 'function') l.setLocale('en'); },
      });
      add({
        id: 'dsh-spotlight.locale-zh',
        titleKey: 'cmd.localeZh.title',
        title: '中文',
        groupKey: 'group.appearance',
        keywords: ['language', 'chinese', '语言', '中文', 'zhongwen'],
        run: (c) => { const l = svc(c, 'locale'); if (l && typeof l.setLocale === 'function') l.setLocale('zh'); },
      });

      return () => disposers.forEach((d) => { try { d(); } catch (e) { /* ignore one failed removal */ } });
    }

    /**
     * Register the palette opener as a real shell shortcut.
     *
     * `Cmd/Ctrl+Shift+/` cannot be the default on macOS: the system reserves
     * that combination for the Help menu's search field, so Electron/the menu
     * consumes it before the page sees a `keydown`. `Cmd/Ctrl+Shift+P` is the
     * command-palette convention and is free in this composition. Registering
     * through `ctx.shortcuts` (rather than a raw listener) also makes the
     * binding appear in Settings → Shortcuts, honor user overrides, and work
     * on Desktop, where configurable commands arrive through the native
     * keyboard bridge instead of DOM events.
     *
     * `modals: ['other']` lets the same shortcut close the palette on Web
     * (the palette is itself an unlabelled modal); `run` still refuses to open
     * while another modal owns the layer, so the inert-focus trap cannot be
     * bypassed.
     */
    function registerOpenShortcut(ctx) {
      const shortcuts = svc(ctx, 'shortcuts');
      if (!shortcuts || typeof shortcuts.register !== 'function') return undefined;
      const t = translator(svc(ctx, 'locale'));
      const defaults = {
        'desktop:macos': { code: 'KeyP', modifiers: ['primary', 'shift'] },
        'desktop:windows': { code: 'KeyP', modifiers: ['primary', 'shift'] },
        'desktop:linux': { code: 'KeyP', modifiers: ['primary', 'shift'] },
        'web:macos': { code: 'KeyP', modifiers: ['primary', 'shift'] },
        'web:windows': { code: 'KeyP', modifiers: ['primary', 'shift'] },
      };
      try {
        return shortcuts.register({
          id: 'dsh-spotlight.open',
          label: () => t('shortcut.open', 'Spotlight'),
          aliases: ['spotlight', 'command palette', '命令面板'],
          defaults,
          regions: ['page', 'editable', 'terminal'],
          modals: ['other'],
          resolve: () => ({
            status: 'handled',
            run: () => {
              if (!store.isOpen() && modalOpen()) return;
              store.toggle();
            },
          }),
        });
      } catch (e) {
        // A conflicting/reserved default must not take the whole plugin down;
        // the bare `/` listener and the palette commands keep working.
        try { console.warn('dsh-spotlight: shortcut registration failed; use / instead', e); } catch (_) { /* ignore */ }
        return undefined;
      }
    }

    /* ------------------------------------------------------------------ *
     * Locale dictionary for palette UI text and command titles.
     * ------------------------------------------------------------------ */
    const DICTS = {
      en: {
        'palette.placeholder': 'Type a command…',
        'palette.empty': 'No matching commands',
        'palette.hint': '↑↓ select · ↵ run · esc close',
        'shortcut.open': 'Spotlight',
        'group.navigate': 'Navigate',
        'group.session': 'Session',
        'group.view': 'View',
        'group.appearance': 'Appearance',
        'group.shortcuts': 'Shortcuts',
        'cmd.settings.title': 'Open Settings',
        'cmd.plugins.title': 'Open Plugins',
        'cmd.searchSessions.title': 'Search Sessions',
        'cmd.addWorkspace.title': 'Add Workspace',
        'cmd.keyboardShortcuts.title': 'Keyboard Shortcuts',
        'cmd.newSession.title': 'New Session',
        'cmd.compact.title': 'Compact Session',
        'cmd.archive.title': 'Archive Current Session',
        'cmd.rightbar.title': 'Toggle Right Sidebar',
        'cmd.workspaceFiles.title': 'Workspace Files',
        'cmd.toggleSidebar.title': 'Toggle Sidebar',
        'cmd.themeDark.title': 'Theme: Dark',
        'cmd.themeLight.title': 'Theme: Light',
        'cmd.themeSystem.title': 'Theme: System',
        'cmd.localeEn.title': 'Language: English',
        'cmd.localeZh.title': 'Language: 中文',
      },
      zh: {
        'palette.placeholder': '输入命令…',
        'palette.empty': '没有匹配的命令',
        'palette.hint': '↑↓ 选择 · ↵ 执行 · esc 关闭',
        'shortcut.open': 'Spotlight 命令面板',
        'group.navigate': '导航',
        'group.session': '会话',
        'group.view': '视图',
        'group.appearance': '外观',
        'group.shortcuts': '快捷键',
        'cmd.settings.title': '打开设置',
        'cmd.plugins.title': '打开插件页',
        'cmd.searchSessions.title': '搜索会话',
        'cmd.addWorkspace.title': '添加工作区',
        'cmd.keyboardShortcuts.title': '键盘快捷键',
        'cmd.newSession.title': '新建会话',
        'cmd.compact.title': '压缩当前会话',
        'cmd.archive.title': '归档当前会话',
        'cmd.rightbar.title': '展开 / 收起右侧栏',
        'cmd.workspaceFiles.title': '工作区文件',
        'cmd.toggleSidebar.title': '收起 / 展开侧栏',
        'cmd.themeDark.title': '主题：深色',
        'cmd.themeLight.title': '主题：浅色',
        'cmd.themeSystem.title': '主题：跟随系统',
        'cmd.localeEn.title': '语言：English',
        'cmd.localeZh.title': '语言：中文',
      },
    };

    /**
     * Register the one namespace dictionary for both shipped locales. The
     * per-locale registration form used before this change is reserved for
     * language packs; the object form is the documented shape for `zh`/`en`.
     * A re-apply (HMR, disable/enable) may find an earlier generation's
     * dictionary still live; reusing it is safe because the keys are identical.
     */
    function registerDicts(locale) {
      if (!locale || typeof locale.register !== 'function') return undefined;
      try {
        if (typeof locale.bind === 'function' && locale.bind(NS)('palette.placeholder') !== 'palette.placeholder') return undefined;
      } catch (e) { /* an unreadable locale face is not a reason to skip registration */ }
      try {
        return locale.register(NS, { en: DICTS.en, zh: DICTS.zh });
      } catch (e) {
        try { console.warn('dsh-spotlight: locale namespace is already registered by an earlier mount; reusing it', e); } catch (_) { /* ignore */ }
        return undefined;
      }
    }

    /**
     * Build the translator for the palette. A command may carry its own
     * literal `title`/`group`; those are the per-command fallback when the
     * key is not part of this namespace (the case for commands contributed by
     * other plugins). Falling back to the English dictionary — never to
     * `zh` — keeps the default readable before any dictionary is live.
     */
    function translator(locale) {
      let bound;
      try { bound = locale && typeof locale.bind === 'function' ? locale.bind(NS) : undefined; } catch (e) { bound = undefined; }
      return (key, fallback) => {
        if (bound) {
          try {
            const value = bound(key);
            if (typeof value === 'string' && value && value !== key) return value;
          } catch (e) { /* fall through to the literal fallback */ }
        }
        return fallback ?? (DICTS.en[key] ?? key);
      };
    }

    /* ------------------------------------------------------------------ *
     * Styles — theme tokens only.
     *
     * A static client bundle has no `styles` closure symbol; only dynamic
     * client code is handed one. Injecting the tag during materialization
     * lets the module system claim it as this package's owned style and
     * remove it on unload, which is the same contract shipped first-party
     * bundles follow.
     * ------------------------------------------------------------------ */
    const CSS = `
.dsh-spotlight-backdrop{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.35);display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;}
.dsh-spotlight-panel{width:min(720px,92vw);max-height:60vh;display:flex;flex-direction:column;background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:hidden;}
.dsh-spotlight-input{margin:0;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:16px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);}
.dsh-spotlight-list{list-style:none;margin:0;padding:6px;overflow-y:auto;}
.dsh-spotlight-group{font-size:11px;color:var(--dsw-alias-label-secondary);padding:8px 10px 4px;text-transform:uppercase;letter-spacing:.04em;}
.dsh-spotlight-item{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-primary);font-size:14px;}
.dsh-spotlight-item.active{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-3));}
.dsh-spotlight-item-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dsh-spotlight-item-hint{font-size:11px;color:var(--dsw-alias-label-secondary);}
.dsh-spotlight-empty{padding:20px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;}
.dsh-spotlight-foot{padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);}
`;
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) === null) {
      const style = document.createElement('style');
      style.dataset.pluginCss = STYLE_ID;
      style.textContent = CSS;
      if (document.head) document.head.appendChild(style);
    }

    /* ------------------------------------------------------------------ *
     * Palette component.
     * ------------------------------------------------------------------ */
    function commandText(cmd, t) {
      const title = (cmd.titleKey && t(cmd.titleKey, cmd.title)) || cmd.title || cmd.id;
      const group = (cmd.groupKey && t(cmd.groupKey, cmd.group)) || cmd.group || '';
      return { title: String(title), group: String(group) };
    }

    function filterCommands(query, t) {
      const all = store.list();
      const q = query.trim().toLowerCase();
      const withText = all.map((cmd) => ({ cmd, ...commandText(cmd, t) }));
      const matched = q
        ? withText.filter((it) =>
            it.title.toLowerCase().includes(q) ||
            it.group.toLowerCase().includes(q) ||
            (it.cmd.keywords || []).some((k) => String(k).toLowerCase().includes(q)))
        : withText;
      // group by first appearance, keep registration order inside a group
      const groups = [];
      const byGroup = new Map();
      for (const it of matched) {
        const key = it.group || '';
        if (!byGroup.has(key)) { byGroup.set(key, []); groups.push(key); }
        byGroup.get(key).push(it);
      }
      const flat = [];
      for (const g of groups) for (const it of byGroup.get(g)) flat.push(it);
      return { groups, flat };
    }

    function Palette(props) {
      const { ctx } = props;
      const locale = svc(ctx, 'locale');
      const t = translator(locale);
      const [isOpen, setIsOpen] = useState(store.isOpen());
      const [query, setQuery] = useState('');
      const [index, setIndex] = useState(0);
      const inputRef = useRef(null);
      const listRef = useRef(null);
      const restoreRef = useRef(null);

      useEffect(() => {
        const off = store.subscribe(() => setIsOpen(store.isOpen()));
        setIsOpen(store.isOpen());
        return off;
      }, []);
      useEffect(() => {
        if (!isOpen) return undefined;
        if (typeof document !== 'undefined') restoreRef.current = document.activeElement;
        setQuery('');
        setIndex(0);
        // Effects run after the DOM commit, so the input exists now. Focus it
        // synchronously (background tabs may throttle rAF) and retry after the
        // first paint in case the browser moved focus during commit.
        if (inputRef.current) inputRef.current.focus();
        const id = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(() => { if (inputRef.current) inputRef.current.focus(); })
          : null;
        return () => {
          if (id !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
          const previous = restoreRef.current;
          restoreRef.current = null;
          if (previous && typeof previous.focus === 'function') { try { previous.focus(); } catch (e) { /* detached */ } }
        };
      }, [isOpen]);

      const { flat } = filterCommands(query, t);
      const clampedIndex = Math.min(index, Math.max(0, flat.length - 1));

      useEffect(() => {
        if (!isOpen || !listRef.current) return;
        const active = listRef.current.querySelector('.dsh-spotlight-item.active');
        if (active && typeof active.scrollIntoView === 'function') {
          try { active.scrollIntoView({ block: 'nearest' }); } catch (e) { /* non-fatal */ }
        }
      }, [isOpen, clampedIndex]);

      const runItem = useCallback((item) => {
        if (!item) return;
        store.close();
        try { item.cmd.run(ctx); } catch (e) { try { console.error('spotlight command failed', item.cmd.id, e); } catch (_) { /* ignore */ } }
      }, [ctx]);

      const onInputKeyDown = (e) => {
        if (e.isComposing) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, Math.max(0, flat.length - 1))); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
        else if (e.key === 'Enter') { e.preventDefault(); runItem(flat[clampedIndex]); }
        else if (e.key === 'Escape') { e.preventDefault(); store.close(); }
      };

      if (!isOpen) return null;

      const rows = [];
      let lastGroup;
      flat.forEach((it, i) => {
        if (it.group !== lastGroup) {
          lastGroup = it.group;
          if (it.group) rows.push(h('li', { key: 'g:' + it.group, className: 'dsh-spotlight-group', role: 'presentation' }, it.group));
        }
        rows.push(h('li', {
          key: it.cmd.id,
          role: 'option',
          'aria-selected': i === clampedIndex,
          className: 'dsh-spotlight-item' + (i === clampedIndex ? ' active' : ''),
          onMouseEnter: () => setIndex(i),
          onClick: () => runItem(it),
        },
          h('span', { className: 'dsh-spotlight-item-title' }, it.title),
          it.cmd.hint ? h('span', { className: 'dsh-spotlight-item-hint' }, it.cmd.hint) : null,
        ));
      });

      return h('div', {
        className: 'dsh-spotlight-backdrop',
        onMouseDown: (e) => { if (e.target === e.currentTarget) store.close(); },
      },
        h('div', {
          className: 'dsh-spotlight-panel',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('palette.placeholder'),
          onKeyDown: (e) => {
            if (e.key === 'Tab') { e.preventDefault(); if (inputRef.current) inputRef.current.focus(); }
          },
        },
          h('input', {
            ref: inputRef,
            className: 'dsh-spotlight-input',
            value: query,
            placeholder: t('palette.placeholder'),
            'aria-label': t('palette.placeholder'),
            autoComplete: 'off',
            spellCheck: false,
            onChange: (e) => { setQuery(e.target.value); setIndex(0); },
            onKeyDown: onInputKeyDown,
          }),
          rows.length
            ? h('ul', { ref: listRef, className: 'dsh-spotlight-list', role: 'listbox' }, rows)
            : h('div', { className: 'dsh-spotlight-empty' }, t('palette.empty')),
          h('div', { className: 'dsh-spotlight-foot' }, t('palette.hint')),
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * apply: styles, locale, registry service, keydown, overlay slot.
     * ------------------------------------------------------------------ */
    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          return applyInner(ctx);
        } catch (e) {
          try { console.error('dsh-spotlight: apply failed: ' + (e && (e.stack || e.message || String(e)))); } catch (_) { /* ignore */ }
          throw e;
        }
      },
    };

    function applyInner(ctx) {
      // A re-apply starts closed; an earlier generation's open overlay is gone.
      open = false;

      const fallbackDisposers = [];
      /**
       * Register one owned effect. `ctx.effect` is the Cordis owner that also
       * tears the effect down when this fiber unloads or apply throws; the
       * local array is only the fallback for a context without `effect`.
       */
      const effect = (body, label) => {
        if (typeof ctx.effect === 'function') { ctx.effect(body, label); return; }
        const dispose = body();
        if (typeof dispose === 'function') fallbackDisposers.push(dispose);
      };

      const locale = svc(ctx, 'locale');
      effect(() => registerDicts(locale), 'dsh-spotlight: locale dictionaries');

      effect(() => registerBuiltinCommands(ctx), 'dsh-spotlight: built-in commands');

      // The shortcuts service may mount after this plugin; wait for it with
      // `ctx.inject` instead of racing `ctx.get` during apply. The bare `/`
      // listener keeps working when the service is never composed.
      const registerShortcut = (scope) => {
        const owner = scope && typeof scope.effect === 'function' ? scope : ctx;
        const install = (body, label) => {
          if (owner && typeof owner.effect === 'function') { owner.effect(body, label); return; }
          const dispose = body();
          if (typeof dispose === 'function') fallbackDisposers.push(dispose);
        };
        install(() => registerOpenShortcut(scope), 'dsh-spotlight: open shortcut');
        install(() => installShortcutCommands(scope), 'dsh-spotlight: shortcut directory');
      };
      if (typeof ctx.inject === 'function') {
        try { ctx.inject(['shortcuts'], registerShortcut); } catch (e) {
          try { console.warn('dsh-spotlight: cannot wait for shortcuts service', e); } catch (_) { /* ignore */ }
          registerShortcut(ctx);
        }
      } else {
        registerShortcut(ctx);
      }

      // Public extension API for other plugins.
      if (typeof ctx.provide === 'function') {
        effect(() => {
          try {
            return ctx.provide('spotlight', {
              register: (def) => store.register(def),
              list: () => store.list(),
              open: () => store.open(),
              close: () => store.close(),
              toggle: () => store.toggle(),
              isOpen: () => store.isOpen(),
            });
          } catch (e) {
            try { console.error('dsh-spotlight: provide spotlight service failed', e); } catch (_) { /* ignore */ }
            return undefined;
          }
        }, 'dsh-spotlight: spotlight service');
      }

      if (typeof document !== 'undefined') {
        effect(() => {
          const onKeyDown = (e) => {
            if (synthesizing || e.defaultPrevented || e.isComposing) return;
            if (e.key === 'Escape' && store.isOpen()) {
              e.preventDefault();
              e.stopPropagation();
              store.close();
              return;
            }
            if (modalOpen() && !store.isOpen()) return;
            if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey
              && (e.key === '?' || e.key === '/' || e.code === 'Slash')) {
              if (e.repeat) return;
              e.preventDefault();
              e.stopPropagation();
              store.toggle();
              return;
            }
            if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !store.isOpen() && !isTypingTarget(e.target)) {
              e.preventDefault();
              store.open();
            }
          };
          document.addEventListener('keydown', onKeyDown, true);
          return () => document.removeEventListener('keydown', onKeyDown, true);
        }, 'dsh-spotlight: keyboard');
      }

      const slots = (ctx.slots && typeof ctx.slots.inject === 'function')
        ? ctx.slots
        : svc(ctx, 'slots');
      if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
        effect(() => slots.inject('shell.overlay', () => {
          try {
            return slots.register({
              name: 'shell.overlay',
              id: 'dsh-spotlight',
              order: 100,
              label: 'Spotlight',
            }, (props) => h(Palette, { ...props, ctx }));
          } catch (e) {
            try { console.error('dsh-spotlight: shell.overlay registration failed', e); } catch (_) { /* ignore */ }
            return undefined;
          }
        }), 'dsh-spotlight: shell.overlay');
      } else {
        try { console.error('dsh-spotlight: slots service unavailable, palette not mounted'); } catch (_) { /* ignore */ }
      }

      return () => {
        for (let i = fallbackDisposers.length - 1; i >= 0; i--) {
          try { fallbackDisposers[i](); } catch (e) { try { console.error('dsh-spotlight: cleanup failed', e); } catch (_) { /* ignore */ } }
        }
      };
    }
  },
});
