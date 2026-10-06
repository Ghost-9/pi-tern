# Native mode (v1.0 M1)

`native/` is the no-core-edit route to Tern-native pi: a launcher probes Tern, then runs pi's
**unbundled** entry with a Node loader hook that patches `ProcessTerminal.write`; an ANSI grid
reconstructs each frame and streams it to a TSP inline surface as `rows` nodes.

## Run it

```bash
node native/install.mjs     # ~/bin/pi-tern -> native/pi-tern.mjs
pi-tern                     # inside Tern: native rows surface; anywhere else: stock pi
```

Inside Tern the launcher:

1. probes with the TSP `hello` + DA1 sentinel (raw stdin, 700 ms; skipped in tmux/zellij);
2. on a reply, spawns `node --import native/register-hook.mjs <release>/dist/cli.js`;
3. the hook appends a patch to pi-tui's `terminal.js`; `ProcessTerminal.write` is replaced by the
   sink (`PI_TERN_NATIVE=1`);
4. on no reply, a missing release entry or any failure it execs the **stock** `pi` launcher.

## Verified (2026-10-06, managed pi 1.0.4, Tern 0.4.5)

| Check | Result |
| --- | --- |
| Probe + native engage inside Tern | TSP record: `o`×1, `f`×619, `x`×1 |
| Frames carry the real screen | Frame content includes pi's `[Skills] …` banner |
| ANSI suppression | `PI_TUI_WRITE_LOG` file never created — **0 ANSI writes** |
| Fallback outside Tern | `node native/pi-tern.mjs --version` → `1.0.4` (stock) |
| Unit tests | 5/5 (`test/native.test.ts`) |
| Frame coalescing | throttle added: max one `f` per 100 ms, unchanged frames skipped |

Limits: rows only — no semantic dock/composer/transcript nodes (M2), RSS unmeasured, no acks
(`listen:false`), and history is the visible grid, not the terminal scrollback.
