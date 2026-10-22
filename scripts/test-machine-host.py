#!/usr/bin/env python3
"""Exercise the real native host/terminal with a scripted model and real disk.

No credentials, external services, or third-party Python packages are needed.
Usage: python3 scripts/test-machine-host.py [target/debug/tress]
"""
import http.client
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlencode, urlparse

BINARY = Path(sys.argv.pop(1) if len(sys.argv) > 1 else "target/debug/tress").resolve()
VERSION = "2026-09-13"


def reply(text=None, tool=None, args=None):
    block = {"type": "text", "text": ""} if tool is None else {
        "type": "tool_use", "id": "call_1", "name": tool, "input": {}}
    delta = {"type": "text_delta", "text": text} if tool is None else {
        "type": "input_json_delta", "partial_json": json.dumps(args)}
    events = [
        {"type": "message_start"},
        {"type": "content_block_start", "index": 0, "content_block": block},
        {"type": "content_block_delta", "index": 0, "delta": delta},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use" if tool else "end_turn"}},
        {"type": "message_stop"},
    ]
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()


class Model(ThreadingHTTPServer):
    def __init__(self):
        super().__init__(("127.0.0.1", 0), ModelHandler)
        self.scripts = queue.Queue()
        self.requests = queue.Queue()
        self.url = f"http://127.0.0.1:{self.server_port}"
        threading.Thread(target=self.serve_forever, daemon=True).start()


class ModelHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.requests.put(body)
        script = self.server.scripts.get(timeout=15)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(script)))
        self.end_headers()
        self.wfile.write(script)


class Client:
    def __init__(self, host):
        self.host = host
        self.connection = http.client.HTTPConnection(host.address, timeout=10)
        self.connection.request("GET", host.endpoint + "/stream", headers={
            "Statewire-Version": f'"{VERSION}"',
            "Statewire-Protocol": f'default; version="{VERSION}"',
        })
        self.stream = self.connection.getresponse()
        assert self.stream.status == 200, self.stream.read()
        self.lease = self.stream.getheader("statewire-lease")
        self.seq = 0
        self.state = None
        self.answers = {}
        self.read()

    def read(self):
        while True:
            line = self.stream.readline()
            if not line:
                raise AssertionError("Stream ended unexpectedly")
            if not line.startswith(b"data:"):
                continue
            packet = json.loads(line[5:])
            for op in packet.get("ops", []):
                self.state = op["value"]
            for answer in packet.get("cmd", []):
                self.answers[answer["seq"]] = answer
            return packet

    def until(self, predicate):
        deadline = time.monotonic() + 15
        while not predicate():
            assert time.monotonic() < deadline, self.state
            self.read()
        return self.state

    def send(self, method, params=None, seq=None):
        if seq is None:
            self.seq += 1
            seq = self.seq
        self.answers.pop(seq, None)
        payload = {"cmd": [{"protocol": "default", "seq": seq, "method": method, "params": params or []}]}
        status, _, body = self.host.request(self.host.endpoint + "/frames", "POST", payload,
                                            {"Statewire-Lease": self.lease})
        assert status == 200, (status, body)
        self.until(lambda: seq in self.answers)
        return self.answers[seq]

    def done(self, runs):
        return self.until(lambda: self.state["status"] == "idle" and self.state["runs"] >= runs)

    def close(self):
        self.stream.close()
        self.connection.close()


class Host:
    def __init__(self, base, model, flags=()):
        self.base = base
        self.root = base / "project"
        self.root.mkdir(exist_ok=True)
        self.storage = base / "state"
        self.flags = flags
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("TRESS_", "ANTHROPIC_"))}
        self.env.update(HOME=str(base), XDG_CONFIG_HOME=str(base / "config"),
                        ANTHROPIC_API_KEY="test-key", ANTHROPIC_BASE_URL=model.url)
        self.start()

    def start(self):
        self.process = subprocess.Popen([
            str(BINARY), "serve", "--root", str(self.root), "--state-dir", str(self.storage),
            "--listen", "127.0.0.1:0", *self.flags,
        ], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        lines = queue.Queue()
        threading.Thread(target=lambda: [lines.put(line) for line in self.process.stdout], daemon=True).start()
        output = []
        while True:
            line = lines.get(timeout=20)
            output.append(line)
            if line.startswith("Browser: "):
                self.url = line.strip().split(" ", 1)[1]
                parsed = urlparse(self.url)
                self.address = parsed.netloc
                self.origin = f"http://{self.address}"
                self.token = parsed.query.split("=", 1)[1]
                self.endpoint = f"/api/sessions/{self.token}"
                break
            assert self.process.poll() is None, "".join(output)

    def request(self, path, method="GET", body=None, headers=None):
        connection = http.client.HTTPConnection(self.address, timeout=10)
        headers = {"Content-Type": "application/json", **(headers or {})}
        connection.request(method, path, json.dumps(body) if body is not None else None, headers)
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def api(self, route, **params):
        return self.request(route + "?" + urlencode({"session": self.token, **params}))

    def checkpoint(self):
        return json.loads((self.storage / "session.json").read_text())

    def stop(self, crash=False):
        if self.process.poll() is None:
            self.process.send_signal(signal.SIGKILL if crash else signal.SIGINT)
            self.process.wait(timeout=10)
        self.process.stdout.close()


class MachineHostTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="tress-machine-")
        self.base = Path(self.tmp.name).resolve()
        self.model = Model()
        self.hosts = []
        self.clients = []

    def tearDown(self):
        for client in self.clients:
            client.close()
        for host in self.hosts:
            host.stop()
        self.model.shutdown()
        self.model.server_close()
        self.tmp.cleanup()

    def host(self, flags=()):
        host = Host(self.base, self.model, flags)
        self.hosts.append(host)
        return host

    def client(self, host):
        client = Client(host)
        self.clients.append(client)
        return client

    def test_artifacts_shared_terminal_and_restart(self):
        host = self.host(["--allow-write"])
        browser = self.client(host)
        observer = self.client(host)
        self.model.scripts.put(reply(tool="write", args={"path": "report.txt", "content": "durable artifact\n"}))
        self.model.scripts.put(reply("Saved report.txt on this machine."))
        self.assertEqual(browser.send("send", ["Create a report"])["type"], "result")
        browser.done(1)
        observer.done(1)
        self.assertEqual(observer.state, browser.state)
        self.assertEqual((host.root / "report.txt").read_text(), "durable artifact\n")
        status, headers, content = host.api("/api/file", path="report.txt")
        self.assertEqual(status, 200)
        self.assertEqual(content, b"durable artifact\n")
        self.assertTrue(headers["content-disposition"].startswith("attachment;"))
        self.assertEqual(host.checkpoint()["runs"], 1)
        # A repeated frame on the same lane must not run the model again.
        browser.send("send", ["Create a report"], seq=1)
        self.assertEqual(browser.state["runs"], 1)
        self.assertEqual(browser.state["status"], "idle")
        self.assertEqual(self.model.requests.qsize(), 2)
        self.model.scripts.put(reply("The report is still saved."))
        terminal = subprocess.run([str(BINARY), "ask", "--host", host.origin, "-s", host.token,
                                   "Continue from the terminal"], env=host.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(terminal.returncode, 0, terminal.stdout + terminal.stderr)
        self.assertIn("still saved", terminal.stdout)
        browser.done(2)
        requests = [self.model.requests.get(timeout=5) for _ in range(3)]
        self.assertIn("Create a report", json.dumps(requests[-1]["messages"]))
        saved_token = host.token
        browser.close()
        observer.close()
        host.stop()
        host.start()
        restored = self.client(host)
        self.assertEqual(host.token, saved_token)
        self.assertEqual(restored.state["runs"], 2)
        self.assertEqual(len(restored.state["entries"]), 4)
        self.assertEqual(host.api("/api/file", path="report.txt")[2], content)
        restored.send("reset")
        restored.until(lambda: restored.state["status"] == "idle" and not restored.state["entries"])
        self.assertEqual(host.checkpoint()["messages"], [])
        self.assertTrue((host.root / "report.txt").exists())

    def test_approval_disconnect_and_crash_do_not_replay(self):
        host = self.host(["--allow-exec"])
        browser = self.client(host)
        self.model.scripts.put(reply(tool="bash", args={"command": "printf approved > output.txt"}))
        browser.send("send", ["Run a command"])
        browser.until(lambda: browser.state.get("approval"))
        self.assertFalse((host.root / "output.txt").exists())
        self.assertTrue(host.checkpoint()["interrupted"])
        self.assertEqual(host.checkpoint()["entries"][0]["text"], "Run a command")
        old_lease = browser.lease
        browser.close()
        reconnected = self.client(host)
        self.model.scripts.put(reply("Command completed."))
        reconnected.send("approve", [reconnected.state["approval"]["id"], True])
        reconnected.done(1)
        self.assertEqual((host.root / "output.txt").read_text(), "approved")
        # A fresh stream starts a fresh ephemeral command lane.
        self.assertNotEqual(old_lease, reconnected.lease)
        self.model.scripts.put(reply(tool="bash", args={"command": "touch denied.txt"}))
        self.model.scripts.put(reply("Command denied."))
        reconnected.send("send", ["Deny this command"])
        reconnected.until(lambda: reconnected.state.get("approval"))
        reconnected.send("approve", [reconnected.state["approval"]["id"], False])
        reconnected.done(2)
        self.assertFalse((host.root / "denied.txt").exists())
        self.model.scripts.put(reply(tool="bash", args={"command": "touch interrupted.txt"}))
        reconnected.send("send", ["Interrupt this command"])
        reconnected.until(lambda: reconnected.state.get("approval"))
        self.assertEqual(reconnected.send("send", ["Concurrent work"])["type"], "rejected")
        host.stop(crash=True)
        host.start()
        recovered = self.client(host)
        self.assertEqual(recovered.state["status"], "idle")
        self.assertIn("not replayed", recovered.state["entries"][-1]["text"])
        self.assertFalse((host.root / "interrupted.txt").exists())
        self.assertFalse(host.checkpoint()["interrupted"])
        self.assertEqual(host.request(host.endpoint + "/frames", "POST", {"cmd": []},
                                      {"Statewire-Lease": old_lease})[0], 423)

    def test_scope_auth_permissions_and_read_only_tools(self):
        host = self.host()
        client = self.client(host)
        secret = self.base / "secret.txt"
        secret.write_text("outside")
        (host.root / "link").symlink_to(secret)
        os.mkfifo(host.root / "pipe")
        (host.root / "unsafe.html").write_text("<script>alert('x')</script>")
        (host.root / "binary.bin").write_bytes(bytes(range(256)))
        self.assertEqual(host.request("/api/files?session=wrong")[0], 401)
        self.assertEqual(host.request("/", headers={"Origin": "https://other.invalid"})[0], 403)
        self.assertEqual(host.request("/", headers={"Host": "other.invalid"})[0], 403)
        self.assertEqual(host.request(host.endpoint + "/stream")[0], 400)
        for path in ["../secret.txt", str(secret), "link", "pipe"]:
            self.assertEqual(host.api("/api/file", path=path)[0], 400, path)
        listing = json.loads(host.api("/api/files")[2])
        self.assertNotIn("link", [e["name"] for e in listing["entries"]])
        status, headers, _ = host.api("/api/file", path="unsafe.html")
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/octet-stream")
        self.assertEqual(host.api("/api/file", path="binary.bin")[2], bytes(range(256)))
        self.assertEqual(host.api("/api/file", path="binary.bin", preview="true")[0], 400)
        self.assertEqual(host.storage.stat().st_mode & 0o777, 0o700)
        self.assertEqual((host.storage / "session.json").stat().st_mode & 0o777, 0o600)
        # Even an unsolicited disabled tool from the model cannot write.
        self.model.scripts.put(reply(tool="write", args={"path": "blocked.txt", "content": "no"}))
        self.model.scripts.put(reply("Write disabled."))
        client.send("send", ["Try writing"])
        client.done(1)
        self.assertFalse((host.root / "blocked.txt").exists())
        request = self.model.requests.get(timeout=5)
        self.assertEqual({t["name"] for t in request["tools"]}, {"read", "ls"})
        # Fail admission if the durable layer cannot commit the request.
        (host.storage / "session.tmp").mkdir()
        rejected = client.send("send", ["Cannot be saved"])
        self.assertEqual(rejected["type"], "rejected")
        self.assertIn("No work was started", rejected["message"])
        self.assertTrue(client.state["storageError"])

    def test_state_lock_corruption_and_private_location(self):
        host = self.host()
        saved = (host.storage / "session.json").read_bytes()

        def launch(state):
            return subprocess.run([
                str(BINARY), "serve", "--root", str(host.root),
                "--state-dir", str(state), "--listen", "127.0.0.1:0",
            ], env=host.env, capture_output=True, text=True, timeout=5)

        conflict = launch(host.storage)
        self.assertNotEqual(conflict.returncode, 0)
        self.assertIn("already in use", conflict.stderr)
        self.assertEqual((host.storage / "session.json").read_bytes(), saved)
        inside = launch(host.root / "private-state")
        self.assertNotEqual(inside.returncode, 0)
        self.assertIn("outside the workspace", inside.stderr)
        host.stop()
        (host.storage / "session.json").write_text("corrupt checkpoint")
        corrupt = launch(host.storage)
        self.assertNotEqual(corrupt.returncode, 0)
        self.assertIn("Invalid session checkpoint", corrupt.stderr)
        self.assertEqual((host.storage / "session.json").read_text(), "corrupt checkpoint")


if __name__ == "__main__":
    unittest.main(verbosity=2)
