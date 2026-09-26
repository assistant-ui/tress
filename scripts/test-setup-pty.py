#!/usr/bin/env python3
"""Verify real hidden-key entry and cancellation using a temporary pseudo-terminal.

Uses only the Python standard library, a temporary home, and fake credentials.
Run after cargo build/test on macOS or Linux.
"""

import json
import os
from pathlib import Path
import pty
import select
import signal
import sys
import tempfile
import termios
import time

BINARY = Path(sys.argv[1] if len(sys.argv) > 1 else "target/debug/tress").resolve()
FAKE_KEY = b"pty-dummy-private-key"


def setup(home, *, cancel=False, environment_key=False):
    env = os.environ.copy()
    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "TRESS_MODEL", "TRESS_MAX_STEPS"):
        env.pop(name, None)
    env.update(HOME=home, XDG_CONFIG_HOME=f"{home}/config", TERM="xterm-256color")
    if environment_key:
        env["ANTHROPIC_API_KEY"] = FAKE_KEY.decode()
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(home)
        os.execve(str(BINARY), [str(BINARY), "setup"], env)
    output = bytearray()
    done = False

    def read():
        if select.select([fd], [], [], 0.1)[0]:
            try:
                output.extend(os.read(fd, 8192))
            except OSError:
                pass  # A closed PTY returns EIO on Linux.

    def until(needle):
        deadline = time.monotonic() + 10
        while needle not in output:
            if time.monotonic() > deadline:
                raise AssertionError(f"Missing setup prompt: {needle!r}")
            read()

    try:
        until(b"Model [")
        os.write(fd, b"changed-model\n" if cancel else b"\n")
        until(b"API key [Enter" if cancel or environment_key else b"API key: ")
        assert not termios.tcgetattr(fd)[3] & termios.ECHO, "key prompt appeared before echo was disabled"
        os.write(fd, b"\x03" if cancel else b"\r" if environment_key else FAKE_KEY + b"\r")
        deadline = time.monotonic() + 10
        while True:
            read()
            finished, status = os.waitpid(pid, os.WNOHANG)
            if finished:
                done = True
                break
            if time.monotonic() > deadline:
                raise AssertionError("Setup did not exit")
        attrs = termios.tcgetattr(fd)
        assert attrs[3] & termios.ECHO and attrs[3] & termios.ICANON, "terminal mode not restored"
        assert FAKE_KEY not in output, "key was echoed"
        assert os.waitstatus_to_exitcode(status) == (1 if cancel else 0), "unexpected setup exit status"
    finally:
        if not done:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        os.close(fd)


with tempfile.TemporaryDirectory(prefix="tress-pty-setup-") as home:
    setup(home)
    credentials = Path(home, "config/tress/credentials.json")
    config = Path(home, "config/tress/config.json")
    before = credentials.read_bytes(), config.read_bytes()
    assert json.loads(before[0])["anthropic_api_key"] == FAKE_KEY.decode()
    setup(home, cancel=True)
    assert (credentials.read_bytes(), config.read_bytes()) == before, "cancel changed configuration"

with tempfile.TemporaryDirectory(prefix="tress-pty-env-") as home:
    setup(home, environment_key=True)
    assert not Path(home, "config/tress/credentials.json").exists(), "environment key was copied to disk"
    assert Path(home, "config/tress/config.json").exists()

print("PTY checks passed: hidden key input, terminal restoration, cancellation, environment key preservation.")
