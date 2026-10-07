#!/usr/bin/env bash
#
# Verify a Tern plugin actually LOADS, which `tern plugin reload` cannot tell you.
#
# `plugin reload` exits 0 and `plugin list` still reports `ready` when a window entry has a syntax
# error — the compile happens when a session loads plugins, and the only evidence is a log line:
#
#   plugin window entry failed to load plugin="pi-bridge" error=syntax error: window.luau:44: ...
#
# That bit three times while building 1.1.2 and once again while adding `pane.kind`. This script is
# the guard: reload, force a load, then grep the log for what happened.
#
#   bash scripts/plugin-check.sh [plugin-id ...]
#
# With no arguments, every plugin this package ships is checked — so a new one cannot be added
# without a load check, which is the only thing that can see a Luau compile error.
#
# ## Why this uses `tern serve` and not a window
#
# This used to run `tern --exit-after-first-frame`, which **opens a real window** — up to three per
# invocation, and the gate runs this on every build. During testing that produced a stream of windows
# and tabs appearing in places nobody asked for them.
#
# `tern serve --control EP` is Tern's **headless** session: it loads the same plugins and compiles
# the same window entries, with no window at all. Verified here on Tern 0.5.2:
#
#   * a deliberately broken window.luau  -> `plugin window entry failed to load ... syntax error`
#   * healthy plugins                     -> `pi-bridge: booted` and `pi-tern-tools: booted`
#
# So the check is exactly as strong and opens nothing. `PI_TERN_PLUGIN_WINDOW=1` restores the old
# window-based path, for the case where the behaviour under test is specifically a real window.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

DEFAULT_PLUGINS="pi-bridge pi-tern-tools"
PLUGINS="$*"
[ -z "$PLUGINS" ] && PLUGINS="$DEFAULT_PLUGINS"
LOG="$HOME/Library/Logs/Tern/tern.log"
USE_WINDOW="${PI_TERN_PLUGIN_WINDOW:-0}"

if ! command -v tern >/dev/null 2>&1; then
	echo "SKIP: no tern on PATH"
	exit 0
fi

if [ ! -S "$HOME/Library/Application Support/Tern/daemon.sock" ]; then
	echo "SKIP: no Tern daemon running (start Tern first)"
	exit 0
fi

SOCK=""
SERVE_PID=""

# Shut the headless session down whatever happens. A leaked `tern serve` holds a socket, a session
# and a plugin timer, and the next run would find a port already in use.
cleanup() {
	if [ -n "$SERVE_PID" ]; then
		kill "$SERVE_PID" 2>/dev/null
		wait "$SERVE_PID" 2>/dev/null
	elif [ -n "$SOCK" ] && [ -S "$SOCK" ]; then
		tern ctl --control "$SOCK" quit >/dev/null 2>&1
	fi
	[ -n "$SOCK" ] && rm -rf "$(dirname "$SOCK")" 2>/dev/null
	return 0
}
trap cleanup EXIT INT TERM

# Two kinds of failure need opposite handling, and conflating them is why this gate was flaky.
#
#   syntax error / malformed string   deterministic. The code is wrong; a retry fails identically.
#   runtime error: load exceeded 50 ms transient. Tern budgets 50 ms to compile a window entry, and
#                                     pi-bridge's sits right at that edge, so it fails maybe one run
#                                     in five for reasons that have nothing to do with the code.
#
# Retrying only the second is honest: a syntax error is still a failure after three attempts, and a
# budget timeout stops being one once the machine has a moment. It is also why the two are separated
# rather than counted together - see docs/RENDER-PROOF.md for why this error reads like a syntax one.
ATTEMPTS="${PI_TERN_PLUGIN_ATTEMPTS:-3}"
NEW=""
PLUGIN=""
failed=0

for attempt in $(seq 1 "$ATTEMPTS"); do
	BEFORE=$(wc -c <"$LOG" 2>/dev/null | tr -d ' ' || echo 0)
	echo "reloading plugins (attempt $attempt/$ATTEMPTS)…"
	tern plugin reload >/dev/null 2>&1

	if [ "$USE_WINDOW" = "1" ]; then
		# A window start is what compiles a window entry, when a window is what is being tested.
		echo "forcing a window start (opens a window; PI_TERN_PLUGIN_WINDOW=1)…"
		(tern --exit-after-first-frame >/dev/null 2>&1 &)
		sleep 14
	else
		echo "forcing a headless session (compiles window entries, opens no window)…"
		SOCK="$(mktemp -d)/serve.sock"
		tern serve --control "$SOCK" >/dev/null 2>&1 &
		SERVE_PID=$!
		# Wait for the endpoint to answer rather than sleeping a fixed time: it is both faster on a
		# warm machine and the only version that cannot race a slow start.
		ready=0
		for _ in $(seq 1 60); do
			if tern ctl --control "$SOCK" stats >/dev/null 2>&1; then
				ready=1
				break
			fi
			sleep 0.5
		done
		if [ "$ready" != "1" ]; then
			echo "  headless session did not come up; retrying"
			cleanup
			SERVE_PID=""
			SOCK=""
			continue
		fi
		# Plugins load at session start; give the window entries their moment to compile.
		sleep 6
		cleanup
		SERVE_PID=""
		SOCK=""
	fi

	NEW=$(tail -c "+$((BEFORE + 1))" "$LOG" 2>/dev/null)
	# A deterministic compile error stops the loop immediately: another attempt cannot fix it.
	if printf '%s' "$NEW" | grep -q "plugin window entry failed to load.*error=syntax error"; then
		echo "FAIL: a plugin window entry has a syntax error (deterministic; not retrying):"
		printf '%s\n' "$NEW" | grep "plugin window entry failed to load" | tail -2
		exit 1
	fi
	# Anything else that failed is treated as transient.
	if ! printf '%s' "$NEW" | grep -q "plugin window entry failed to load"; then
		break
	fi
	echo "  transient load-budget failure; retrying"
done

# `tern plugin list` reads the installed manifests, so it is a different fact from "loaded": the
# whole point of this script is that `ready` and "actually loaded" are not the same. Keep both, and
# say which is which.
for PLUGIN in $PLUGINS; do
	if printf '%s' "$NEW" | grep -q "plugin window entry failed to load plugin=\"$PLUGIN\""; then
		echo "FAIL: $PLUGIN did not load after $ATTEMPTS attempt(s):"
		printf '%s\n' "$NEW" | grep "plugin window entry failed to load plugin=\"$PLUGIN\"" | tail -2
		failed=1
		continue
	fi
	STATUS=$(tern plugin list 2>/dev/null | grep -E "^$PLUGIN " | head -1)
	echo "ok   $PLUGIN loaded${STATUS:+ - manifest: $STATUS}"
done

if [ "$failed" -ne 0 ]; then
	exit 1
fi
echo "     (${#NEW} log bytes since the reload, no load failure; opened no window)"
exit 0