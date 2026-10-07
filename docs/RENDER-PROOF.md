# Render proof — what is verified, and what is not

**Short version: no native surface has been seen to render, and it is currently impossible to make
Tern do it from an automated harness. This file records why, so nobody has to rediscover it, and so
nobody mistakes frame acceptance for a screenshot.**

## The distinction that caused a P0

Releases 1.1.0 through 1.1.4 recorded native surfaces as verified on two pieces of evidence:

- *"the surface tree was accepted with zero errors"*
- *"`PI_TUI_WRITE_LOG` absent → 0 ANSI writes"*

**Both are equally true of a completely blank pane.** The first says Tern parsed the ops; the second
says pi's own TUI stopped writing to the grid — which is also what happens when the surface meant to
replace it never draws. The verification method could not distinguish *renders* from *renders
nothing*, and reported success for a non-rendering feature. The result shipped: native mode removed
the agent's entire interface and displayed nothing.

The root cause was traced afterwards to a second mistake: native surfaces are displayed **only in an
agent block**, and every one of those five tests used `tern new tab`, which makes a **shell block**.
So the tests were looking at a blank pane for a reason unrelated to the protocol.

## Why it is still unproven

> **CORRECTION 2026-10-07 (Tern 0.5.2) — the table below is 0.5.1 behaviour and no longer holds.**
>
> On **0.5.2** the harness *can* create an agent block: `new-blocks agent` returned `{"ok":true}` in
> **8 of 8** attempts, where on 0.5.1 it timed out after 20 s for every command including
> `/usr/bin/true`. The platform limit this file was written for is gone, and the probe now gets past
> it to report the honest next step: **the block was created but no surface content appeared.**
>
> What has *not* changed: **no native frame has been seen to render**, on 0.5.2 either. One step of
> the chain is now open; the step that matters is still closed.
>
> Because whether Tern can host an agent block is Tern's to change, the probe is **no longer gated** —
> it is reported on every run, and `PI_TERN_REQUIRE_ALL=1` makes it hard. Gating our build on it
> would fail for something no commit of ours can fix.
>
> Operationally, while measuring this: **the session daemon exhausts macOS's default 256-fd soft
> limit** under heavy window churn and does not recover — `tern ls` then reports a plainly running app
> as absent. Restart Tern; do not debug pi-tern. Headless `serve` sessions are far cheaper than
> windows. See the changelog for 1.1.12.

A native surface displays only in an agent block. Agent blocks can be created two ways: Tern's UI, or
a scenario sent to a control endpoint. The harness route did not work on Tern 0.5.1 here.

Measured on **0.5.1**, every one of these returned `{"ok":false,"error":"timed out after 20s"}`:

| Command | Result |
| --- | --- |
| `block agent` (offscreen, `tern shot`) | timed out after 20s |
| `agent-command "<anything>"` | timed out after 20s |
| `new-blocks agent` **alone, on a fresh window** | timed out after 20s |
| `agent-command "/usr/bin/true"` | timed out after 20s |
| `agent-command "/bin/sleep 300"` | timed out after 20s |

It fails for *any* command, including `/usr/bin/true`, and fails on `new-blocks agent` without any
`agent-command` at all. So this is not pi-tern's agent failing to boot — the harness cannot create an
agent block on this build at all, and therefore cannot display a surface.

## The screenshot route

`screencapture` is **permitted** on this machine (it returns a full-resolution 3456×2234 image). It
returns the desktop rather than Tern's window: the display reports `ON` via `pmset`, but the capture
shows only the wallpaper. Addressing Tern's window by id is not available either, because
`osascript` has no **Accessibility** permission (`-1728`).

So both screenshot routes are closed for a reason that is *not* the one previously recorded. The
earlier note said "Screen Recording is not granted"; that is no longer the blocker, and neither
permission being granted nor a screenshot succeeding should be assumed without re-measuring.

## What now runs on every gate

`scripts/render-proof.mjs`, wired in as a gate step:

```
=== render proof ===
BLOCKED render proof: new-blocks agent failed: > new-blocks agent
< {"ok":false,"error":"timed out after 20s"}
         Tern displays a native surface only in an agent block, and its own harness cannot
         create one on this build. Acceptance is not display — treat every native render
         claim as UNVERIFIED until this probe passes.
```

It is a **probe**, not an assertion of success. It starts a control window of its own, asks the
harness to create an agent block, and reports the measured answer. The machine-readable result is
written to `render-proof-last.json`:

```json
{ "surface": { "displayed": false, "proven": false, "reason": "harness-cannot-create-agent-block" } }
```

`node scripts/render-proof.mjs --require` exits non-zero unless a surface was actually displayed, so a
release cannot be gated green on acceptance alone.

## The oracle, ready for when the platform allows it

`tern ctl stats` reports the window's live layout counts:

```
{"ok":true,"nodes":594,"frames":88,"images":5,"viewport":[1280.0,800.0,2.0]}
```

A surface with content raises those counts; an empty one does not. That is a real measurement rather
than a validator's opinion, and unlike a screenshot it needs no permission. The harness is written to
use it, so the day `block agent` works the proof is a matter of running it rather than writing it.

## What this means for the claims

| Claim | Status |
| --- | --- |
| Frame ops are accepted by Tern | **verified** — Tern's error channel, `docs/TSP-ENCODINGS.md` |
| A surface can be created with content | **verified** — `capture --surfaces` returns the parsed nodes |
| A surface is **displayed** | **UNVERIFIED** — no pixels, no layout delta, ever |
| The `image` node renders inline | **UNVERIFIED** — accepted, never seen |
| The `chart` node renders | **UNVERIFIED** — *"Tern accepted `{k:"chart"}` — but it does not error on unknown props, so acceptance is not proof"* |
| The `aside` sheet displays | **UNVERIFIED** — mechanism verified, appearance never seen |
| Native mode does not blank the pane | **verified by screenshot once**, in an agent block (the P0's fix), not repeatable in CI |

Until the probe above reports a displayed surface, **no row marked UNVERIFIED may be described as
working** — in a README, a changelog, or a reply to a user.

## Reproducing

```bash
node scripts/render-proof.mjs            # measure and report
node scripts/render-proof.mjs --require  # non-zero unless a surface was displayed
```
