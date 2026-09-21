#!/usr/bin/env python3
"""TUI screen checker: drives opencode in a pty, renders the output through a
real terminal emulator (pyte), and prints the resulting screen. Used to verify
the /drift-graph layout without a human at the keyboard.

Usage:
    .venv/bin/python scripts/tui-screen.py --session <id> --keys "/drift-graph\\r" [--rows 48 --cols 150]
"""

from __future__ import annotations

import argparse
import fcntl
import os
import pty
import select
import struct
import sys
import termios
import time

import pyte


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", required=True)
    parser.add_argument("--keys", default="", help="string to type; \\r, \\x1b escapes allowed")
    parser.add_argument("--rows", type=int, default=48)
    parser.add_argument("--cols", type=int, default=150)
    parser.add_argument("--drain", type=float, default=14)
    parser.add_argument("--after", type=float, default=4)
    parser.add_argument("--grep", default="")
    args = parser.parse_args()

    screen = pyte.Screen(args.cols, args.rows)
    stream = pyte.Stream(screen)

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir("/Users/srihariunnikrishnan/drift")
        os.execvp("opencode", ["opencode", "-s", args.session])

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", args.rows, args.cols, 0, 0))

    def pump(seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return
                if not data:
                    return
                stream.feed(data.decode("utf-8", "ignore"))

    pump(args.drain)

    if args.keys:
        keys = args.keys.encode().decode("unicode_escape")
        for index, ch in enumerate(keys):
            os.write(fd, ch.encode("utf-8"))
            time.sleep(0.05 if index < len(keys) - 1 else 0.0)
        pump(args.after)

    lines = [line.rstrip() for line in screen.display]
    if args.grep:
        lines = [line for line in lines if args.grep in line]
    for line in lines:
        if line.strip():
            print(line)

    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
