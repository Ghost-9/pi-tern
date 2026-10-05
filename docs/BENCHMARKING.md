# Benchmarking

Two measurements cover the extension: **mailbox latency** (extension ↔ pi-bridge plugin) and
**prompt-token delta** (what pi-tern adds to the model's prefix).

## Mailbox latency

Run inside a Tern session with the plugin loaded:

```bash
node --experimental-strip-types scripts/bench.ts
```

Baseline after 0.9.0 (adaptive: 100 ms for 5 s after activity, 250 ms idle; three direct tools):

| Measurement | 0.7.0 | 0.8.0 | 0.9.0 |
| --- | --- | --- | --- |
| ping | min 365 / median **730** / max 852 ms | min 62 / median **252** / max 368 ms | min 62 / median **66** / max 314 ms |
| batch of 3 ops | ~2,200 ms | **251 ms** | ~250 ms |
| prompt delta | **+3,679** tokens | **+1,309** tokens | **+774** tokens |
| tests | 16 | 18 | 20 |

`db.query` on a 10,000-row table was mailbox-bound (733 ms vs 730 ms ping in 0.7.0), so optimize the
mailbox, not SQLite. The adaptive poll means the first request after an idle period pays the 250 ms
poll; subsequent requests inside the 5 s window pay ~100 ms.

## Prompt-token delta

Pi records per-message usage in the session JSONL. The comparison toggles only the extension:

```bash
# with the extension
D=$(mktemp -d); (cd /tmp && pi --session-dir "$D" -p "reply with exactly: OK")
# without it: move ~/.pi/agent/extensions/pi-tern aside first, then run the same command
# parse the first assistant usage from the newest .jsonl:
python3 - "$D"/*.jsonl <<'PY'
import json, sys
for line in open(sys.argv[1]):
    o = json.loads(line)
    u = (o.get("message") or {}).get("usage")
    if u and (o.get("message") or {}).get("role") == "assistant":
        print("input", u.get("input"), "cacheRead", u.get("cacheRead"), "total", (u.get("input") or 0) + (u.get("cacheRead") or 0))
        break
PY
```

Baseline 0.7.0 (all tools declared): **21,889 → 25,568 prompt tokens, +3,679 (+16.8 %)**.
0.8.0 (5 direct tools, the rest deferred): **21,704 → 23,013, +1,309 (+6.0 %)**.
0.9.0 (3 direct tools): **21,704 → 22,478, +774 (+3.6 %)** — an 79 % reduction overall. n=3 per arm is
enough to see the structural change; it is not a significance test. The addition sits in the cached
prefix, so warm turns pay cache-read prices (~0.003 USD/M ≈ **0.000002 USD/turn** for the extra 774
tokens).
