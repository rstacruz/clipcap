<br />

<h1 align="center">Clipcap</h1>

<p align="center"><strong>Compact live inline progress recap</strong></p>

<br />

A dim panel above the editor that recaps the conversation: on demand, once the session goes quiet, and on a refresh cadence while the agent works.

```text
╭👀╮ ╭───────────────────────────────────────────────────────────────────────────────────╮
│╭╮│ │ Implementing: Wire recap into the panel                         ━━━━━━━━━┄ 20m ⌛ │
││││ │ - Goal: one glance tells you where the session stands                             │
││││ │ - I did: split the prompt, renderer, and lifecycle                                │
╰─╯  ╰─────────────────────────────────────────────────── esc: dismiss · ctrl-h: more ───╯
──────────────────────────────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────────────────────────────
DeepSeek V4.1 Flash · max · main *4
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

- `/clipcap` — recap now.
- Shows up on its own after 5s of quiet, and 5s into a long turn; mid-work recaps refresh every 3–15 minutes by elapsed time.
- `esc` — dismiss (cancels an asked recap while it runs).
- `ctrl-h` — toggle details, when the recap has more to show.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `OMP_CLIPCAP_IDLE_SECONDS` | `5` | Quiet time before the idle recap; `0` disables |
| `OMP_CLIPCAP_AUTO_SECONDS` | `5` | Delay before a mid-work recap; `0` disables |
| `OMP_CLIPCAP_KEY` | `ctrl-h` | Key that toggles the details view |

## Development

```sh
bun install
bun run check
omp plugin link .
```

`bun run check` runs the typecheck and the unit tests. Restart omp after changing `src/clipcap.ts` or `src/recap.ts`.
