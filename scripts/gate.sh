#!/usr/bin/env bash
#
# The release gate. Nothing ships unless all of this passes.
#
#   1. types            tsc --noEmit
#   2. lint             oxlint
#   3. unit tests       protocol + native + features
#   4. stock fallback   the launcher must be invisible outside Tern (compat matrix)
#   5. live surface     the CLI-backed features must work with no Tern pane
#
# Set PI_TERN_SKIP_LIVE=1 to skip (5) — it needs a running Tern and costs ~30s.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

failures=0
step() {
	local name="$1"
	shift
	printf '\n=== %s ===\n' "$name"
	if "$@"; then
		printf 'ok   %s\n' "$name"
	else
		printf 'FAIL %s\n' "$name"
		failures=$((failures + 1))
	fi
}

step "types" ./node_modules/.bin/tsc --noEmit
step "lint" ./node_modules/.bin/oxlint index.ts lib test
step "unit tests" node --experimental-strip-types --test test/protocol.test.ts test/native.test.ts test/features.test.ts

# The compatibility matrix is the "never break stock pi" guarantee.
if [ -f native/compat.mjs ]; then
	step "stock fallback (compat matrix)" node native/compat.mjs
fi

if [ "${PI_TERN_SKIP_LIVE:-0}" != "1" ]; then
	if command -v tern >/dev/null 2>&1; then
		step "live surface (no Tern pane)" node --experimental-strip-types scripts/verify.ts
	else
		printf '\n=== live surface ===\nskipped: `tern` is not on PATH\n'
	fi
fi

printf '\n'
if [ "$failures" -eq 0 ]; then
	echo "GATE PASSED"
	exit 0
fi
echo "GATE FAILED ($failures step(s))"
exit 1
