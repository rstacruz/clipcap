<br />

<h1 align="center">Clipcap</h1>

<p align="center"><strong>Compact live inline progress recap</strong></p>

<br />

An always-on dim panel above the editor that recaps the conversation: on demand, once the session goes quiet, and on a refresh cadence while the agent works. With nothing to recap yet, it greets you.

```text
╭👀╮
│╭╮│   Implementing: Wire recap into the panel                           ━━━━━━━━━┄ 20m ⌛
││││   - You asked: show where the session stands
││││   - I did: split the prompt, renderer, and lifecycle
╰─╯                                                                       ctrl-h: more
──────────────────────────────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────────────────────────────
DeepSeek V4.1 Flash · max · main *4
```

Compact view, one line:

```text
⌛ Implementing: Wire recap into the panel · next: rewrite RECAP_PROMPT        ━━━━━━━┄┄┄ 20m ctrl-h
──────────────────────────────────────────────────────────────────────────────────────────
❯
```

## Install

Requires omp 18.11 or newer.

```sh
omp plugin install github:rstacruz/clipcap
```

Pin a release:

```sh
omp plugin install github:rstacruz/clipcap#v0.1.0
```

Restart omp after installing.

## Usage

- Always shown in the main TUI session. A fresh session shows `Good morning, <user>`; submitting a prompt shows `You asked: …` until a recap lands.
- `/clipcap` — recap now.
- Recaps on its own 5s after a turn ends and the session goes quiet, and 5s into a long turn; mid-work recaps refresh every 3–15 minutes by elapsed time.
- `ctrl-h` — cycle views: default, expanded (when the recap has more to show), and compact (one line).
- `esc` — cancel a running `/clipcap` and restore the previous view.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `OMP_CLIPCAP_IDLE_SECONDS` | `5` | Quiet time before the idle recap; `0` disables |
| `OMP_CLIPCAP_AUTO_SECONDS` | `5` | Delay before a mid-work recap; `0` disables |
| `OMP_CLIPCAP_KEY` | `ctrl-h` | Key that cycles view modes |
| `OMP_CLIPCAP_BORDER` | `none` | Panel border: `none` or `rounded` |

## Development

```sh
bun install
bun run check
omp plugin link .
```

`bun run check` runs the typecheck and the unit tests. Restart omp after changing `src/clipcap.ts` or `src/recap.ts`.
