import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Harness } from "harness-sdk";
import { StatewireHttp } from "statewire";

const binary = resolve(process.env.TRESS_BIN ?? "../../target/debug/tress");
async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function until(predicate, label) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error(`Timed out: ${label}`);
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Operation timed out")), 12_000); })]); }
  finally { clearTimeout(timer); }
}
function cli(args, env) {
  const child = spawn(binary, args, { env: { ...process.env, ...env, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (part) => { output += part; });
  child.stderr.on("data", (part) => { output += part; });
  const exited = once(child, "exit");
  return { child, output: () => output, exited };
}

test("existing Harness app: browser, native CLI, revocation, restart, streaming proxy", { timeout: 60_000 }, async () => {
  const data = await mkdtemp(join(tmpdir(), "tress-app-e2e-"));
  const hostPort = await freePort();
  const publicPort = await freePort();
  const origin = `http://127.0.0.1:${publicPort}`;
  const endpoint = `${origin}/api/threads/main`;
  const password = "fixture-password-never-production";
  let host;
  let browser;
  let logs = "";
  const terminals = [];
  const proxy = createServer((incoming, outgoing) => {
    const upstream = httpRequest(`http://127.0.0.1:${hostPort}${incoming.url}`, { method: incoming.method, headers: incoming.headers }, (response) => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise((done) => proxy.listen(publicPort, "127.0.0.1", done));
  const start = async () => {
    host = spawn(process.execPath, ["--experimental-strip-types", "server.mjs"], {
      cwd: new URL(".", import.meta.url), env: { ...process.env, PORT: String(hostPort), PUBLIC_ORIGIN: origin, APP_PASSWORD: password, DATA_DIR: data },
      stdio: ["ignore", "pipe", "pipe"],
    });
    host.stdout.on("data", (part) => { logs += part; });
    host.stderr.on("data", (part) => { logs += part; });
    await until(async () => {
      if (host.exitCode !== null) throw new Error(logs);
      try { return (await fetch(`${origin}/api/session`)).ok; } catch { return false; }
    }, "app startup");
  };
  const stop = async () => {
    if (!host || host.exitCode !== null) return;
    const ended = once(host, "exit"); host.kill("SIGTERM"); await ended;
  };
  let cookie;
  const api = async (path, method = "GET", body) => {
    const response = await fetch(`${origin}${path}`, { method, headers: { cookie: cookie ?? "", origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, 200, `${method} ${path}: ${await response.clone().text()}\n${logs}`);
    return response;
  };
  const text = () => browser.messages.flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text)).join("\n");
  const attachBrowser = async () => {
    browser = new Harness({ transport: StatewireHttp({ url: endpoint, fetch: (url, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cookie", cookie); headers.set("origin", origin);
      return fetch(url, { ...init, headers });
    } }) });
    await until(() => browser.transport.status === "connected", `browser attach\n${logs}`);
  };
  const terminal = (args) => { const process = cli(args, { XDG_CONFIG_HOME: data }); terminals.push(process); return process; };
  try {
    // An explicit hosted command must override a user's saved local mode.
    await mkdir(join(data, "tress"));
    await writeFile(join(data, "tress", "config.json"), JSON.stringify({ mode: "local" }), { mode: 0o600 });
    await start();
    cookie = (await api("/api/login", "POST", { password })).headers.get("set-cookie").split(";")[0];
    await attachBrowser();
    await bounded(browser.sendMessage("browser-first"));
    await until(() => !browser.isBusy && text().includes("Echo: browser-first"), "browser reply");
    const grant = await (await api("/api/connections", "POST")).json();
    const file = join(data, "headers.json");
    await writeFile(file, JSON.stringify(grant.headers), { mode: 0o600 });
    const args = ["attach", endpoint, "--headers-file", file];
    const first = terminal(args);
    await until(() => first.output().includes("Echo: browser-first"), `terminal history\n${first.output()}`);
    first.child.stdin.write("terminal-first\n");
    await until(() => !browser.isBusy && text().includes("Echo: terminal-first") && first.output().includes("Echo: terminal-first"), "shared terminal reply");
    assert.equal((await (await api("/api/metrics")).json()).runs, 2);
    first.child.stdin.write("continue-after-disconnect\n");
    await until(async () => (await (await api("/api/metrics")).json()).runs === 3, "run admitted");
    first.child.stdin.write("/exit\n");
    assert.equal((await bounded(first.exited))[0], 0);
    await until(() => !browser.isBusy && text().includes("Echo: continue-after-disconnect"), "host continues without terminal");
    const once = terminal(["ask", "--host", endpoint, "--headers-file", file, "terminal-one-shot"]);
    const [code] = await bounded(once.exited);
    assert.equal(code, 0, once.output());
    assert.match(once.output(), /Echo: terminal-one-shot/);
    await until(() => !browser.isBusy && text().includes("Echo: terminal-one-shot"), "one-shot converges");
    const live = terminal(args);
    await until(() => live.output().includes("Echo: terminal-one-shot"), "reattach history");
    await api(`/api/connections/${grant.id}`, "DELETE");
    await until(() => live.output().includes("Detached") || live.output().includes("Connection closed"), "live revocation");
    live.child.stdin.write("should-not-run\n");
    await until(() => live.output().includes("Not connected"), "revoked command denied");
    live.child.stdin.write("/exit\n"); await bounded(live.exited);
    const denied = terminal(["ask", "--host", endpoint, "--headers-file", file, "also-denied"]);
    assert.equal((await bounded(denied.exited))[0], 1);
    assert.equal((await (await api("/api/metrics")).json()).runs, 4);
    await bounded(browser.sendMessage("browser-after-revoke"));
    await until(() => !browser.isBusy && text().includes("Echo: browser-after-revoke"), "browser unaffected by terminal revoke");
    const beforeRestart = text();
    browser.dispose(); browser = undefined;
    await stop();
    await start();
    await attachBrowser();
    assert.equal(text(), beforeRestart);
    const stillDenied = terminal(["ask", "--host", endpoint, "--headers-file", file, "denied-after-restart"]);
    assert.equal((await bounded(stillDenied.exited))[0], 1);
    await bounded(browser.sendMessage("after-restart"));
    await until(() => !browser.isBusy && text().includes("Echo: after-restart"), "restored host continues");
    assert.equal((await (await api("/api/metrics")).json()).runs, 1);
    assert.doesNotMatch(logs, /Request failed|persistence failed/);
  } finally {
    browser?.dispose();
    for (const terminal of terminals) if (terminal.child.exitCode === null) terminal.child.kill("SIGTERM");
    await stop();
    proxy.closeAllConnections(); await new Promise((done) => proxy.close(done));
    await rm(data, { recursive: true, force: true });
  }
});
