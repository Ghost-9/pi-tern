# Tern 0.9.8: what was measured, and what was not

pi-tern 1.1.x was written and verified against **Tern 0.5.1 / 0.5.2**. This release closes the gap to
**0.9.8 (`f21d9a3`)**, which is what is installed on the machine these measurements come from.

Everything below was produced by a command, and each section says which. Nothing here is inferred
from the changelog: Tern ships no changelog in its bundle, so the binary and its own answers are the
only evidence.

```
$ tern --version
0.9.8 (f21d9a3)
```

## 1. The TSP hello is still `v: 1`, but its vocabulary drifted

Captured with a probe program in a Tern pane, sending exactly what `encodeHello()` sends
(`\x1b_tsp;q;{"q":"hello","v":[1],…}\x1b\\` plus `\x1b[c`) and reading stdin raw:

```
{"r":"hello","v":1,"term":"tern","ver":"0.9.8",
 "kinds":["col","row","card","section","rule","spacer","text","md","code","diff","ansi","math",
          "image","media","kv","table","tree","json","badge","kbd","icon","spinner","shimmer",
          "elapsed","progress","rate","list","item","tabs","editor","input","status","seg","overlay",
          "toast","rows","picker","prefs","tool","checklist","agent","chart","meter","block",
          "effort","el"],
 "features":["blobs","settle","adopt","dock","reduce-motion","aside","scroll","styles","flow"],
 "apc":65536,"credits":2,"cols":160,"cell":{"w":16,"h":33},"dark":false,"reduceMotion":false,
 "hour12":false}
```

| | 0.4.5 / 0.5.x | 0.9.8 | consequence for pi-tern |
| --- | --- | --- | --- |
| reply version | `v: 1` | `v: 1` | the old `v === 1` equality still passes — the risk was real but did not fire |
| node kinds | 44 | **46** (`row`, `media` added; `rows` kept) | the kinds pi-tern emits are all still advertised; unknown extras are now *reported*, not dropped |
| features | 10, incl. `program-palette` | **9**, `program-palette` removed | nothing pi-tern gates on (`image`, `chart`, `aside`, `blobs`) was removed |
| extra fields | — | `hour12` | kept in `TspHello.extra` so a newer build is visible in `/tern doctor` |

So the one thing the old parser would have broken on — a version bump — did not happen in 0.9.8. It
is still fixed, because a hard equality on a number Tern owns is a silent-degradation bug waiting for
the next release: `asHello` now accepts any `v >= 1` (a newer one is used as the v1 subset and
flagged), normalizes `kinds`/`features` from arrays or strings, tolerates a missing vocabulary, and
records *why* a reply was rejected so `absent` no longer covers both "no TSP here" and "a TSP reply I
could not read".

## 2. The surface dialect pi-tern writes is unchanged

One op per frame, after a successful hello, reading Tern's `error` events (measured with `tern serve`
+ `tern ctl 'type …'`, or in a `tern daemon` pane):

| Frame | 0.5.x | 0.9.8 |
| --- | --- | --- |
| `o` (open surface) | accepted | **accepted** |
| `add` `col` under the surface id | accepted | **accepted** |
| `add` `rows`, `md`, `image` (`{data,mime}`), `chart`, `card`, `row`, aside region | accepted | **accepted** |
| `set` / `del` | accepted | **accepted** |
| `blob` op (3-arg) | rejected: `unknown op blob` | **rejected**: `unknown op blob` |
| `set` unknown id | `unknown id …` | **`unknown id …`** (same message shape, `sf`/`s`/`op`/`msg`) |
| `add` under an unknown parent | `unknown id …` | **`unknown id …`** |
| unknown node kind | `unknown kind …` | **`unknown kind …`** |

The error channel still names the surface (`sf`), the frame (`s`), the op index and a message, so
`native/backend.mjs`'s "read the error channel" approach still works. `blob` is still a plugin/canvas
API rather than a frame op, which is why `figure()` inlines image bytes.

## 3. The daemon relay still speaks the same protocol

`lib/relay.ts` greets `{"hello":{}}` on `TERN_PANE_SOCKET` and expects length-prefixed frames. On
0.9.8 `TERN_PANE_SOCKET` is now **the daemon socket** (`/…/daemon.sock`) rather than a per-pane one,
but the protocol is unchanged:

```
$ node --experimental-strip-types -e 'import("./lib/relay.ts").then(async m => console.log(await m.relayPing("<daemon.sock>", 4000)))'
{"ok":true,"ms":3}
```

## 4. `whoami`, `process`: the shape of the two new answers

Measured inside a `tern daemon` pane (`TERN_PANE`, `TERN_PANE_SOCKET` set by Tern):

```
$ tern whoami --json
{"hops":[{"principal":"batra","method":"local","from":"","host":"Mayanks-MacBook-Pro","user":"batra"}]}

$ tern process 3 --json
{"pane":3,
 "child":{"pid":32228,"name":"zsh","argv":["/bin/zsh","-l"],"cwd":"/private/tmp"},
 "group":32228,
 "foreground":{"pid":32228,"name":"zsh","argv":["/bin/zsh","-l"],"cwd":"/private/tmp"}}
```

A 0.9.8 pane also exports the same chain as `TERN_IDENTITY`, so `lib/identity.ts` reads it from the
environment (no subprocess) and only calls `tern whoami --json` when it is absent. Exit codes matter
here: `tern whoami` outside a pane exits **1** with a message, `tern whoami --help` exits **2**
(`unknown argument --help`) — which is why the capability gate compares versions instead of probing
`--help`.

The rest of a 0.9.8 pane's environment, for reference: `TERM_PROGRAM=tern`,
`TERM_PROGRAM_VERSION=0.9.8`, `TERN_PANE`, `TERN_PANE_SOCKET`, `TERN_CONFIG_DIR`, `TERN_IDENTITY`,
`TERN_EXE`, `TERN_BLOB_DIR`, `TERN_COMPLETE`, `TERN_LENSES`, `TERN_PROMPT_FILE`. `TERN_CONFIG_DIR`
did not exist in the variables pi-tern read, and settings written to a hard-coded Application Support
path would be invisible to a Tern launched with it — `ternSettingsPath()` now honours it.

## 5. The plugin: manifest loads, the Luau's API matches, compilation is still unproven

```
$ TERN_CONFIG_DIR=$tmp tern daemon --socket $tmp/daemon.sock &
$ tern plugin link <dir> --json      # {"id":"pi-bridge","version":"1.2.0","dir":"…"}
$ tern plugin reload --json          # {"plugins":[{"id":"pi-bridge",…,"status":"ready"}],"problems":[],…}
```

**What this proves:** the manifest is accepted, Tern reads the shipped version, the daemon compiles it
and reports no problems, and `tern plugin link|reload --json` return the shapes `lib/bridge.ts` now
parses.

**What it does not prove:** that `window.luau` *runs*. Measured: appending `this is not lua` to the
window entry and reloading still reports `status: "ready"` — unchanged from 0.5.x. No window was
started here (no GUI session), so the Luau was checked **statically** instead:

```
$ tern plugin types /tmp/types && node --experimental-strip-types scripts/plugin-api-check.mjs --live
plugin API check — live tern plugin types (tern 0.9.8 (f21d9a3))
  declared: 104 tern paths, 21 extern types
  used by the shipped Luau: 79 symbols
  ok: every symbol the Luau uses is declared
```

`tern plugin types DIR` writes `DIR/tern.d.luau` (96 KB, 2151 lines) — the authoritative contract, and
the first time pi-tern could compare its hand-written Luau with Tern's own declaration. The 0.9.8
declaration is pinned in `test/fixtures/tern-api-0.9.8.json` so the check runs with no Tern installed,
and `test/tern-live.test.ts` repeats it against the installed build when there is one.

### A related regression in the *verification*, not the plugin

`scripts/plugin-check.sh` used to prove a window entry loads by grepping Tern's log for
`plugin window entry failed to load` (and, on success, a line the plugin itself logged) after a
headless `tern serve`. On 0.5.2 that log carried both. **On 0.9.8 a headless `serve` logs neither** —
measured in `~/Library/Logs/Tern/tern-serve.log` with a deliberately broken `window.luau`: the only
lines are the session start and the control endpoint. So "no failure line" no longer means "it
loaded", and the script's old success path was a green tick for a test that had not run.

It now reports `UNVERIFIED …` for that case, says why, and points at the static check. `npm run gate`
still passes (nothing suggests a failure), but the line no longer claims a load nobody observed. This
is a change in what can be *proven* about Tern 0.9.8 headlessly, and it is worth knowing before
building a release check on the old signal.

## 6. `tern shot` needs Tern's own source tree

```
$ tern shot single --out /tmp/shots --theme both
tern: set STENCIL_FIXTURE_ROOT to the app crate directory containing goldens, or supply an explicit path
```

So no golden PNGs were produced here. The live test runs the command and **skips with that reason**
when the fixtures are absent, rather than asserting nothing or failing on a missing crate.

## 7. Headless sessions work, which is why the tests can be real

`tern serve --control <sock>` is a window with no screen, and `tern ctl --control <sock> …` talks to
it; `tern daemon --socket <sock>` keeps panes alive with no window at all. `TERN_CONFIG_DIR` plus a
socket path inside a temp directory makes all of it hermetic, so `test/tern-live.test.ts` runs a real
`tern serve`, a real plugin link/reload, and a real `whoami`/`process` inside a real pane — and skips
with a reason when Tern is not installed.

## What is still unverified

- **A window starting the bridge plugin.** No GUI session here. The manifest and the declared API are
  checked; the Luau's runtime behaviour is not.
- **`pip`, `dock`, `move` and `rename` doing the arrangement.** Only Tern's refusals were observed
  ("picture in picture needs a second block in its tab", "the block is not a picture in picture"), so
  those actions are marked `experimental` in the manifest and in the README.
- **A remote identity chain.** `whoami` was only observed with one local hop. The parser keeps every
  hop and takes the last, and the multi-hop case is unit-tested from a synthetic chain, but no SSH or
  relay hop was ever made here.
- **Tern 0.5.2 itself.** It is not installed on this machine, so "0.5.x still works" rests on the
  captured 0.5.x hello (which parses), the unchanged daemon-relay protocol, and the version gate that
  keeps every new code path off an older build. It was not re-run end to end.
- **Golden screenshots.** See §6.
