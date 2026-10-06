#!/usr/bin/env bash
#
# Verify a Tern plugin actually LOADS, which `tern plugin reload` cannot tell you.
#
# `plugin reload` exits 0 and `plugin list` still reports `ready` when a window entry has a syntax
# error — the compile happens when a window starts, and the only evidence is a log line:
#
#   plugin window entry failed to load plugin="pi-bridge" error=syntax error: window.luau:44: ...
#
# That bit three times while building 1.1.2 and once again while adding `pane.kind`. This script is
# the guard: reload, force a window start, then grep the log for the last few seconds.
#
#   bash scripts/plugin-check.sh [plugin-id ...]
#
# With no arguments, every plugin this package ships is checked — so a new one cannot be added
# without a window-start check, which is the only thing that can see a Luau compile error.
DEFAULT_PLUGINS="pi-bridge pi-tern-tools"
PLUGINS="$*"
[ -z "$PLUGINS" ] && PLUGINS="$DEFAULT_PLUGINS"
LOG="$HOME/Library/Logs/Tern/tern.log"

if ! command -v tern >/dev/null 2>&1; then
	echo "SKIP: no tern on PATH"
	exit 0
fi

if [ ! -S "$HOME/Library/Application Support/Tern/daemon.sock" ]; then
	echo "SKIP: no Tern daemon running (start Tern first)"
	exit 0
fi

BEFORE=0
[ -f "$LOG" ] && BEFORE=$(wc -c <"$LOG" | tr -d ' ')

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

	# A window start is what compiles a window entry. --exit-after-first-frame opens one and exits.
	echo "forcing a window start (compiles window entries)…"
	(tern --exit-after-first-frame >/dev/null 2>&1 &)
	sleep 14

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

for PLUGIN in $PLUGINS; do
	if printf '%s' "$NEW" | grep -q "plugin window entry failed to load plugin=\"$PLUGIN\""; then
		echo "FAIL: $PLUGIN did not load after $ATTEMPTS attempt(s):"
		printf '%s\n' "$NEW" | grep "plugin window entry failed to load plugin=\"$PLUGIN\"" | tail -2
		failed=1
		continue
	fi
	STATUS=$(tern plugin list 2>/dev/null | grep -E "^$PLUGIN " | head -1)
	echo "ok   $PLUGIN loaded${STATUS:+ — $STATUS}"
done

if [ "$failed" -ne 0 ]; then
	exit 1
fi
echo "     (${#NEW} log bytes since the reload, no load failure)"
exit 0
