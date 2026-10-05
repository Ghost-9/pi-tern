# Core back-port: can the extension override it instead of patching pi?

**Answer: a pi extension cannot override pi's renderer, but a full native back-port does not
require editing any core binary.** Two routes exist; one is extension-only and partial, one is a
wrapper + Node loader hook that patches `@earendil-works/pi-tui` at load time. Both were checked on
this machine (pi 1.0.3, Node 26.10.0).

## Why an extension alone cannot do it

- `pi` runs `dist/bundle/cli.js`, an esbuild bundle with pi-tui **inlined**
  (`dist/bundle/chunks/chunk-…js`). Nothing in `node_modules` is imported for the TUI.
- pi-tui exposes no frame-provider or renderer seam, and `Component` has no `describe()`.
- An extension can reach the live TUI object through `ctx.ui` factories and monkey-patch
  `tui.terminal.write`, and can write raw bytes to the pty — but it only ever sees rendered ANSI
  rows, never component state. It can therefore emit at best `rows`/`ansi` nodes (a re-encoding of
  the TUI's own output), not semantic `dock`/`composer`/transcript surfaces.

### Extension-only workaround (partial)

A `flow` surface (`mode:"flow"`, `listen:false`) does not own the pane, so an extension can write a
small native widget beside pi's ANSI TUI without core changes. Useful for status cards/diagrams;
frame tearing is possible if a write lands inside the TUI's synchronized-output frames. Not parity.

## The wrapper + loader-hook route (full, no binary edits) — verified

`dist/cli.js` (169 bytes) imports the **unbundled** `dist/main.js`, which imports
`@earendil-works/pi-tui` as a real Node specifier. A Node ESM loader hook intercepts it:

```
$ node --import hook.mjs /…/pi-coding-agent/dist/cli.js --no-session -p "reply OK"
[hook] pi-tui resolved: @earendil-works/pi-tui
```

(With `dist/bundle/cli.js` the hook never fires — the bundle is inlined.)

So the back-port can ship as:

1. a `pi-tern` wrapper command that runs the **unbundled** entry
   (`node --import <hook> …/dist/cli.js "$@"`), and
2. a loader hook that resolves `@earendil-works/pi-tui` to a patched copy (vendored package or a
   source transform), adding the probe, the frame-provider seam and `Component.describe()`.

Verified facts / costs:

- Unbundled `--version`: **0.49 s** vs bundled **0.24 s** (3/3 runs each) — module-load only; a real
  session's delta needs its own measurement.
- Core binaries stay untouched; a `pi update` replaces the package but the wrapper re-applies, and
  the hook can version-gate (refuse to patch an unknown pi-tui layout rather than break).
- The hook must keep pace with pi-tui internals; this is a maintenance burden, not a free lunch.

## Recommendation order

1. **Upstream PR** (probe + `setFrameProvider` + `Component.describe?`): additive, default-off; omp
   already proved the design. Zero maintenance for us.
2. **Wrapper + loader hook** (no binary edits): the pragmatic local route if upstream lags; pin the
   pi-tui version, run the smoke + eval suite before every update.
3. **Extension-only flow surfaces** for small widgets in the meantime; explicitly not parity.

## Patch series outline (for either 1 or 2)

- `terminal.ts`: DA1 sentinel owner + `onTspHello`/`tspProbePending`/`tspExpected`, APC/OSC-877.
- `tui.ts` + screen classes: `setFrameProvider()`, native dispatch that suppresses ANSI frames.
- `Component`: optional `describe(cx)`; rows fallback in the reconciler.
- `native/*`: port encode/apply/reconcile/backend (omp, MIT) with Bun→Node shims.
- coding-agent: composer/dock/transcript describe, `send`/`edit`/`undo`, palette, resume.
