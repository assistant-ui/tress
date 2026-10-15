// Exercise the built managed callback through the real native connector.
// A scripted local model replaces Harness/model credentials; no cloud calls occur.
import assert from "node:assert/strict";
import { StatewireClient, StatewireHttp } from "statewire";

const local = process.argv.includes("--local");
const attach = process.argv.includes("--attach");
const ui = process.argv.includes("--ui");
const whole = process.argv.includes("--whole-filesystem");
if (whole && !attach) throw new Error("Whole filesystem fixture requires --attach.");
if (attach && !local) throw new Error("The attach fixture requires --local.");
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const waitFor = async (predicate, label) => {
  const until = Date.now() + 12_000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
};
const stopChild = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try { await exited; } finally { clearTimeout(timer); }
};
const sse = (block) => [
  { type: "message_start" },
  {
    type: "content_block_start", index: 0,
    content_block: block.type === "text"
      ? { type: "text", text: "" }
      : { ...block, input: {} },
  },
  {
    type: "content_block_delta", index: 0,
    delta: block.type === "text"
      ? { type: "text_delta", text: block.text }
      : { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
  },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: block.type === "text" ? "end_turn" : "tool_use" } },
  { type: "message_stop" },
].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

const root = await realpath(await mkdtemp(join(tmpdir(), "tress-connected-agent-")));
const workspace = join(root, "workspace");
await mkdir(workspace);
await writeFile(join(workspace, "note.txt"), "CONNECTED-FILE-CONTENT\n");
const notePath = whole ? join(workspace, "note.txt") : "note.txt";
const browseDirectory = whole ? workspace.replace(/^\//, "") : "";
const browseNote = whole ? `${browseDirectory}/note.txt` : "note.txt";
const requests = [];
const responses = [
  { type: "tool_use", id: "read1", name: "read", input: { path: notePath } },
  { type: "text", text: "The connected note was read." },
  { type: "tool_use", id: "read2", name: "read", input: { path: notePath } },
  { type: "tool_use", id: "edit1", name: "edit", input: { path: notePath, old: "CONNECTED-FILE-CONTENT", new: "EDITED-THROUGH-HOST" } },
  { type: "tool_use", id: "read3", name: "read", input: { path: notePath } },
  { type: "text", text: "The connected note was edited and read back." },
];
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  requests.push(JSON.parse(raw));
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(sse(responses[requests.length - 1] ?? { type: "text", text: "Unexpected model request." }));
});
let host;
let connector;
let browser;
let connectorOutput = "";
try {
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let logs = "";
  host = spawn(process.execPath, [".farm/.output/server/index.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      TRESS_THREAD_MODE: local ? "local" : "cloud",
      TRESS_SERVERLESS: local ? "0" : "1",
      TRESS_DEMO_SHARED: "0",
      TRESS_WORKSPACE: "memory",
      TRESS_SESSION_DIR: join(root, "sessions"),
      TRESS_DATABASE_URL: "",
      HARNESS_API_KEY: "local-fixture-key",
      HARNESS_ORIGIN: "http://managed.invalid",
      ANTHROPIC_API_KEY: "local-fixture-model-key",
      TRESS_API_URL: `http://127.0.0.1:${model.address().port}/v1/messages`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  host.stdout.on("data", (part) => { logs += part; });
  host.stderr.on("data", (part) => { logs += part; });
  let mode;
  let cookies;
  await waitFor(async () => {
    if (host.exitCode !== null) throw new Error(logs);
    try {
      const response = await fetch(`${origin}/api/mode`);
      if (!response.ok) return false;
      mode = await response.json();
      cookies = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
      return true;
    } catch {
      return false;
    }
  }, "managed preview");
  assert.equal(mode.kind, local ? "local" : "cloud");
  if (local) {
    browser = new StatewireClient({ transport: StatewireHttp({ url: `${origin}${mode.session.clientUrl}` }) });
    await waitFor(() => browser.connection.status === "connected", "browser thread attach");
    assert.deepEqual(browser.state.files, {}, "fresh threads have no example files");
  }
  assert(mode.session?.id);
  assert.match(cookies, /tress_demo_owner=/);
  const binary = process.env.TRESS_TEST_BINARY ?? fileURLToPath(new URL("../../target/debug/tress", import.meta.url));
  const pair = async (writable) => {
    await stopChild(connector);
    connectorOutput = "";
    const args = attach
      ? ["attach", origin, "-s", mode.session.attachId, ...(whole ? [] : ["--root", "."]), ...(ui ? ["--ui"] : [])]
      : ["connect", "--site", origin];
    if (writable) args.push("--allow-write");
    connector = spawn(ui ? "python3" : binary, ui ? [fileURLToPath(new URL("./pty-cli.py", import.meta.url)), binary, ...args] : args, {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
    });
    connector.stdout.on("data", (part) => { connectorOutput += part; });
    connector.stderr.on("data", (part) => { connectorOutput += part; });
    await waitFor(() => {
      if (connector.exitCode !== null) throw new Error(connectorOutput);
      return /Code: [A-Za-z0-9_-]{12}/.test(connectorOutput);
    }, "native pairing code");
    if (attach) assert(!connectorOutput.includes("\x1b[?1049h"), "UI waits for browser pairing");
    const code = connectorOutput.match(/Code: ([A-Za-z0-9_-]{12})/)[1];
    const claim = await fetch(`${origin}/api/connect/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookies, Origin: origin },
      body: JSON.stringify({ threadId: mode.session.id, code }),
    });
    assert.equal(claim.status, 200, await claim.text());
    await waitFor(async () => {
      const response = await fetch(`${origin}/api/connect/status?thread=${mode.session.id}`, {
        headers: { Cookie: cookies },
      });
      const device = response.ok ? (await response.json()).device : null;
      return device?.online && device.writable === writable;
    }, "native connector online");
    if (attach) {
      await waitFor(() => {
        if (connector.exitCode !== null) throw new Error(connectorOutput);
        return ui ? connectorOutput.includes("\x1b[?1049h") : connectorOutput.includes("shared thread");
      }, "attach chat opens after pairing");
    }
  };
  const turn = async (text) => {
    if (local) {
      await browser.commands.send(text);
      return JSON.stringify(browser.state.entries);
    }
    const chat = await fetch(`${origin}/api/chat?session=${mode.session.attachId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: `fixture~tress-${mode.session.id}`,
        messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text }] }],
      }),
    });
    if (!chat.ok) throw new Error(`Managed callback ${chat.status}: ${await chat.text()}`);
    const stream = await chat.text();
    assert(!stream.includes('"type":"error"'), stream);
    return stream;
  };
  await pair(false);
  const status = await (await fetch(`${origin}/api/connect/status?thread=${mode.session.id}`, { headers: { Cookie: cookies } })).json();
  const browse = async (operation, path) => {
    const query = new URLSearchParams({ thread: mode.session.id, session: mode.session.attachId, device: status.device.id, operation, path });
    const response = await fetch(`${origin}/api/connect/files?${query}`);
    assert.equal(response.status, 200, `browser ${operation}: ${response.status}`);
    return (await response.json()).value;
  };
  if (whole) {
    assert.equal(status.device.label, "Whole filesystem");
    assert.equal(status.device.rootLabel, "/");
    assert(connectorOutput.includes("Scope: Whole filesystem"));
  }
  assert((await browse("list", browseDirectory)).some((entry) => entry.name === "note.txt"));
  assert.equal(await browse("read", browseNote), "CONNECTED-FILE-CONTENT\n");
  const stream = await turn("Read note.txt");
  assert(stream.includes("The connected note was read."), stream);
  assert.equal(requests.length, 2, "the tool result returns to the model");
  assert(JSON.stringify(requests[1]).includes("CONNECTED-FILE-CONTENT"));
  const tools = requests[0].tools.map((tool) => tool.name);
  assert(tools.includes("read") && tools.includes("ls"));
  assert(!tools.includes("write") && !tools.includes("bash"));
  if (local) assert.deepEqual(browser.state.files, {}, "connected files are fetched on demand");
  else assert(stream.includes('"type":"data-files","data":{}'), "local files are not mirrored into previews");
  await pair(true);
  let edited;
  if (attach) {
    const before = browser.state.runs;
    // Wait for both clients to receive the thread state before typing.
    await new Promise((resolve) => setTimeout(resolve, 500));
    connector.stdin.write(`/pwd${ui ? "\r" : "\n"}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    connector.stdin.write(`Read note.txt, edit its content, and read it back${ui ? "\r" : "\n"}`);
    await waitFor(() => browser.state.runs > before && browser.state.status !== "running", "terminal edit appears in browser");
    edited = JSON.stringify(browser.state.entries);
  } else {
    edited = await turn("Read note.txt, edit its content, and read it back");
  }
  assert(edited.includes("The connected note was edited and read back."), edited);
  assert.equal(requests.length, 6);
  assert.equal(await readFile(join(workspace, "note.txt"), "utf8"), "EDITED-THROUGH-HOST\n");
  assert(JSON.stringify(requests[5]).includes("EDITED-THROUGH-HOST"), "the model receives content read back from disk");
  const writeTools = requests[2].tools.map((tool) => tool.name);
  assert(writeTools.includes("write") && writeTools.includes("edit") && !writeTools.includes("bash"));
  if (attach) {
    const exited = once(connector, "exit");
    connector.stdin.write(ui ? "\x04" : "/disconnect\n");
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("attach did not exit")), 5000))]);
    assert.equal(connector.exitCode, 0, connectorOutput);
    if (ui) assert(connectorOutput.includes("\x1b[?1049l"), "terminal restored on exit");
    const first = await (await fetch(`${origin}/api/connect/status?thread=${mode.session.id}`, { headers: { Cookie: cookies } })).json();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // No detached worker remains to receive queued work after the chat exits.
    const query = new URLSearchParams({ thread: mode.session.id, session: mode.session.attachId, device: first.device.id, operation: "read", path: browseNote });
    await assert.rejects(fetch(`${origin}/api/connect/files?${query}`, { signal: AbortSignal.timeout(1600) }), /abort|timeout/i);
  }
  const revoke = await fetch(`${origin}/api/connect/status?thread=${mode.session.id}`, {
    method: "DELETE", headers: { Cookie: cookies, Origin: origin },
  });
  assert.equal(revoke.status, 200);
  console.log(`✓ ${attach ? `attach${ui ? " --ui" : ""} + ${whole ? "whole filesystem" : "folder"}` : local ? "local thread" : "managed callback"}: browser lists and previews files; agent reads, edits, and reads back the native folder; read-only policy and revocation pass`);
} catch (error) {
  console.error(error);
  if (attach) console.error(connectorOutput);
  throw error;
} finally {
  browser?.dispose();
  await stopChild(connector);
  await stopChild(host);
  await new Promise((resolve) => {
    model.close(resolve);
    model.closeAllConnections();
  });
  await rm(root, { recursive: true, force: true });
}
