# Changelog

## Unreleased — v1.0.0 M1

- **Native mode (rows fallback)**: `native/` launcher + probe, loader hook patching
  `ProcessTerminal.write`, ANSI grid to TSP `rows` frames, stock-pi fallback, 100 ms frame
  coalescing. Verified inside Tern: 619 frames, `[Skills] …` content, **0 ANSI writes**; fallback
  outside Tern returns stock 1.0.4. Semantic dock/composer/transcript nodes remain M2/M3.
- Docs: `native/README.md`, `docs/NATIVE-M1.md` (metrics + charts); native unit tests (5).

## 0.9.1 — 2026-10-06

- Docs correction (no code changes): the loader hook reaches real pi-tui only through the **unbundled**
  entry. Measured on managed pi 1.0.4: default launcher resolves pi-tui 16× and loads it **0×**
  (inlined); `node …/dist/cli.js` loads it 44× and the hook transformed all 44, interactive included.
  `docs/CORE-BACKPORT.md` rewritten with the wrapper design and ranked alternatives.

## 0.9.0 — 2026-10-06

- **Adaptive mailbox** — 100 ms poll for 5 s after activity, 250 ms idle. Measured ping median **66 ms** (was 252), min 62, max 314.
- **Prompt −79 % overall** — three direct tools (`tern_status`, `tern_run`, `tern_browser`); delta **+774 tokens** (0.8.0: +1,309; 0.7.0: +3,679).
- **UI-test harness** — `tern_ui_test` / `/tern ui-test <scenario> [expect]` runs `tern shot` and asserts against a control endpoint (tree/a11y/state/css/webcall/dump/stats); verified passing.
- **Diagram pipelines** — `--from "<cmd>"` renders a mermaid fence from a command's output; `git` renders the repository as a mermaid gitGraph.
- **Mirror search** — `tern_mirror search` / `/tern mirror search <text>`.
- **Credential guard** — `tern_db` refuses credential-looking tables and the agent/models stores unless `allowSecret:true` (`lib/guard.ts`, unit-tested).
- **Notebook run** — `/tern notebook run <path>` executes through `nbconvert` in a visible pane, with a clear missing-tool path (jupyter is not installed on this machine).
- **Docs** — `docs/CORE-BACKPORT.md` (verified loader-hook route, no binary edits), `RELEASING.md`, `spikes/omp-session-surface.py`.
- 20 protocol tests.

## 0.8.0 — 2026-10-06

- **Prompt footprint −64 %** — only five tools are declared to the model (`tern_status`, `tern_run`, `tern_browser`, `tern_db`, `tern_diagram`); the other fourteen are `deferred` and callable from codemode scripts by name (listed in `tern_status`). Measured: **+1,309** prompt tokens (21,704 → 23,013) vs **+3,679** in 0.7.0. A real codemode call to a deferred tool was verified.
- **Mailbox throughput** — plugin poll 400 → 250 ms, extension poll 120 → 60 ms, plus `mailboxBatch` for several ops per round trip. Measured: ping median **730 → 252 ms**; three ops in **251 ms**.
- **Reliability** — per-response plugin-version assertion (a stale window fails with “restart the Tern window”), best-effort single-owner claim, stale-request TTL, and a SQLite handle cache (8 entries).
- **Benchmarks in-repo** — `scripts/bench.ts` and `docs/BENCHMARKING.md`.
- 18 protocol tests (batch and stale-version coverage).

## 0.7.0 — 2026-10-06

- **Settings** — `tern_settings` / `/tern settings get|list|describe <key>` through `cx.settings` (type, enum, range, default, docs).
- **Notebooks** — `tern_notebook read <pane>` reads an open Tern notebook block's cells and outputs via `cx.session:read`. Execution is not exposed by the plugin API on 0.4.5; drive it in Tern's UI.
- **Documents** — `doc.edit` gains all three shapes: `{find, replace, all?}`, `{line, insert}` (insert at the line start; include `\n` for a new line) and `{heading, append}`.

## 0.6.0 — 2026-10-06

- **Carly** — `tern_carly` and `/tern ask|remember|recall|schedule|tasks|cancel`. `ask` opens Carly with a question (`cx:ask_carly`); schedules use `tern.carly.schedule` (`every 30m`, `daily 09:00`, event triggers); a `pi_tern()` export is registered so Carly can read pi's status.
- **Privacy** — Carly routes through remote providers; the tool and commands warn never to send vault, Apple Notes or secret material.

## 0.5.0 — 2026-10-06

- **Tern data plane** — a request/response mailbox between the extension and the pi-bridge plugin (request.json → plugin timer → response.json). One operation at a time, ~0.25–0.75 s.
- **SQLite** — `tern_db` (tables, schema, query) through `cx.db`, read-only unless `exec` is explicitly allowed.
- **Documents** — `tern_doc` reads live buffers (including unsaved edits), outlines, searches, appends and writes.
- **Boards** — `tern_board` reads and edits a native Tern board (lanes, cards, move/check).

## 0.4.0 — 2026-10-06

- **One install** — pi-tern links the pi-bridge canvas plugin automatically on the first Tern session (`PI_TERN_BRIDGE=0` disables); installing pi-tern is enough. The dashboard gains a session TOC and recent-activity sections.
- **Browser suite completed** — network capture (Resource Timing, HAR-lite JSON), PDF export, multi-tab listing/close, a form-field helper, plus the 0.3.0 stale-ref recovery and PNG baselines.
- **Session mirror** — a TOC header with timestamps; incremental appends kept.
- **CI** — `tsc --noEmit` (via minimal ambient stubs), `oxlint`, and a coverage job alongside the Node 22/24 matrix; coverage badge in the README (74.9% lines).
- **Fixed** — the `eval` op now sends the `function` key (Tern rejects `script`); 15 protocol tests.

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
