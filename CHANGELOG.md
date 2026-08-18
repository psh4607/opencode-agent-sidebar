# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Agent rows now derive only from real `task` / `delegate` tool parts, preventing historical `subtask` and `agent` prompt parts from reappearing as permanent activity and making reactive part removal immediate.
- Native OpenCode background Task follows `sessionId` / `jobId` child sessions through busy, retry, idle, and late assistant-error updates, while resumed calls deduplicate immediately through `task_id` and existing OMO/legacy background fields remain supported across sidebar visibility changes.

## [0.2.2] — 2026-05-07

### Fixed

- Stale "Running" entries no longer linger in the sidebar after a TUI restart. Background-task status markers (`[BACKGROUND TASK COMPLETED]`, `[ALL BACKGROUND TASKS COMPLETE]`) live inside `system-reminder` text parts that have empty `time.start` / `time.end` fields. The previous `if (completedAt)` guard inside `scanSessionState` silently skipped those parts on rescan, leaving completed background entries stuck as `Running` forever. The guard is removed and the timestamp falls back to `Date.now()`, matching the behaviour of the live `handlePart` event path.

### Docs

- README Preview section now embeds a live screenshot ([assets/sidebar-demo.png](assets/sidebar-demo.png)) of the sidebar with multiple sub-agents running, replacing the ASCII placeholder.

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

[Unreleased]: https://github.com/psh4607/opencode-agent-sidebar/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/psh4607/opencode-agent-sidebar/releases/tag/v0.2.2
[0.2.1]: https://github.com/psh4607/opencode-agent-sidebar/releases/tag/v0.2.1
[0.2.0]: https://github.com/psh4607/opencode-agent-sidebar/releases/tag/v0.2.0
[0.1.0]: https://github.com/psh4607/opencode-agent-sidebar/releases/tag/v0.1.0
