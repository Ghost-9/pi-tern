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
#   bash scripts/plugin-check.sh [plugin-id]
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PLUGIN="${1:-pi-bridge}"
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

echo "reloading plugins…"
tern plugin reload >/dev/null 2>&1

# A window start is what compiles a window entry. --exit-after-first-frame opens one and exits.
echo "forcing a window start (compiles window entries)…"
(tern --exit-after-first-frame >/dev/null 2>&1 &)
sleep 14

NEW=$(tail -c "+$((BEFORE + 1))" "$LOG" 2>/dev/null)
if printf '%s' "$NEW" | grep -q "plugin window entry failed to load plugin=\"$PLUGIN\""; then
	echo "FAIL: $PLUGIN did not load:"
	printf '%s\n' "$NEW" | grep "plugin window entry failed to load plugin=\"$PLUGIN\"" | tail -2
	exit 1
fi

STATUS=$(tern plugin list 2>/dev/null | grep -E "^$PLUGIN " | head -1)
echo "ok   $PLUGIN loaded${STATUS:+ — $STATUS}"
echo "     (${#NEW} log bytes since the reload, no load failure)"
exit 0
