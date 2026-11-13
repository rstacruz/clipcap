# Changelog

## v0.2.0 - 2026-11-14

### ✨ New features

- **Always visible**: the panel never hides. A fresh session greets you, submitting a prompt shows `You asked: …`, and a recap replaces it as soon as one lands.
- **Compact view**: `ctrl-h` cycles default, expanded, and compact (one line) views.

### 🐛 Fixes

- The panel no longer sticks on `You asked: …` when a recap outlives the turn that started it, or when a stale recap from an earlier turn blocks the next one: the idle clock retries instead of going quiet, and a submitted prompt cancels stale runs.

## v0.1.0 - 2026-11-10

### ✨ New features

- **Live recap panel**: a dim panel above the editor recaps the conversation — what you asked, the goal, what the agent did, and what's next.
- **On demand**: `/clipcap` recaps the session immediately.
- **Idle and mid-work recaps**: the panel appears 5s after a turn ends and the session goes quiet, and 5s into a long turn; mid-work recaps refresh every 3–15 minutes by elapsed time.
- **Your requests in the recap**: the panel shows the last few things you asked.
- **Recap kinds**: recaps label the work — implementing, reviewing, orchestrating subagents, debugging, and more.
- **Details view**: `ctrl-h` expands the panel when it has more to show; `esc` dismisses it.
- **Border styles**: set `OMP_CLIPCAP_BORDER` to `none` (default) or `rounded`.
- **Configurable timing**: `OMP_CLIPCAP_IDLE_SECONDS` and `OMP_CLIPCAP_AUTO_SECONDS` tune or disable the automatic recaps.

### 🔧 Improvements

- The idle recap arms only after a turn ends, so command submissions no longer trigger a recap shortly after startup.
- The idle clock skips while a recap is in flight, so it no longer aborts a running `/clipcap`.
- Borderless panels no longer leave a blank line above the recap.

### 🐛 Fixes

- Mascot gutter now renders shoulders correctly on two-line panels.
