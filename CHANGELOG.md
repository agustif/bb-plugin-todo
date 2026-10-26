# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `link` action: attach an existing thread in the same project to a todo as
  its worker, without spawning one. The linked thread reports like a
  dispatched child.

### Fixed

- `dispatch` no longer overwrites todo changes saved while a worker is being
  spawned. It holds the todo during the spawn, then updates only that todo.
  If the todo was closed or removed meanwhile, the result names the untracked
  worker.
- `configure` reads the thread id from `thread.id`, as the current SDK
  passes it, so dispatched and linked workers get their worker-specific
  instructions.

## [0.1.0] - 2026-08-09

### Added

- Agent tool `todo` with hierarchical list operations (set/add/update/start/
  complete/cancel/remove/clear/move/depend/mark)
- Nested trees, `dependsOn` / `blockedBy`, soft `requires`
- Multi-agent: assign roles, dispatch child BB threads, report/release
- Composer checklist banner + header progress
- Per-thread SQLite storage + realtime UI refresh
- CLI: `bb todo show`, `bb todo list-threads`
- Skill `todo` for agent planning and multi-agent patterns
- Pure-logic selftest for the tool executor
