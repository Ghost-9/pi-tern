# AGENTS.md fragment — Tern surfaces

<!--
Append this to a repository's AGENTS.md or to ~/.pi/agent/AGENTS.md when
pi-tern is installed. It tells the agent which surface to reach for, which is
what turns an installed extension into a used one.
-->

## Tern surfaces (pi-tern)

When a Tern daemon is reachable — `/tern capabilities` confirms it, or
`tern_status` with `manifest: true` — prefer these over re-deriving output by hand:

- **Diagrams and charts → `tern_diagram` / `tern_chart`.** Mermaid renders natively
  (flowchart, sequence, state, ER, class, gantt, timeline, gitGraph, pie, quadrant,
  sankey, mindmap, `xychart-beta` bar/line). For data, pass `kind` + `data` and
  pi-tern generates a themed SVG that Tern shows as an image block.
- **Charts you need to reason about → `tern_chart` with `png: true`.** The PNG comes
  back as an image in the tool result, so you can read your own chart instead of
  describing it.
- **A web page → `tern_browser`,** which uses Tern's WKWebView and the human's real
  profile. `capture` returns a PNG.
- **A command the human should watch → `tern_run`.** Never hide a test run or a dev
  server inside `bash` when a visible pane is one call away. `tern_watch --expect`
  waits for a pattern instead of polling.
- **Parallel work → `tern_fleet`.** A pane is a thread: `spawn` (a `pi -p` task, an
  interactive pi, or any command), `read`, `send` to steer, `wait`, `stop`.
- **Isolated branches → `tern_worktree`** (pure git), then `tern_fleet spawn` with
  `worktree` set. One writer per worktree.
- **Pull requests → `tern_pr`.** Ask for `summary` first: it collapses checks into
  counts plus failing names and states readiness in one line.

Rules:

1. **Never claim a visual rendered without a check.** A diagram is verified by the
   block opening; a chart by the PNG coming back. Read the tool result.
2. **Keep the prompt budget.** Everything except `tern_status`, `tern_run` and
   `tern_browser` is `deferred`: call the rest from codemode by name.
3. **Prefer the Tern pane for anything long-running,** so the human can see it and
   keep working.
4. **Degrade, do not fail.** Outside Tern these tools return a clear reason; fall
   back to normal tools and say so, rather than retrying.
