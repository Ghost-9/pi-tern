#!/usr/bin/env bash
#
# The release gate. Nothing ships unless all of this passes.
#
#   1. types            tsc --noEmit  (strict; pi + typebox resolved from node_modules)
#   2. lint             oxlint (TS + the native/ launcher, which is plain .mjs)
#   3. native decls     native/*.d.mts must match what the .mjs modules actually export
#   4. luau source      the generated Luau is intact before anything imports the module
#   5. render proof     was a native surface actually DISPLAYED, or only accepted? (see below)
#   6. unit tests       the SAME file list `npm test` runs — one list, defined once below
#   7. stock fallback   the launcher must be invisible outside Tern (compat matrix)
#   8. plugin loads     a window start is what compiles the Luau; `plugin reload` cannot
#   9. live surface     the CLI-backed features must work with no Tern pane
#
# Every step reports a count. A skipped step says SKIP and is counted separately, so a green
# run can never be read as "checked everything": the last line is `GATE PASSED (N run, M skip)`.
#
#   PI_TERN_SKIP_LIVE=1   skip the steps that need a running Tern (8, 9); costs ~30 s
#   PI_TERN_REQUIRE_ALL=1 turn any skip into a failure — use this to gate a release
#
# The full compat matrix (7 checks) spends model calls, so it needs credentials and a working
# model. CI runs the static tier (`native/compat.mjs --static`), which covers the guarantee that
# actually broke: the launcher's stdio is shape-identical to stock pi's, with no TSP frame.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# One definition of the unit suite, shared with package.json's `test` script. Adding a file here
# is the only edit needed; the changelog's "NN/NN unit" claim and this gate cannot drift apart.
UNIT_TESTS=(
	test/protocol.test.ts
	test/native.test.ts
	test/features.test.ts
	test/refs.test.ts
	test/bridge-luau.test.ts
	test/agent-setup.test.ts
	test/version.test.ts
	test/handshake.test.ts
	test/fleet-prune.test.ts
	test/native-sink.test.ts
)

failures=0
ran=0
skipped=0

# summary <label> <logfile> — pull the node test runner's counts out of a log. It prints them with a
# U+2139 glyph prefix ("ℹ pass 80"), not "#", so match the line content rather than a sigil.
summary() {
	local label="$1" log="$2" line
	line=$(grep -Eo '(tests|pass|fail|skipped|todo) [0-9]+' "$log" | head -5 | tr '\n' ' ')
	if [ -n "$line" ]; then
		printf '%s %s\n' "$label" "$line"
	else
		# tsc and oxlint report only an exit code; say so rather than implying a count exists.
		printf '%s exit 0, no pass/fail count emitted by this tool\n' "$label"
	fi
}

skip() {
	local name="$1" why="$2"
	skipped=$((skipped + 1))
	printf '\n=== %s ===\nSKIP %s: %s\n' "$name" "$name" "$why"
	if [ "${PI_TERN_REQUIRE_ALL:-0}" = "1" ]; then
		failures=$((failures + 1))
		printf 'FAIL %s (PI_TERN_REQUIRE_ALL=1 turns a skip into a failure)\n' "$name"
	fi
}

# step <name> <logfile> <cmd...> — run, print the counts, count as ran.
step() {
	local name="$1" log="$2"
	shift 2
	ran=$((ran + 1))
	printf '\n=== %s ===\n' "$name"
	if "$@" >"$log" 2>&1; then
		summary 'ok  ' "$log"
		return 0
	fi
	summary 'FAIL' "$log"
	printf -- '--- %s output ---\n' "$name"
	cat "$log"
	printf -- '--- end %s ---\n' "$name"
	failures=$((failures + 1))
	return 1
}

LOG=$(mktemp -d)
trap 'rm -rf "$LOG"' EXIT

step "types" "$LOG/types.log" ./node_modules/.bin/tsc --noEmit

# native/*.mjs is the launcher: every one of 1.1.5-1.1.7 was a launcher fix and it was in neither
# the typecheck include nor the lint glob. oxlint parses plain JS, so it can check it as-is.
step "lint" "$LOG/lint.log" ./node_modules/.bin/oxlint index.ts lib test scripts native

# The launcher is plain .mjs, so its types are a hand-written declaration file. A declaration that
# names an export the module does not have type-checks green against an API that is not there,
# which is how the strict pass in 1.1.8 would have been able to lie.
step "native declarations" "$LOG/nativetypes.log" node scripts/check-native-types.mjs

# Runs before the unit tests on purpose: a bare backtick in the Luau breaks the TypeScript module
# itself, so a test inside it could never run to report the problem. This reads the file as text.
step "generated Luau source" "$LOG/luausource.log" node scripts/check-luau-source.mjs

# Frame acceptance is not display. Releases 1.1.0-1.1.4 recorded native surfaces as "verified" on
# frame acceptance alone and shipped a P0 that removed pi's interface and drew nothing. This step
# exists so that gap is stated on every run instead of being rediscovered: it reports BLOCKED, with
# the measured reason, whenever the platform cannot host an agent block. Set PI_TERN_REQUIRE_ALL=1
# and it becomes a failure.
printf '\n=== render proof ===\n'
if node scripts/render-proof.mjs; then
	ran=$((ran + 1))
	grep -E "^(ok|BLOCKED|SKIP)" "$LOG"/renderproof.log 2>/dev/null || true
else
	failures=$((failures + 1))
	printf 'FAIL render proof\n'
fi

step "unit tests" "$LOG/unit.log" node --experimental-strip-types --test "${UNIT_TESTS[@]}"

# The compatibility matrix is the "never break stock pi" guarantee. It needs no Tern, so a missing
# binary here is a real problem rather than a reason to skip quietly.
if [ -f native/compat.mjs ]; then
	step "stock fallback (compat matrix)" "$LOG/compat.log" node native/compat.mjs
else
	skip "stock fallback (compat matrix)" "native/compat.mjs is missing from the tree"
fi

if [ "${PI_TERN_SKIP_LIVE:-0}" = "1" ]; then
	skip "tern plugin loads" "PI_TERN_SKIP_LIVE=1"
	skip "live surface (no Tern pane)" "PI_TERN_SKIP_LIVE=1"
elif command -v tern >/dev/null 2>&1; then
	# A window start is what compiles the plugin's Luau; `plugin reload` cannot see a syntax error.
	step "tern plugin loads" "$LOG/plugin.log" bash scripts/plugin-check.sh pi-bridge
	step "live surface (no Tern pane)" "$LOG/live.log" node --experimental-strip-types scripts/verify.ts
else
	skip "tern plugin loads" "\`tern\` is not on PATH"
	skip "live surface (no Tern pane)" "\`tern\` is not on PATH"
fi

printf '\n'
if [ "$failures" -eq 0 ]; then
	echo "GATE PASSED ($ran run, $skipped skip)"
	exit 0
fi
echo "GATE FAILED ($failures step(s), $ran run, $skipped skip)"
exit 1
