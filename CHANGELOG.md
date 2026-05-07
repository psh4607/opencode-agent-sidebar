# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] — 2026-05-07

### Added

- Live elapsed timer for active sub-agents (Solid.js signal-driven; ticks every second without waiting for the next event).
- Foreground / background separation for `task(...)` and `delegate(...)` calls.
- Collapsible `Agents` sidebar panel with persistent state via `/agents-toggle` slash command and `Ctrl+x a` keybind.
- Per-session filtering (only entries from the currently focused sidebar session are shown).
- Auto-cleanup of completed entries after ~10 seconds.
- Zero-config `github:` install — bundled `dist/` ships with the repo, no build step required at install time.

[Unreleased]: https://github.com/psh4607/opencode-agent-sidebar/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/psh4607/opencode-agent-sidebar/releases/tag/v0.1.0
