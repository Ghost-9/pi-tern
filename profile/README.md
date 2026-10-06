# Adopting pi-tern as a team standard

Two files, installed once. Nothing else changes about how anyone uses pi.

## 1 — Install the extension

```bash
pi install npm:pi-tern          # or: pi install git:github.com/Ghost-9/pi-tern
```

That is the whole extension half: TSP probe, native diagrams and charts, Tern's
WKWebView browser, pane run/capture/watch, fleet panes, worktrees, PR state, the
data plane and the session mirror. It is version-independent and needs no pi
internals.

**Native mode is separate and opt-in.** It renders pi's transcript and composer as
Tern surfaces by source-transforming `@earendil-works/pi-tui` through a loader
hook, so it carries a rebase cost on every pi release. Ship it only to people who
ask for it:

```bash
~/bin/pi-tern            # instead of `pi`, inside a Tern pane, with PI_TERN_NATIVE=1
```

Everything degrades to stock `pi` when Tern is absent, when you are in
tmux/screen/zellij, or when any of its steps fail. That fallback is enforced by
`npm run gate`, not by hope.

## 2 — Add the agent contract

Append `AGENTS.fragment.md` to the repository's `AGENTS.md` (or to the user-level
`~/.pi/agent/AGENTS.md`) so the agent prefers Tern surfaces when they exist.

## 3 — Verify the install

```bash
/tern capabilities        # in a session, or:
pi -p "call tern_status with manifest true and summarise what is available"
```

The manifest names every capability, whether it is available, **and why not**.
A team can paste it into a bug report and skip the first three questions.

## What the team gets, and what it does not

| Capability | Works | Needs |
| --- | --- | --- |
| Native Mermaid diagrams and data charts | anywhere Tern runs | `tern` on PATH |
| Charts as PNG for the model to read back | anywhere | `rsvg-convert` (no window needed) |
| Tern's browser with the human's real profile | anywhere Tern runs | Tern window for the visible pane |
| Visible panes, wait-for-pattern, fleet | anywhere Tern runs | `tern` on PATH |
| Git worktrees | anywhere | git |
| PR summary / checks / watch | anywhere | authenticated `gh` |
| Live docs, boards, SQLite | Tern window open | the pi-bridge plugin |
| Native surfaces, inline figures | Tern pane | native mode (opt-in) |
| tmux, screen, zellij, plain SSH | **no** | — |

## Operational notes

- **Pin the version** in your bootstrap (`pi install npm:pi-tern@1.1.0`) and bump
  deliberately; `pi update` should not move a team standard under anyone's feet.
- **One kill switch per feature**, all tested: `PI_TERN_NATIVE=0`,
  `PI_TERN_RELAY=0`, `PI_TERN_BRIDGE=0`, `PI_TERN_RUN=0`, `PI_TERN_INLINE_IMAGES=0`.
- **Cost per session**: the extension declares three tools (+774 prompt tokens,
  measured n=3 and reproduced from the live manifest within 1.3%). Everything else
  is `deferred` and costs nothing until it is called.
- **Privacy**: the browser uses Tern's own WKWebView profile, including its
  cookies. `tern_db` refuses credential-looking tables unless explicitly allowed.
  Nothing is sent anywhere; Tern is local.
