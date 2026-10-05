# Contributing

Thanks for taking a look. This is a small, deliberately dependency-free extension.

## Ground rules

- **One writer on the pty.** The extension may only write the TSP `hello` probe and, when
  `PI_TERN_BELL=1`, a single BEL. Do not add code that draws TSP surfaces or interferes with pi's
  renderer; that belongs in pi core, not here.
- **No runtime dependencies.** Node builtins, pi's APIs and TypeBox only.
- **Honest status.** If something is not measured, say so in the README and the PR.

## Development

```bash
npm install          # dev dependencies (typecheck only)
npm test             # protocol tests; no Tern needed
npm run test:live    # relay/browser test; run inside a Tern pane
npm run typecheck
```

To try your changes in pi without installing the repo:

```bash
pi --extension ./index.ts
```

## Pull requests

- Open an issue first for behavior changes.
- Keep the diff focused; one feature or fix per PR.
- Update `CHANGELOG.md` and the README status table when behavior changes.
- CI must pass (`node --test test/protocol.test.ts` on Node 24).

## Releases

Push a `v*` tag. `.github/workflows/release.yml` runs the protocol tests and publishes to npm
when an `NPM_TOKEN` secret or npm trusted publishing is configured; otherwise the publish step is
skipped.
