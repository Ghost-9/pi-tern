# Changelog

## 0.3.0 — 2026-10-06

P0/P1 roadmap release (extension-only).

- **`tern_watch --expect <regex>`** — polls a pane's output until a pattern appears (dev servers, builds, prompts) and returns the tail. Measured: matched `READY-PITERN` in 1.9 s.
- **Browser suite** — stale-ref recovery for `act` (re-snapshot + one retry), named PNG baselines with change detection, and a `tabs` listing.
- **`pi-bridge`** — `/tern bridge install` writes and links a Tern plugin that renders a native Markdown dashboard (model, context, mirror, last diagram/shell, browser tabs) in a canvas; chord `ctrl+shift+f10`; `/tern bridge refresh`. Verified: plugin `ready`, chord bound in Tern's log.
- **`tern_shot`** — renders scenario files to PNG + layout JSON via `tern shot` (verified: 800x600 PNGs + layout JSON).
- **`tern_remote`** — lists or discovers Tern remote hosts.
- **ConPTY / multiplexers** — OSC-877 replies are normalized so the probe works on Windows; tmux/screen/zellij are detected and the probe is skipped.
- **Tests** — 14 protocol tests (OSC-877, dashboard rendering, a fake-`tern` run harness) plus live checks.

## 0.2.1 — 2026-10-06

- **Runnable shell blocks** — `tern_run` and `/tern run [--last]` execute a bash/sh command from the conversation in a visible Tern pane, wait for exit and return the captured output. `PI_TERN_RUN=0` disables it.
- Tracks the newest bash/sh fence per message (like `--last` for diagrams) and strips copied `$ ` prompts before running.
- 11 protocol tests (adds shell-fence extraction and cleaning).

## 0.2.0 — 2026-10-06

- **Persistent relay** — one reconnecting daemon connection with a request queue and idle close, so many browser ops share one greeting instead of a connect per call.
- **`tern_watch`** — wait for the next Tern daemon event (`pane_exited`, …) with an optional pane filter and timeout. Wait for a test run or server instead of polling.
- **`tern_diagnose` and `/tern diagnose`** — environment, TSP probe, relay round trip, control endpoint and persisted state.
- **`/tern control [window|headless]`** — start a Tern window or headless session bound to a control socket; `tern_ctl` uses the stored endpoint automatically.
- **`/tern restore` and persisted state** — the mirror preference, last pinned diagram and control endpoint survive restarts. `/tern mirror on` keeps the mirror across sessions; `PI_TERN_MIRROR=1` starts it automatically.
- **Browser capture** — bounded retries that wait for the first paint, with actionable guidance for the WebView `0×0` case.
- **Tests** — 10 protocol tests (adds event parsing and a mock-socket relay test asserting connection reuse); the live suite exits cleanly.

## 0.1.1 — 2026-10-06

- Docs: fix the Mermaid sequence diagrams in `README.md` and `docs/ARCHITECTURE.md`. GitHub's
  renderer rejected the previous ones because `;` is a statement separator inside sequence
  diagrams. No code changes.

## 0.1.0 — 2026-10-06

Initial release.

- **TSP handshake** — detects Tern with the `hello` + DA1 probe and reads the reply through pi's raw input (`ctx.ui.onTerminalInput`). Verified against Tern 0.4.5: 44 node kinds, 10 features.
- **Mermaid diagrams** — `tern_diagram` and `/tern diagram` render through Tern's built-in merman engine as file blocks. `--last` uses the newest Mermaid fence in the conversation; `pin` keeps one file path so re-renders update the same block.
- **Session mirror** — `/tern mirror on` writes the conversation to a Markdown file block; Mermaid inside it renders natively.
- **Tern browser** — `tern_browser` drives Tern's WKWebView picture-in-picture over the daemon relay or the `tern browser` CLI. `capture` returns the PNG as an image content block and saves it under `~/.pi/agent/scratch/pi-tern/`.
- **Pane inspection** — `tern_capture`, `tern_panes`, `tern_ctl`.
- **Tern chrome** — live tab title (`π <model> · <context> · <dir>`) and an opt-in attention bell (`PI_TERN_BELL=1`).
- **Configuration** — `PI_TERN_*` environment switches, documented in the README.
