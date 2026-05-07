# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.1] — 2026-05-07

### Added

- Click-to-toggle on the `▶ / ▼ Agents` header row. Left-clicking anywhere on the header line now expands or collapses the panel (parity with the built-in MCP panel). The existing `/agents-toggle` slash command and `Ctrl+x a` keybind continue to work.

### Fixed

- Header row no longer leaves an inverted-text selection highlight after clicking. The header text is now `selectable: false`, so the mouse-down that triggers the toggle does not start a stray text selection.

## [0.2.0] — 2026-05-07

### Added

- Update notifier in the sidebar header. Once a day, the plugin checks the GitHub Releases API for the latest tag; if a newer version is available, the header gets a `[⬆ vX.Y.Z available]` suffix. Read-only — never self-updates the plugin code or cache.
- Result is cached in OpenCode's KV store, so restarts do not re-fetch within the 24h window.
- Network failures are silent: no toasts, no log spam. The cached value is preserved on error.

## [0.1.0] — 2026-05-07

### Added

- Live elapsed timer for active sub-agents (Solid.js signal-driven; ticks every second without waiting for the next event).
- Foreground / background separation for `task(...)` and `delegate(...)` calls.
- Collapsible `Agents` sidebar panel with persistent state via `/agents-toggle` slash command and `Ctrl+x a` keybind.
- Per-session filtering (only entries from the currently focused sidebar session are shown).
- Auto-cleanup of completed entries after ~10 seconds.
- Zero-config `github:` install — bundled `dist/` ships with the repo, no build step required at install time.

[Unreleased]: https://github.com/psh4607/opencode-agent-sidebar/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/psh4607/opencode-agent-sidebar/releases/tag/v0.2.1
[0.2.0]: https://github.com/psh4607/opencode-agent-sidebar/releases/tag/v0.2.0
[0.1.0]: https://github.com/psh4607/opencode-agent-sidebar/releases/tag/v0.1.0
