#!/usr/bin/env python3
"""omp.session compatibility spike (0.9.0, P2-13).

Opens a non-listening inline surface with role="omp.session" holding a chat-like
Markdown document, keeps it for a moment, then closes it with keep=true so it stays
in the scrollback. Run inside a Tern pane:

    python3 spikes/omp-session-surface.py

What to look for (manual, on 0.4.5):
  - the surface renders natively in the pane;
  - whether Tern shows an agent chip / includes it in Carly's `cx.agents:transcript`
    ("non-omp agents return {}" is documented, so this is the open question);
  - `tern ctl tree "[data-surface='omp.session']"` (native surfaces are invisible to
    `tern ctl tree`, so this is expected to return nothing).
"""
import json
import os
import select
import sys
import termios
import time
import tty


def apc(obj):
    return ("\x1b_tsp;%s\x1b\\" % json.dumps(obj, separators=(",", ":"))).encode()


fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
tty.setraw(fd)
try:
    os.write(1, b'\x1b_tsp;q;{"q":"hello","v":[1],"app":"pi-session-spike"}\x1b\\\x1b[c')
    time.sleep(0.4)
    while select.select([fd], [], [], 0.05)[0]:
        os.read(fd, 65536)
    markdown = (
        "## pi.session spike\n\n"
        "user: this surface is published with role=omp.session by the pi-tern spike.\n\n"
        "assistant: if Tern reads this document, the agent-layer path is open."
    )
    os.write(1, apc({"id": "spike", "mode": "inline", "title": "pi session spike", "role": "omp.session", "listen": False}))
    os.write(
        1,
        apc(
            {
                "sf": "spike",
                "s": 1,
                "ops": [
                    [
                        "add",
                        "main",
                        "spike",
                        None,
                        {"id": "main", "k": "col", "c": [{"id": "m1", "k": "md", "p": {"text": markdown}}]},
                    ]
                ],
            }
        ),
    )
    time.sleep(3.0)
    os.write(1, apc({"id": "spike", "keep": True}))
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
print("\nspike-surface-sent")
