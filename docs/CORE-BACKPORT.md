# Core back-port: no PR, no binary edits — the wrapper + loader-hook route

**Corrected 2026-10-06.** An earlier version of this document claimed the loader hook worked through
the default launcher because `@earendil-works/pi-tui` resolves under it. That was wrong: the hook
fires on *resolve*, but the managed bundle **inlines** pi-tui. Measured on managed pi 1.0.4 / Node
26.10:

| Entry | pi-tui resolves | pi-tui **loads** | load transform applied |
| --- | --- | --- | --- |
| `pi` (managed launcher → `dist/bundle/cli.js`) | 16 | **0** | no |
| `node …/dist/cli.js` (unbundled, piped entry) | 103 | **44** | **44 modules** |
| `node --import <hook> …/dist/cli.js` interactive, inside Tern | — | — | marker written (44 modules) |

The unbundled entry imports real modules from `releases/<v>/node_modules`; a Node loader hook
(`module.register`) therefore transforms pi-tui at load time. The managed launcher resolves the
current release from `~/.pi/agent/install/current-version`; a wrapper does the same and execs the
unbundled entry.

## Wrapper design

```sh
#!/bin/sh
# pi-tern — patched pi when the hook applies, stock pi otherwise
install=$HOME/.pi/agent/install
version=$(cat "$install/current-version")
release=$install/releases/$version/node_modules/@earendil-works/pi-coding-agent
hook=$HOME/.pi/tern/hook/register.mjs
if [ -f "$release/dist/cli.js" ] && [ -f "$hook" ]; then
  exec node --import "$hook" "$release/dist/cli.js" "$@"
fi
exec pi "$@"   # graceful fallback to the stock launcher
```

- **Updates flow.** `pi update` replaces `releases/`; the wrapper reads `current-version` on every
  run. The hook version-gates: an unknown pi-tui layout is left untouched (stock behavior) instead
  of breaking.
- **The patch** is a source transform (or module substitution) applied at load: DA1 probe, frame
  provider, `Component.describe?`, plus the native backend modules.
- **Costs.** Unbundled startup: `--version` 0.49 s vs 0.24 s bundled (module-load only; interactive
  delta still to be measured). Keeping the transform in step with pi-tui internals.

## Alternatives, ranked

1. **Wrapper + loader hook** — full surfaces, no binary edits, upstream updates keep flowing.
2. **Sidecar TSP renderer over `pi --mode rpc`** — pi stays 100% stock; our renderer owns the pane;
   update risk limited to the RPC protocol; the most work.
3. **Minimal upstream seam** (a preload/renderer hook, ~100–300 LOC) — if accepted, the wrapper
   disappears. The maintainers want pi light, so ask for a seam, not the port.
4. **Downstream build** (fork + rebase + build) — full parity, but a rebuild per update.
5. **Extension-side row re-encoding** (monkey-patch `tui.terminal.write` + a screen model) — partial,
   CPU cost, no component semantics; last resort.
