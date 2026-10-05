# Changelog

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
