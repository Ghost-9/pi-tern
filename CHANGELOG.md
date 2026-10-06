# Changelog

## 1.1.10 - 2026-10-06

**Verify the artifact, not the repository.**

`npm pack pi-tern@1.1.8` produced a tarball missing `lib/handshake.mjs`, `lib/toolresults.ts`,
`lib/tools-plugin.ts`, `scripts/render-proof.mjs` and `scripts/check-luau-source.mjs`, with a `test`
script naming eight files and shipping **none** of them: `scripts/gate.sh` was included and `test/`
was not, so the shipped package could not run its own gate.

Nothing caught it, because **CI checks out the repository**. Every check said the package was fine,
and every check was true of the source and silent about the artifact — the same failure as the
v1.1.0-tagged run publishing v1.1.8: the artifact and the source drifted apart, and only someone
looking at the artifact would notice.

- **`scripts/check-package.mjs`** packs the real tarball, unpacks it, installs it, and runs the
  shipped suite inside it. It is a gate step and a CI job, so the thing a user receives is what gets
  tested. Verified by removing `test` from `files` and watching it fail.
- **`test/package.test.ts`** asserts that every path a shipped script *names* is actually shipped —
  the cheap, source-only version of the same guarantee, so it runs on every test invocation.
- `package.json` `files` now includes `test` and `tsconfig.json`, which is what lets a user verify
  the package they installed. Given that a bad tarball shipped twice today, being able to check it
  is the point.

One of the four new tests reads `.github/workflows/release.yml`, which is not shipped. It skips
rather than failing when the file is absent, and says why: failing would make the shipped suite
unrunnable and passing silently would claim a check that did not run.

The compatibility matrix's RPC differential also stopped flaking. It compared the exact sequence and
count of message types, and failed about one run in three: `extension_ui_request` is pi asking an
extension a UI question, and how many it asks depends on the extension's own asynchronous work. Both
runs were correct. It now compares the deduplicated *vocabulary*, which is the property the matrix
exists for, and is still verified to catch a real TSP leak.

Gate: **134/134 unit - 10/10 gate steps - 7/7 compat - 19/19 live - strict typecheck clean**, and
**134/134 from the packed tarball**.

## 1.1.9 - 2026-10-06

**The npm 1.1.8 tarball was a partial snapshot, and this is the honest re-release.**

Releasing 1.1.8 surfaced two bugs in the release workflow that had been invisible while it only ever
published on a clean tag.

1. **The run tagged `v1.1.0` published `1.1.8`.** `package.json` had moved on while the tag had not,
   and npm has no way to know — so a version reached npm that no tag described. Nothing errored.
   `release.yml` now fails immediately when `${GITHUB_REF_NAME#v}` disagrees with `package.json`.
2. **A duplicate publish blocked the Release step.** npm rejects re-publishing an existing version,
   and that non-zero exit stopped the job before `gh release create` — so a retag left a version on
   npm with no Release page, which is the exact gap issue #3 was closed for. Publish now tolerates it
   and a separate step verifies the version is actually on npm, so a genuine publish failure still
   fails the run while a re-run still gets its page.

**Why 1.1.8 could not simply be left alone.** `npm pack pi-tern@1.1.8` and unpacking it shows the
published tarball is missing `lib/handshake.mjs`, `lib/toolresults.ts`, `lib/tools-plugin.ts`,
`scripts/render-proof.mjs` and `scripts/check-luau-source.mjs`, and its `test` script names eight
test files rather than nine. It is a snapshot from partway through the work, and a user installing it
would get a package whose stated version promises fixes it does not contain. Re-releasing as 1.1.9
is the only honest remedy.

Everything in the 1.1.8 changelog entries below applies unchanged; this release is the complete set.

Gate: **130/130 unit - 9/9 gate steps - 7/7 compat - 19/19 live - strict typecheck clean.**

## 1.1.8 - 2026-10-06

**The gate stopped being able to lie, and it had been lying about three things.**

An independent audit found that `tsc --noEmit` was near-vacuous: `strict: false`,
`noImplicitAny: false`, and a **15-line** `any` stub standing in for the entire pi and typebox API.
Wiring the real types in immediately found **four real defects** that had shipped.

### The bugs the strict pass found

1. **`ctx.ui.notify(msg, "warn")` in five places.** pi accepts `"info" | "warning" | "error"` — not
   `"warn"`. Its `showExtensionNotify` branches on `error` / `warning` / **else**, so every one of
   those calls silently rendered as an ordinary status line instead of a warning. That includes the
   **block-kind notice from 1.1.6 and 1.1.7** — the two releases whose entire purpose is telling the
   user why their pane is not going native. All fixed to `"warning"`, with a regression test.
2. **`c.createdAt.slice(...)`** in the PR comments view, where `createdAt` is optional. A comment
   with no timestamp threw instead of rendering.
3. **`{ block: spawned.block, ...spawned.member }`** named `block` twice; the member spread already
   carries it, so the first was dead code that read as an override.
4. **Eight `ctx: any` event handlers** removed. Every pi API call in the extension is now checked
   against the shipped `ExtensionAPI`, `ExtensionContext` and `ExtensionUIContext` types.

### What actually changed

- **pi and typebox are real devDependencies** (`@earendil-works/pi-coding-agent`, `typebox`), and
  `types/pi.d.ts` / `types/typebox.d.ts` — the `any` stubs — are **deleted**. Nothing shadows them.
- `tsconfig.json`: `strict: true`, `noImplicitAny: true`, and `native/**/*.d.ts` added to `include`.
- **`native/` is now typechecked and linted.** It is plain `.mjs` with no build step, so
  `native/native.d.mts` declares its surface and `scripts/check-native-types.mjs` fails when a
  declaration names an export the module does not have, **in both directions**. Every one of
  1.1.5-1.1.7 was a launcher fix and the directory was in neither the typecheck nor the lint glob.
- `native/tsp.mjs` gains `nodeOf()`, so the sink tests read a frame op's node slot without a cast.

The typecheck now catches a bad pi method, a bad notify level, and a bad event name — all three
verified by deliberately introducing each and watching the build fail.

### The gate

`scripts/gate.sh` ran **three** of the six test files (47 tests) while `npm test` ran six (80), and
the changelog headline said "80/80 Gate" — describing a command the gate does not run. The test list
is now defined once in the gate and matches `npm test`. `native/` was added to the lint glob, the
declaration check became step 3, and every step prints its counts:

```
ok   tests 82 pass 82 fail 0 skipped 0 todo 0
GATE PASSED (7 run, 0 skip)
```

Skips are now counted and reported: `GATE PASSED (5 run, 2 skip)`. `PI_TERN_REQUIRE_ALL=1` turns any
skip into a failure, for gating a release where "checked nothing" must not read as "all clear".

Gate: **82/82 unit - 7/7 compat - 19/19 live - strict typecheck clean.**

## 1.1.8 - 2026-10-06 (handshake)

**The handshake is a race, and it was being given one chance.**

Measured on identical panes: `scripts/hello-probe.mjs` received Tern's 633-byte reply immediately;
`scripts/tsp-render.mjs` received **nothing across six retries over 2.4 s**. The launcher made a
single 700 ms attempt and fell back to stock pi *silently*, so the only symptom was that native mode
sometimes did not engage.

- **`native/handshake.mjs`** now owns the handshake. It is protocol logic rather than launcher
  bootstrap, which is what makes it testable: the launcher is a top-level script whose job is to be
  invisible outside Tern, so driving it from a test means either spawning pi or spawning stock pi,
  and neither is observable without side effects. Here the seam is a function.
- **Retries, three attempts with linear backoff**, the first success winning.
  `PI_TERN_PROBE_ATTEMPTS` and `PI_TERN_PROBE_TIMEOUT_MS` override the defaults so the race can be
  reproduced deterministically instead of waiting out real timeouts.
- **The failure is recorded, not discarded.** `state.json` gains `probeFailure`, cleared on the next
  success, and `/tern diagnose` reports it. `timeout` (a race) and `no-hello-reply` (the terminal
  answered our DA1 sentinel but does not speak TSP) need different fixes, so they are named
  differently.
- **Unretryable reasons stop the loop.** A terminal that does not speak TSP will not start speaking it
  three attempts later, and retrying only overwrites a precise diagnosis with a generic timeout.
- `PI_TERN_NATIVE_BLOCK=force` still skips the handshake, and says so (`forced: true`) rather than
  pretending a reply arrived.

**Two bugs found by the tests written for this, both in the new code:**

1. The "is this junk?" check originally fired when the buffer held no *complete* message. A reply
   split across two reads is incomplete on the first read, so a perfectly good 633-byte reply would
   have been rejected — reintroducing the very failure the retry loop exists to prevent. The check is
   now "does this start with a TSP frame at all", not "is a message complete".
2. Breaking early on an unretryable reason reported `attempts: 3` when one had been made, which would
   have told `diagnose` a race happened when none did.

`test/handshake.test.ts` — **12 tests**, no Tern and no pty needed: first-attempt success, a late
reply still winning, every attempt failing, a split reply reassembling, DA1-only being named
separately from silence, raw mode set and restored, the multiplexer/`not-interactive` skips, the
force path, and the record/clear cycle. It also asserts the listener is detached afterwards, since one
left attached keeps reading pi's keystrokes.

While writing it, a fixture with `"v": [1]` made `isHelloReply` look broken. It is not: the captured
reply carries a scalar `"v":1`, while the hello we *send* carries `v: [1]`. The fixture now cites the
captured bytes, because a test that encodes the wrong shape teaches the wrong thing.

Gate: **110/110 unit - 8/8 gate steps - 7/7 compat - 19/19 live - strict typecheck clean.**


## 1.1.8 - 2026-10-06 (panes)

**Two always-on costs, both fixed at the source rather than tuned.**

### `tern_fleet prune`

`--keep-open` is unconditional, and it should be: a spawned pane must outlive its command so its
output can be read, and a `pi -p` task that finishes in three seconds should not take its transcript
with it. The cost is that panes accumulate for the lifetime of the Tern daemon — which survives app
updates by design, so the leak only clears on a daemon restart.

`prune` is now a real verb, and conservative on purpose, because closing the wrong pane destroys work
a person can see. It only closes panes that this fleet recorded, whose command has exited, that have
been idle past a floor (default 30 minutes), and that are neither the caller's own pane nor otherwise
claimed. Every pane it declines to touch is reported **with its reason**, so a prune never looks like
it silently ignored something. `dryRun` first is the safe habit. `minAgeMinutes` tunes the floor.

Nine tests, isolated by pointing `HOME` at a temp dir *and* taking `tern` off `PATH`, with liveness
injected — a test that can reach the daemon is a test that can close somebody's pane.

### `tern_watch --expect` no longer starts a process every 500 ms

`waitForText` polled `tern capture` on a fixed 500 ms interval. Over a 15-minute
`gh pr checks --watch` that is roughly 1800 processes, for something the daemon is already pushing.

It now subscribes once via the existing `lib/events.ts` stream, uses a wake-up as the reason to
re-read, and falls back to backing-off polls (1.5 s doubling to 10 s) if events do not flow. The
semantics are unchanged — the match is still made against real pane output — and the reply says
which path ran (`via: "events" | "poll"`), so the fallback is visible rather than silent.

Gate: **119/119 unit - 8/8 gate steps - 7/7 compat - 19/19 live - strict typecheck clean.**


## 1.1.8 - 2026-10-06 (render proof)

**The P0's real cause is now a gate step that runs on every build.**

`scripts/render-proof.mjs` starts a control window of its own, asks Tern's harness to create an agent
block, and reports the measured answer. It is a probe, not an assertion of success, and it writes a
machine-readable `render-proof-last.json`. `--require` exits non-zero unless a surface was actually
*displayed*, so a release cannot be gated green on frame acceptance alone.

**The finding: it is currently impossible, and it is a Tern limitation rather than a pi-tern defect.**
Native surfaces display only in an agent block, and on Tern 0.5.1 here every harness command that
creates one returns `{"ok":false,"error":"timed out after 20s"}` — for **any** command, including
`/usr/bin/true` and `/bin/sleep 300`, and `new-blocks agent` alone times out on a fresh window. So the
harness cannot host an agent block at all.

**And the previously recorded blocker is wrong.** The vault says Screen Recording is not granted. It
*is*: `screencapture` returns a full-resolution 3456×2234 image. What it returns is the desktop, not
Tern's window, while `pmset` reports the display `ON`; and addressing the window by id needs
Accessibility, which `osascript` does not have (`-1728`). Neither route is open, but for different
reasons than recorded.

**The oracle is ready for when the platform allows it.** `tern ctl stats` reports live layout counts
(`nodes: 594`, `frames`, `images`); a surface with content raises them and an empty one does not.
That is a measurement rather than a validator's opinion and needs no permission.

Full write-up, with the reproduction commands and a claim-by-claim table of what is verified against
what is merely accepted: [`docs/RENDER-PROOF.md`](docs/RENDER-PROOF.md).

Gate: **119/119 unit - 9/9 gate steps - 7/7 compat - 19/19 live - strict typecheck clean.**


## 1.1.8 - 2026-10-06 (tool results)

**A `git diff` used to reach the reader as `+` and `-` characters, while Tern ships real widgets for
exactly that. It does not any more.**

### `pi-tern-tools` — a second plugin, deliberately

Tern gives every plugin window entry a **50 ms load budget**, and `pi-bridge` was already at it: its
window entry is the data plane's mailbox, one branch per operation. Measured on Tern 0.5.1, adding
the tool-results rendering to that file took it from ~3-in-5 loads to ~1-in-4.

Worse, an over-budget load fails as a **runtime** error —

```
error=runtime error: tern: load exceeded 50 ms
```

— which reads exactly like a syntax error to anything grepping `failed to load`. That is the fourth
time that particular confusion has cost this project a cycle, and it cost one here while building
this. So the rendering moved to its own plugin with its own budget. `pi-bridge` is back to 644 lines
and loads reliably; the new file is 186.

The widgets come from Tern's own generated types (`tern plugin types` → `tern.d.luau`), so the
signatures are authoritative rather than remembered:

```
diff:         (text: string, path: string?) -> Node
code:         (text: string, lang: string?, start: number?) -> Node
test_summary: (passed: number, failed: number, skipped: number, took: string?) -> Node
```

Open it with **ctrl+shift+f11**. Each widget call is its own `pcall`, so a malformed entry costs that
card rather than the panel.

### `lib/toolresults.ts` — classifying, and knowing when not to

`diff` when there is a real hunk header; `code` when a file's contents come back with a language Tern
can highlight; `test_summary` only when a runner printed **countable** numbers **and** something
failed; otherwise muted text, and `null` for output worth nothing. A confident-looking 0/0/0 meter in
front of the reader would be worse than the text it replaced, and an error message is never source
however `.ts` the file it failed to read was named.

Twenty tests. `pi-tern-tools` is installed and linked automatically with `pi-bridge`, and reads only —
it never writes the mailbox files `pi-bridge` owns.

### Two bugs, both caught immediately by the new checks

- A **forward `goto`** cannot jump into the scope of a local, and that block declares four. It is a
  compile error visible only on a window start — exactly the trap `plugin reload` cannot see.
  Restructured as a nested `if`.
- Three **bare backticks in a Luau comment** terminated the TypeScript template literal. Caught by
  `scripts/check-luau-source.mjs`, which is why that script exists; the check now scans **every**
  `*_LUAU` template in `lib/`, found by naming convention, so a new plugin cannot skip it.

### And the gate stopped being flaky

`pi-bridge` failing ~1 run in 5 made the whole gate unreliable, which is worse than no gate. The
check now separates the two failure kinds, because they need opposite handling:

- **`syntax error`** — deterministic. The code is wrong; another attempt fails identically. Fails
  immediately.
- **`load exceeded 50 ms`** — transient. The machine was busy. Retried up to three times.

Verified both: an injected syntax error fails on attempt 1 and says so; the gate then passed **4/4**
consecutive runs, against 2/3 before.

Gate: **130/130 unit - 9/9 gate steps - 7/7 compat - 19/19 live - strict typecheck clean.**


## 1.1.7 — 2026-10-06

**The block notice is said once, and it now comes with the command that fixes it.**

### The report

The 1.1.6 notice appeared on every launch:

> Tern *terminal* block: native surfaces need an agent block — open one (or set Tern's
> agent_command to pi-tern) to get them.

Two faults. It was **repeated**: the "already told them" flag did not exist, and the pane-kind cache
is keyed by pane id — which is new every launch — so every new terminal block re-notified. And it was
**not actionable**: "open one" did not say how, and the advice was produced without checking what Tern
actually offers.

### What Tern actually offers (from its own settings docs)

Two keys decide this, and neither was named in the notice:

| Key | Tern's own description | Value that makes native surfaces work |
| --- | --- | --- |
| `new_blocks` | "what new tabs and splits open" | `"Agent"` |
| `agent_command` | "what a block runs: the login shell, or this" (defaults to `omp`) | the pi-tern launcher |

### `/tern agent-setup`

One command applies both: it backs up `~/Library/Application Support/Tern/settings.json`, writes the
two keys, and reports exactly what changed (including the previous values). Tern watches that file and
reloads on save, so the next tab is an agent block running pi-tern with native surfaces. If the write
fails, the error names both keys and the file so they can be set by hand.

### Said once, by both halves

The launcher and the extension now share one flag in `state.json` (`blockNotice`), so whichever speaks
first, the other stays quiet — for 30 days, not per pane. `PI_TERN_QUIET_BLOCK_NOTICE=1` silences it
entirely, and `/tern diagnose` always reports the block kind on request. The launcher's five-line wall
is now one line.

Verified: run 1 in a terminal block writes the flag, run 2 does not re-emit; and the mailbox round trip
that answers the question is confirmed working end to end (`paneKind: {"pane":"7","kind":"terminal"}`
in `state.json`).

Gate: 80/80 unit · 7/7 compat · 19/19 live · plugin loads.


## 1.1.6 — 2026-10-06

**Startup latency fixed: the block-kind decision moved *before* native mode, and the default flipped
to the interface that always works.**

### The report

"pi-tern takes a lot of time to actually render on Tern" — with the 1.1.5 notice appearing after a
long wait. Measured cause: `pane.kind` was asked **after** pi had already gone native, with a 6 s
timeout, so when no Tern window answered the mailbox the full **4,013 ms** elapsed (measured, one
request, `ok=false`) before the fallback ran. On top of pi's own ~5 s start, that is ten seconds of
blank pane in the case that then gets thrown away anyway.

### The fix — ask first, and only then decide

- **`native/pi-tern.mjs`** now asks the block kind *before* spawning pi, using the pi-bridge mailbox
  directly (it is only two JSON files in a shared directory, so the launcher needs neither pi nor the
  extension). Bounded by `PI_TERN_KIND_TIMEOUT_MS` (600 ms default), with a stale-response guard and
  the request file always cleaned up.
- **Native mode is now the special case, not the default.** If the kind is not `agent` — a terminal
  block, an unresponsive mailbox, an unknown kind — pi starts in its own interface, which works
  everywhere. Native mode is only entered when Tern has actually said it will display the surface.
- The notice is printed **before** pi starts, so it is readable at once and nothing has to be undone.
- `PI_TERN_NATIVE_BLOCK=force` still forces native mode; `PI_TERN_SKIP_KIND_CHECK=1` skips the ask.

### The extension side

- The check now runs only when the launcher did not already decide (`PI_TERN_BLOCK_KIND`), waits
  **1200 ms instead of 6000**, and **remembers the answer per pane** in `state.json` — a pane's kind
  never changes, so on a restart the check costs nothing at all.
- In a terminal block, where there is no surface to hand back, the user still gets one explanation
  through pi's own UI rather than silence.

### Measured

| Run | Launcher | First content | Blank period |
| --- | --- | --- | --- |
| before | 1.1.5 (check after native) | never within 20 s | the whole time |
| after | 1.1.6 (decide first) | **917 ms** | none |

`tern capture` is not a reliable timer for a pane that has a surface — it reports nothing whether or
not the pane is drawn — so the "after" figure comes from a run where **no surface was created at
all**, which is precisely the change. A visual confirmation in a terminal block is the outstanding
check, and it needs the Tern window in front.

Gate: 80/80 unit · 7/7 compat · 19/19 live · plugin loads.


## 1.1.5 — 2026-10-06

**The block-kind trap, fixed at the root — and the reason the previous release looked broken.**

### Native surfaces display only in an **agent** block

Tern draws a TSP surface in an **agent** block. In a **shell** block it accepts every frame, the
surface materialises (`capture --surfaces` returns the parsed content) — and **nothing is ever
drawn**. The pane is blank, and no error appears anywhere. That is what "native mode renders
nothing" turned out to be, and it cost a day: five tests used `tern new tab -- <cmd>`, which makes a
shell block, and every one of them was looking at a blank pane for that reason.

A screenshot with both kinds side by side settled it in one image: shell pane blank, agent block
showing pi's transcript, its `[Context]`/`[Skills]` sections and Tern's composer status line.

### The fix: detect it and hand the terminal back

- **`native/patch.mjs`** exposes `fallback(reason)` on the native sink. It closes the surface and
  flips `active`, so `ProcessTerminal.write` routes to the original ANSI writer again — pi's own
  interface comes back on the grid.
- **`lib/bridge-plugin.ts`** gains a `pane.kind` mailbox op, reading `cx.session:panes()`. This is the
  only place a block kind is exposed: `tern inspect --json` carries client kinds only, and
  `tern whoami` carries just the identity chain.
- **`index.ts`** checks at session start. Wrong kind → hand the terminal back and say why. A mailbox
  that cannot answer never blocks a session, and `PI_TERN_SKIP_KIND_CHECK=1` disables the check.
- **`/tern diagnose`** now reports the block kind and whether native surfaces can display there.

### Guards, because this class of bug is invisible by construction

- **`scripts/plugin-check.sh`** — reload, force a window start (`tern --exit-after-first-frame`), grep
  the log for `plugin window entry failed to load`. `tern plugin reload` exits 0 and `plugin list`
  still says `ready` for a plugin that cannot load at all, so this is the only honest check. It is in
  the gate.
- **`test/bridge-luau.test.ts`** now also asserts the op list has no truncated or duplicated branches
  — a stray `(` reached the tree while adding `pane.kind`, invisible to a quote-balance check.

### Also

- README: a dedicated section on the agent-block requirement, the `agent_command` setup, and the
  daemon-lags-the-binary gotcha (observed: binary 0.5.1, hello `ver: "0.5.0"` — the session daemon
  survives an app update by design, so restart it before attributing behaviour to a version bump).

Gate: 80/80 unit · 7/7 compat · 19/19 live · plugin loads.


## 1.1.4 — 2026-10-06

**One fix: the mailbox guard contradicted the capability manifest.**

The manifest reports the data plane available from `bridgeStatus()` (the plugin is installed and
current), but `assertTernReady` still demanded `TERM_PROGRAM=tern` or a pane socket — so a
T3-hosted agent was told the data plane was available and then refused when it tried to use it.

The exchange is a filesystem one: this process writes `request.json` into the shared scratch
directory and the plugin, running in a Tern **window**, answers. A pane was never required. The
guard now fails only when pi-tern was never installed (no `window.luau` in the bridge directory),
and otherwise lets the mailbox's own timeout report the truth. Verified from outside a pane: no
early refusal, and an honest timeout — `is the pi-bridge plugin loaded? (press ctrl+shift+f10 in
Tern once, or /tern bridge install)`.

Gate: 78/78 unit · 7/7 compat · 19/19 live from outside a Tern pane.

## 1.1.3 — 2026-10-06

**Fixes from an independent read-only audit of 1.1.2, including one P0 that made the data plane
unusable.** Every item below is the audit's finding plus the fix; the audit was run in parallel with
the 1.1.2 build, by a fresh-context reviewer that only read code.

### P0 — the version guard rejected the plugin it ships

`lib/mailbox.ts` held a hand-maintained `EXPECTED_PLUGIN_VERSION = "0.9.0"` while the plugin had
moved to `1.1.2`. `awaitResponse` rejects any reply whose `v` differs, so **every** data-plane call
(`tern_db`, `tern_doc`, `tern_board`, `tern_carly`, `tern_notebook`, `tern_settings` and their
`/tern …` commands) returned "the Tern window still runs old plugin code" on a *fresh* window. The
constant is now derived from `BRIDGE_PLUGIN_TOML`, and `test/bridge-luau.test.ts` asserts that the
manifest, the Lua `PLUGIN_VERSION` and `package.json` all agree — the drift cannot recur silently.

### P1 — the capability manifest described a different program

`data.docs/boards/sqlite` and `carly.ask` were reported available whenever the *Tern CLI* answered,
but they are served by the Tern **plugin**, and the mailbox refused to run outside a pane. An
orchestrator trusting `tern_status {manifest:true}` would schedule work that always failed. The
manifest now takes its answer from `bridgeStatus()` (installed **and** current), with a reason naming
the installed version when they differ, and the mailbox's pane requirement is relaxed to "a Tern
window is running" — a pane was never actually needed.

### P1 — two input holes

- **Shell injection.** `prWatch` interpolated the PR selector into `gh pr checks <selector> --watch`
  and ran it under `sh -lc`, so `;`, `&`, `|` or a URL with a query string became a second command.
  `safeSelector()` validates to `[A-Za-z0-9._~#:/@-]` and single-quotes it; the direct (non-pane)
  path now passes argv to `gh` with no shell at all.
- **Regex.** `tern_watch --expect` compiled a model-supplied pattern unguarded and ran it over the
  whole capture buffer, so a bad pattern threw a raw `SyntaxError` and a pathological one blocked the
  event loop — a stall the surrounding timeout could not interrupt. The pattern is compiled once
  inside a `try`, and the haystack is capped at 16 KB.

### P2 — the rest of the audit

| Fix | Detail |
| --- | --- |
| A `PENDING` status check counted as failing | `prVerdict` said "1 failing check" for a queued status; the changelog had claimed this was fixed when it was not. |
| `relayPing` could never fail | It swallowed the error and always returned `ok: true`, so `/tern diagnose` reported a healthy relay with `PI_TERN_RELAY=0` or a dead socket. |
| `new URL(...).pathname` | Three native entry points resolved their own path that way, so a space in `HOME` broke the loader hook **silently** (missing hook means it falls back to stock pi). Now `fileURLToPath`. |
| `tern events` stderr | Piped and never read: a chatty line could fill the 64 KB pipe and stall the child until the timeout. |
| Native input buffer | One stray TSP prefix with no terminator made `handleInput` swallow every keystroke afterwards; past 8 KB the bytes are handed back to pi. |
| Native repaint | Frames were only published on a synchronized-output write, so a resize clear or a startup write could leave the surface visibly stale. The debounce already prevents flooding. |
| Dock-split rule | The regex matched any line *containing* eight rule characters, so a markdown `----------` or a diff hunk in the transcript could be reclassified as the composer and moved into `dock`. Anchored. |
| Dead `bridgeStatus()` | Exported and called from nowhere; it now gates `ensureBridge`, so a stale plugin self-heals instead of running last release's Luau — and the write is skipped entirely when the version already matches. |
| `scratchDir()` per call | Ran `mkdirSync` on every invocation (several per turn, via `stateFile()`); memoised **per home directory**, so a changed `HOME` still resolves correctly. |
| Dashboard rewrite per turn | Two files plus a full `JSON.stringify` were rewritten on every `turn_end` even when nothing changed; now fingerprinted and skipped. |
| Gate weaker than CI | `scripts/gate.sh` ran three of five test files and linted neither `scripts/` nor `native/`; it now runs `npm test` and lints both. |
| `verify.ts` had a check that could not fail | `record("fleet: stop", true, …)` — the pass flag was hard-coded, so "19/19" over-counted by one. |
| `/tern` advertised four subcommands that do not exist | `chart`, `fleet`, `pr` and `worktree` are tools, not subcommands; the description now says so. |

**Reported and deliberately not changed** (design decisions, not defects): visible panes accumulate
because `--keep-open` is unconditional and only `tern_fleet stop` reaps one; `tern_watch --expect`
spawns a `tern capture` process per 500 ms poll; `types/pi.d.ts` is an identity stub, so `tsc` is not
evidence about the pi API surface.

Gate: 78/78 unit tests · 7/7 compat · 19/19 live checks from outside a Tern pane.
Prompt footprint unchanged: +774 tokens, three declared tools.

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
