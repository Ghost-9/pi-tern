# Changelog

## 1.1.2 — 2026-10-06

**The Tern-only features that were deliberately left unbuilt, plus the escape bug that only a
window start could find.**

### A real panel, not a markdown canvas

`tern plugin types <dir>` writes the authoritative Luau API (`tern.d.luau`, 81 KB), and it settled
every open question rather than leaving them to guesswork:

- **`tern.ui.path(path, cwd)`** — a span that *links to the file*. Clickable file references inside a
  panel needed no invention.
- **`tern.ui.el("button", …)`** — the HTML-subset element set includes `button`, and a canvas click
  arrives as `CanvasAction{pane, act, text, node}`. So the controls are real buttons, not markdown
  links pretending to be buttons.
- **`tern.ui.bars({label, value}…)`** — a native bar chart, with no SVG and no raster round trip.
- **`tern.route.link`** — a plugin may **claim a link click** and answer `{path, how}`.

The pi-bridge canvas is now a `tern.ui` view: identity line, a native bar chart, the referenced files
as clickable path spans, the session TOC as markdown, and four buttons (Refresh · Preview · Open in
split · Copy paths). It falls back to plain markdown whenever `dashboard.json` is absent or the view
fails to build, so an older plugin or a bad payload degrades instead of going blank.

### File links open in the preview panel, not a full block

`tern.route.link` sends every `file://` click to **`how = "preview"`** — Tern's small preview block,
which keeps the focus. Shift-click asks for the split, so the full view is one gesture away. This
applies to *every* file link in Tern, including the ones pi-tern emits in markdown nodes, which is
what makes the transcript's references behave the way they should.

### Native transcript modes

- **`PI_TERN_FILE_STRIP`** (on by default in native mode): after a reply that mentions files, an `md`
  node carrying clickable `file://` links is appended to the transcript. Additive — the ANSI rows,
  tool cards, diffs and spinners are untouched.
- **`PI_TERN_MD_TRANSCRIPT=1`**: the assistant's own markdown becomes the transcript, so every link and
  reference is clickable and Tern highlights code and renders mermaid. Off by default because it
  replaces the TUI rows.
- **`tern_chart { native: true }`**: also emit a live `chart` node into the transcript.

### The bug only a window start could find

The plugin's Lua lives inside a TypeScript template literal, so a `\n` written where `\\n` was meant
becomes a **real newline inside a Lua string**. Tern reports that much later, in a log, on the next
window start — while `plugin list` still says `ready` and `plugin reload` still exits 0. It bit three
times in this release. So:

- **`test/bridge-luau.test.ts`** lints the generated Luau before it can ship: no string literal may
  span a line, no raw control character, every escape must be one Lua understands, the manifest and
  `PLUGIN_VERSION` must agree, and the host-only `tern.block.define` / `tern.lens.define` must not be
  called from a window entry.
- The verification recipe is now written down: `tern plugin reload`, force a window start with
  `tern --exit-after-first-frame`, then grep the log for `failed to load`. Confirmed clean on Tern
  0.5.0 — chord bound, Carly export registered, no load error.

Gate: 67/67 unit tests · 7/7 compat · 19/19 live checks from outside a Tern pane.
Prompt footprint unchanged: +774 tokens, three declared tools.

## 1.1.1 — 2026-10-06

**Verified TSP encodings, clickable file links, a preview sheet, and the TSP encodings verified
against Tern rather than guessed.** Everything here works with no Tern pane — only a running
Tern daemon.

### The TSP encodings are now evidence, not inference

Tern answers rejected frames with `{"ev":"error","op":<index>,"msg":…}`, so the protocol can
be tested. `scripts/tsp-probe.mjs` sends one candidate per frame:

| Frame | Verdict |
| --- | --- |
| `{k:"md", p:{text}}`, `{k:"image"}`, `{k:"chart"}`, `{k:"card"}`, the `aside` region, `["set"]` | **accepted, zero errors** |
| `["blob", id, mime, data]` and `["blob", mime, data]` | **`unknown op blob`** |

The blob store is a plugin/canvas API, not a frame op — so **1.1.0's earlier guess was wrong and
is fixed**: image bytes go inline in the node (`{k:"image", p:{data, mime}}`). Full table, the
advertised `kinds` and `features`, and the reason `tern capture` — not stdin — is where the errors
appear: **`docs/TSP-ENCODINGS.md`**.

### Clickable file references

`file://` links always open in Tern as a file block (its own documented behaviour). A `rows` node
is inert text, so anything the reader should be able to open has to arrive as **`md`**. Therefore:

- **`lib/refs.ts`** finds the files an agent mentions — markdown links, `` `backticks` ``, bare
  paths, `file://` URLs, `path:line:col` — resolves them against the cwd, checks existence,
  classifies them, and emits `file://` URLs. A bare single-segment name is trusted only when the
  file really exists, or `node.js` in prose becomes a file reference.
- **`tern_files`** — `list` · `preview` · `open` · `aside` · `markdown` (the last rewrites any text
  into clickable `file://` links, for use in a diagram or the session mirror).
- `/tern files [list|preview|open|aside] [ref|index]` for the same thing by hand.
- Assistant replies are scanned on `message_end`, so the references are known without asking.

### Inline markdown preview instead of an unasked full block

- **In native mode:** the **`aside` sheet** — Tern's own right-edge panel, draggable width, its own
  scroll — holding an `md` node of the referenced file with `[Open in split](file://…)` as the first
  line. That link *is* the button.
- **Everywhere else:** `tern open --preview` — Tern's preview block, which is small, sits beside the
  work, and keeps the focus. This route needs no protocol at all and works today from a T3-hosted
  agent.
- **Opt-in**, because opening things unasked is the behaviour this replaces: `PI_TERN_AUTO_PREVIEW=1`.
  It prefers the newest existing markdown file and does nothing otherwise.

### `tern_chart`, `tern_fleet`, `tern_worktree`, `tern_pr`, and the contract

Unchanged from the earlier 1.1.0 notes below: data → themed SVG → native Tern image block, with
`rsvg-convert` rasterizing locally so no visible window is needed; panes as threads; pure-git
worktrees; PR state with a one-line verdict; and the capability manifest from
`tern_status {manifest:true}`. All five new tools plus `tern_files` are `deferred` — **prompt
footprint stays at +774 tokens with three declared tools.**

### Standardisation

`scripts/gate.sh` (types, lint, 61 tests, compat matrix, live no-pane surface check),
`scripts/verify.ts` (19 live checks from outside a Tern pane), `scripts/tsp-probe.mjs` (protocol
conformance), and `profile/` (install README + an `AGENTS.md` fragment).

---

## 1.1.0 — earlier notes

**T3-shaped work and native figures. Everything here works with no Tern pane — only a
running Tern daemon.**

### The pane gate is relaxed (the headline)

The extension used to refuse every tool unless pi itself was running inside a Tern pane
(`TERM_PROGRAM=tern`). The `tern` CLI has no such limit, so the gate was costing the whole
cross-harness composition: a **T3-hosted** or headless agent could not use Tern at all.
Now:

- **CLI-backed tools** (`tern_diagram`, `tern_browser`, `tern_chart`, `tern_capture`,
  `tern_run`, `tern_fleet`, `tern_worktree`, `tern_pr`) require only that `tern --version`
  answers — probed once and cached for 5 s. Errors name the real cause (missing CLI, or
  inside tmux/screen/zellij) instead of blaming a missing pane.
- **Pane-only features** (TSP probe, chrome title, relay push, native surfaces) still say so,
  with `paneRequired()` explaining *why a pane is different* and pointing at the CLI tools.
- Verified live from a T3-hosted agent: `tern open` placed a file block in the running Tern
  window, and `tern browser open/capture` returned a 45,200-byte 1280×800 PNG.

### `tern_chart` — native figures, three routes

| Route | Mechanism | Needs |
| --- | --- | --- |
| `mermaid` | Tern's merman engine (xychart-beta, pie, gantt, gitGraph, timeline, quadrant, sankey, mindmap — 18 diagram types) | Tern daemon |
| data → SVG | pi-tern generates a themed SVG from `data`/`series`; Tern renders it as an image block | Tern daemon |
| `png: true` | local rasterization for the model to read back | `rsvg-convert` (or `qlmanage`, or the browser) |

- Chart kinds: `bar`/`hbar` (labelled bars), `line`, `area`, `pie`, `donut`.
- **Value labels keep full precision** — the axis abbreviates (`75k`), the labels do not (`58,715`).
- **SVG rasterization no longer needs a visible window.** `rsvg-convert` (then `inkscape`, then
  macOS `qlmanage`, then the browser) removes the old failure mode where
  `capture` returned `0×0 px` whenever the Tern window was in the background. Measured: a
  chart that failed at `0×0` through the browser produced a 23,536-byte PNG locally.
- `inline: true` asks native mode to append the figure into the conversation (see below).

### `tern_fleet` — panes as threads

`spawn` (a `pi -p` task, an interactive pi, or any command) · `list` with liveness · `send`
steer text/keys · `read` · `wait --until exit` · `stop`. Task text is written to a file and
read with `"$(cat …)"`, so quotes, newlines and `$` in a prompt cannot corrupt the command.
Members are recorded in `scratch/pi-tern/fleet.json` and reported against a live block list.

### `tern_worktree` — pure git, no Tern required

`list` (with dirty counts) · `create` (new or existing branch, optional `startFromOrigin`) ·
`remove` · `prune` · `status`. Default path is a sibling `repo.wt.<branch>`.

### `tern_pr` — GitHub state, in one line

`summary` (checks collapsed to counts **plus failing names**, and a human verdict) · `list` ·
`comments` (reviews + issue comments) · `watch` (runs `gh pr checks --watch` **in a visible
Tern pane** and waits) · `open` (Tern browser). `status` reports `gh` availability/auth so a
missing CLI is a clear message, not a stack trace.

### The capability contract

`tern_status { manifest: true }` and `/tern capabilities` return one machine-readable document:
contract version, environment (`tern`, `gh`, rasterizer, native, platform), TSP state, tool
exposure, and **every capability with `available` and a `reason` when it is not**. An
orchestrator adapts instead of guessing; a bug report carries its own diagnosis.

### Standardisation

- **`scripts/gate.sh`** (`npm run gate`) — types, lint, tests, the stock-fallback compat matrix,
  and a live no-pane surface check. Nothing ships unless it passes.
- **`scripts/verify.ts`** (`npm run verify`) — 19 live checks, deliberately run from *outside* a
  Tern pane, because that is the regression this release exists to catch.
- **`profile/`** — two files that make this a team standard: an install README with the
  capability/requirement table, and an `AGENTS.md` fragment that tells the agent which surface
  to reach for.

### Native mode: inline figures (instrumented spike)

Tern 0.5.0 advertises the **`blobs`** feature and its frame dialect has an `image` node with a
`blob` prop, so an image can be appended *into the conversation* rather than beside it. The
sink now exposes `figure()` and `frame()`, records every rejected op in `nativeState().lastError`,
and the blob wire shape is selectable (`PI_TERN_BLOB_OP=id-mime-data|mime-data|inline`) because
it is not yet confirmed against a live Tern. **Opt-in:** `PI_TERN_INLINE_IMAGES=1`.

### Fixes found by tightening the tests

- **The compat matrix's two RPC checks had been passing for the wrong reason.** They asserted
  that `pi --mode rpc` output contained the substring `tern`/`commands`/`result` — it never did;
  they matched unrelated output. They now assert the property that matters: the launcher's stdio
  is a **shape-identical stream to stock pi**, with no TSP frame in either.
- `prVerdict` misclassified check states: a `statusCheckRollup` entry carries `conclusion`
  (CheckRun) *or* `state` (StatusContext), never both, and `PENDING` was counted as neither
  failing nor pending.
- Value labels abbreviated large numbers (`58,715` → `59k`).

### Prompt footprint

Unchanged: **+774 tokens**, three declared tools. All five new tools are `deferred` — no schema,
no listing, callable from codemode by name and indexed by `tern_status`.

---

## 1.0.1 — 2026-10-06

- Fix CI: mailbox tests set `PI_TERN_FORCE=1` (the fast non-Tern guard from 1.0.0 otherwise trips on runners without a Tern pane). No runtime change.

## 1.0.0 — 2026-10-06

Native mode, complete: launcher + loader hook, native rows surface, dock split, native composer.

- **M1** `native/` launcher (Tern probe, stock fallback) + loader hook over pi-tui.
- **M2** dock split: transcript rows in `main`, composer/status pinned in `dock`.
- **M3** native composer: pi-tui `Editor` captured and published as a TSP `editor` node
  (`sendable`), with Tern's `edit` / `undo` / `send` events driving pi's own composer API;
  `["suspend"]` / `["resume"]` ops; opt-in surface `adopt` (`PI_TERN_ADOPT=1`).
- **Fix** every frame had been rejected since M1 (`unknown id main/dock`): Tern requires the
  region roots to be added **under the surface id** (`["add","main","<surface>",null,{"id":"main",
  k:"col",…}]`), not addressed as parents. Corrected; zero error events on 0.5.0.
- **Compatibility** 7/7 non-Tern modes (version, print, json, rpc, launcher fallbacks, no TSP
  traffic); launcher refuses native mode for non-interactive flags; extension fails fast outside Tern.
- **Measured**: 0 ANSI writes, 1.43 s to first frame, 0 idle frames, 238 MB RSS, mailbox median
  186 ms (idle poll), 31/31 tests, 79.94 % coverage.
- Findings, corrections and Tern 0.5.0 opportunities: `docs/NATIVE-FINDINGS.md`.


- **Native mode (rows fallback)**: `native/` launcher + probe, loader hook patching
  `ProcessTerminal.write`, ANSI grid to TSP `rows` frames, stock-pi fallback, 100 ms frame
  coalescing. Verified inside Tern: 619 frames, `[Skills] …` content, **0 ANSI writes**; fallback
  outside Tern returns stock 1.0.4. Semantic dock/composer/transcript nodes remain M2/M3.
- **Dock split (M2-lite)**: each frame splits at pi's composer rule — transcript rows to `main`, composer/status pinned in `dock` (verified: `add dock` ×1, `set main`/`set dock` ×2).
- **Compatibility matrix**: `native/compat.mjs` runs version/print/json/rpc + both launcher fallbacks; **7/7**, with no TSP traffic outside Tern.
- Docs: `native/README.md`, `docs/NATIVE-M1.md` (metrics + charts); native unit tests (7).

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
