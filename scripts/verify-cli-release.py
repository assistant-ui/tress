#!/usr/bin/env python3
"""Smoke-test the exact CLI artifact before publishing, without a provider key.

Uses a temporary home and a loopback-only mock host. No model calls, downloads,
or changes to the developer's saved configuration. Requires Python 3.11+.
"""

from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Thread
import tomllib

BINARY = Path(sys.argv[1]).resolve()
ROOT = Path(__file__).resolve().parent.parent
VERSION = tomllib.loads((ROOT / "Cargo.toml").read_text())["workspace"]["package"]["version"]
SESSION = "smoke1234567"


with tempfile.TemporaryDirectory(prefix="tress-release-") as directory:
    home = Path(directory)
    env = {"HOME": directory, "XDG_CONFIG_HOME": str(home / "config"), "PATH": os.defpath}

    def run(*args, ok=True):
        result = subprocess.run(
            [str(BINARY), *args], cwd=home, env=env, stdin=subprocess.DEVNULL,
            capture_output=True, text=True, timeout=10,
        )
        assert (result.returncode == 0) == ok, f"{args}: {result.stdout}\n{result.stderr}"
        return result

    assert run("--version").stdout.strip() == f"tress {VERSION}", "artifact version mismatch"
    help_text = run("setup", "--help").stdout
    assert "--host" in help_text and "--local" in help_text, "missing hosted/local setup"
    fresh = json.loads(run("config", "--json").stdout)
    assert fresh["mode"] == "host" and fresh["host"] is None, "fresh installs must use hosted mode"
    assert not json.loads(run("config", "--local", "--json").stdout)["credential"]["configured"]
    assert "No host configured" in run(ok=False).stderr, "missing host must lead to setup"
    assert not (home / "config").exists(), "read-only commands modified configuration"

    requests = []

    class Host(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            body = json.dumps({
                "kind": "cloud", "configured": True, "session": {"attachId": SESSION},
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    with HTTPServer(("127.0.0.1", 0), Host) as server:
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            host_url = f"http://127.0.0.1:{server.server_port}"
            run("setup", "--host", host_url, "-s", SESSION)
            config = home / "config/tress"
            saved = json.loads((config / "connection.json").read_text())
            assert saved == {"host": host_url, "session": SESSION}
            assert not (config / "credentials.json").exists(), "hosted setup saved a provider key"
            assert (config / "connection.json").stat().st_mode & 0o777 == 0o600
            assert config.stat().st_mode & 0o777 == 0o700
            view = run("config", "--json").stdout
            assert json.loads(view)["credentials"] == "managed by host"
            assert SESSION not in view, "diagnostics exposed the session capability"
            run("doctor", "--check-api")
            assert requests == [f"/api/mode?session={SESSION}"] * 2
        finally:
            server.shutdown()
            worker.join(timeout=5)

print(f"CLI {VERSION} verified: hosted defaults, setup, private connection, and host diagnostics.")
