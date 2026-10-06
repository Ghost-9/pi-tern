#!/usr/bin/env node
/**
 * Stands in for stock pi when the launcher falls back to it.
 *
 * Its only job is to be observable: if this file runs, the launcher decided it was **not** going
 * native. The launcher itself must never print anything on this path — printing to stdout would
 * break the compatibility guarantee that it is invisible outside Tern — so the fact that this stub
 * ran at all is the signal.
 */
process.stdout.write("stock-fallback\n");
process.stderr.write("stub-pid=" + process.pid + "\n");
