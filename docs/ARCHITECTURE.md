# Architecture

`pi-tern` is a single pi extension. It never writes TSP frames — it only sends the `hello` probe —
so pi's own ANSI renderer is never interfered with. Everything else goes through Tern's CLI or its
daemon relay.

## Module map

| Module | Responsibility |
| --- | --- |
| `index.ts` | extension factory: probe lifecycle, Phase A features, tools, `/tern` command |
| `lib/tsp.ts` | TSP v1 framing/parsing, `hello` encode, DA1 detection |
| `lib/tern.ts` | Tern detection (`TERM_PROGRAM`), `tern` CLI runner, scratch dir |
| `lib/relay.ts` | daemon relay client: `u32LE + JSON`, `hello`/`welcome`, answer unwrap |
| `lib/browser.ts` | browser op validation, relay-first with CLI fallback |
| `lib/diagram.ts` | write a Markdown file, open it in a Tern file block (merman), pin support |
| `lib/ctl.ts` | pane capture, control-endpoint commands, pane listing |
| `lib/text.ts` | pure helpers: mermaid extraction, message rendering (unit-tested) |

## Probe lifecycle

```mermaid
sequenceDiagram
  participant E as pi-tern
  participant P as pi TUI
  participant T as Tern
  Note over E: session_start (TUI mode)
  E->>P: ctx.ui.onTerminalInput(handler)
  E->>T: process.stdout.write(hello + ESC [ c) after 1.2s
  T-->>E: APC tsp;r hello (before the DA1)
  T-->>E: ESC [ ?62;52;c
  Note over E: probe.status = confirmed (hello cached)
  T-->>E: ESC [ ?62;52;c only  %% => absent (no TSP)
```

- The reply is read only through `ctx.ui.onTerminalInput`; TSP-looking input is consumed, DA1
  replies belonging to the probe are absorbed, everything else passes through.
- `PI_TERN_PROBE=0` disables the probe; tmux/screen/zellij are never probed (APC is swallowed).

## Channels

1. **pty / TSP** — the `hello` probe. The extension does not open surfaces or send frames.
2. **daemon relay** (`$TERN_PANE_SOCKET`) — `{"hello":{}}` → `{"welcome":{}}`, then
   `{"id":N,"browser":OP}` → `{"id":N,"browser":ANSWER}` (the client unwraps `browser`).
   Falls back to `tern browser JSON --timeout N`.
3. **`tern` CLI** — `open` (diagram + mirror file blocks), `capture`, `ls --json`, `ctl`.

## Features

- **Title**: `ctx.ui.setTitle("π <model> · <ctx%> · <dir>")` on session start (re-applied after 3 s,
  because pi writes its own startup title) and on every `turn_end`.
- **Bell**: `PI_TERN_BELL=1` writes `\x07` to the pty at `agent_end`.
- **Diagrams**: `message_end` scans finalized assistant messages for ` ```mermaid ` fences; the
  newest is kept. `/tern diagram --last` writes it and opens it with
  `tern open --split right <file>`; `pin` reuses one file path so the same block updates.
- **Session mirror**: opt-in; renders finalized messages and tool events into
  `~/.pi/agent/scratch/pi-tern/session-mirror.md` (capped at ~200 KB) and opens it once as a file
  block. `/tern mirror open` re-focuses it.

## What the extension deliberately does not do

pi 1.0.3 / `@earendil-works/pi-tui` expose no frame-provider seam, and their ANSI frames are
multi-write synchronized-output transactions with private cursor accounting. A foreign writer
tears frames, so this extension does not attempt TSP surfaces. Native Tern chrome (dock, composer,
transcript) requires a pi-tui back-port: additive seams for a DA1 probe, `setFrameProvider`, and
`Component.describe()`.
