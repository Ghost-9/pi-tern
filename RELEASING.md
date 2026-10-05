# Releasing

1. Ensure the tree is clean and the checks pass:

   ```bash
   npm test && npm run typecheck && npm run lint
   ```

2. Bump `package.json` (and `PI_TERN_VERSION` in `index.ts`, the plugin version in
   `lib/bridge-plugin.ts` + `EXPECTED_PLUGIN_VERSION` in `lib/mailbox.ts`), update `CHANGELOG.md`.

3. Commit, tag, push:

   ```bash
   git commit -am "vX.Y.Z: …" && git push
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

4. `.github/workflows/release.yml` runs on the tag and runs `npm publish --access public --provenance`.

   - If npm **publishes directly** (trusted publisher has *Allow npm publish*): done; verify with
     `npm view pi-tern dist-tags`.
   - If the trusted publisher is **stage-only** (npm’s default for connections created after
     2026-09-03), the run succeeds but the version is staged. Approve it on npmjs.com →
     `pi-tern` → Staged versions, or delete and re-create the trusted-publisher connection with
     *Allow npm publish* checked so future tags publish directly.

5. Verify the marketplace path in an isolated home:

   ```bash
   H=$(mktemp -d); HOME=$H pi install npm:pi-tern; HOME=$H pi list
   ```

6. Append a dated line to the vault project note (`pi-harness/47-pi-tern-extension-mvp.md`) with the
   version, npm status and any new measurements.
