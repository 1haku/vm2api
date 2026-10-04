#!/usr/bin/env python3
"""Keep official Claude Code attached after init hello.

Host PTY + `docker exec -it` so the CLI stays in an interactive session.
Does not print credentials. Exits when the guest `claude` process exits.
"""
from __future__ import annotations

import os
import pty
import sys


def main() -> int:
    container = os.environ.get("KIN_CONTAINER", "").strip()
    uid = os.environ.get("KIN_UID", "").strip()
    gid = os.environ.get("KIN_GID", "").strip()
    if not container or not uid or not gid:
        return 2
    tz = os.environ.get("TZ", "UTC")
    lang = os.environ.get("LANG", "en_US.UTF-8")
    home = os.environ["KIN_GUEST_HOME"]
    argv = [
        "docker", "exec", "-it",
        "-u", f"{uid}:{gid}",
        "-e", f"HOME={home}",
        "-e", f"TMPDIR={home}/.cache/tmp",
        "-e", f"TZ={tz}",
        "-e", f"LANG={lang}",
        "-e", f"LC_ALL={lang}",
        "-e", f"PATH={home}/.local/bin:/usr/bin:/bin",
        "-e", "CLAUDE_CODE_USE_BEDROCK=0",
        "-e", "CLAUDE_CODE_USE_VERTEX=0",
        "-e", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0",
        "-e", "DISABLE_TELEMETRY=1",
        "-e", "DO_NOT_TRACK=1",
        "-e", "ANTHROPIC_BASE_URL=",
        "-e", "ANTHROPIC_API_KEY=",
        "-e", "ANTHROPIC_AUTH_TOKEN=",
        "-w", home,
        container,
        f"{home}/.local/bin/claude",
    ]
    return pty.spawn(argv) or 0


if __name__ == "__main__":
    sys.exit(main())
