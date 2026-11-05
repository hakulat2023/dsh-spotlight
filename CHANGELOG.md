# Changelog

## 1.0.2 — 2026-11-05

- Sharpen the plugin description across `package.json`, both READMEs, and the
  locale dictionaries: lead with the one-shortcut pitch (`Cmd/Ctrl+Shift+P` or
  `/`) instead of a plain feature list.
- Bump pinned install commands to `#v1.0.2`.

## 1.0.1 — 2026-11-03

- Match the palette panel to the DSH input surface with
  `--dsw-specific-input-major`, so dark mode is no longer washed out.
- Use `--dsw-alias-interactive-bg-hover` for the selected row; the old layer
  token matched the new dark panel background.
- Widen the panel from `560px` to `min(720px, 92vw)`.
- Refresh the light and dark README screenshots and add a dark-theme preview.

## 1.0.0 — 2026-11-03

Initial public release.

- Spotlight-style command palette in `shell.overlay`, opened by
  `Cmd/Ctrl+Shift+P` or `/`.
- Built-in commands for settings, plugins, session search, workspace creation,
  keyboard shortcuts, new session, archive, compact, left/right columns,
  workspace files, theme, and language.
- Shortcut mirror that exposes the shell's configurable shortcut catalog with
  keycaps and runs entries through the shell registry.
- Extensible `spotlight` command service with localized title/group/keyword
  search and focus/scroll management.
- Owned stylesheet, locale dictionary, commands, shortcuts, and slot entry, all
  released through Cordis effects.
- VM-based verification suite and GitHub Actions workflow.
