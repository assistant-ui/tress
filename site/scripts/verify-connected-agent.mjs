// Exercise the built managed callback through the real native connector.
// A scripted local model replaces Harness/model credentials; no cloud calls occur.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const root = await mkdtemp(join(tmpdir(), "tress-connected-agent-"));
const workspace = join(root, "workspace");
await mkdir(workspace);
await writeFile(join(workspace, "note.txt"), "CONNECTED-FILE-CONTENT\n");
const requests = [];
const responses = [
  { type: "tool_use", id: "read1", name: "read", input: { path: "note.txt" } },
  { type: "text", text: "The connected note was read." },
  { type: "tool_use", id: "read2", name: "read", input: { path: "note.txt" } },
  { type: "tool_use", id: "edit1", name: "edit", input: { path: "note.txt", old: "CONNECTED-FILE-CONTENT", new: "EDITED-THROUGH-HOST" } },
  { type: "tool_use", id: "read3", name: "read", input: { path: "note.txt" } },
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
      TRESS_THREAD_MODE: "cloud",
      TRESS_SERVERLESS: "1",
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
  assert.equal(mode.kind, "cloud");
  assert(mode.session?.id);
  assert.match(cookies, /tress_demo_owner=/);
  const binary = process.env.TRESS_TEST_BINARY ?? fileURLToPath(new URL("../../target/debug/tress", import.meta.url));
  const pair = async (writable) => {
    if (connector?.exitCode === null) {
      connector.kill("SIGTERM");
      await once(connector, "exit");
    }
    let output = "";
    connector = spawn(binary, ["connect", "--site", origin, ...(writable ? ["--allow-write"] : [])], {
      cwd: workspace,
      stdio: ["ignore", "pipe", "pipe"],
    });
    connector.stdout.on("data", (part) => { output += part; });
    connector.stderr.on("data", (part) => { output += part; });
    await waitFor(() => /Code: [A-Za-z0-9_-]{12}/.test(output), "native pairing code");
    const code = output.match(/Code: ([A-Za-z0-9_-]{12})/)[1];
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
  };
  const turn = async (text) => {
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
  const stream = await turn("Read note.txt");
  assert(stream.includes("The connected note was read."), stream);
  assert.equal(requests.length, 2, "the tool result returns to the model");
  assert(JSON.stringify(requests[1]).includes("CONNECTED-FILE-CONTENT"));
  const tools = requests[0].tools.map((tool) => tool.name);
  assert(tools.includes("read") && tools.includes("ls"));
  assert(!tools.includes("write") && !tools.includes("bash"));
  assert(stream.includes('"type":"data-files","data":{}'), "local files are not mirrored into previews");
  await pair(true);
  const edited = await turn("Read note.txt, edit its content, and read it back");
  assert(edited.includes("The connected note was edited and read back."), edited);
  assert.equal(requests.length, 6);
  assert.equal(await readFile(join(workspace, "note.txt"), "utf8"), "EDITED-THROUGH-HOST\n");
  assert(JSON.stringify(requests[5]).includes("EDITED-THROUGH-HOST"), "the model receives content read back from disk");
  const writeTools = requests[2].tools.map((tool) => tool.name);
  assert(writeTools.includes("write") && writeTools.includes("edit") && !writeTools.includes("bash"));
  const revoke = await fetch(`${origin}/api/connect/status?thread=${mode.session.id}`, {
    method: "DELETE", headers: { Cookie: cookies, Origin: origin },
  });
  assert.equal(revoke.status, 200);
  console.log("✓ managed callback reads, edits, and reads back the paired native folder; read-only policy and revocation pass");
} finally {
  if (connector?.exitCode === null) {
    connector.kill("SIGTERM");
    await once(connector, "exit");
  }
  if (host?.exitCode === null) {
    host.kill("SIGTERM");
    await once(host, "exit");
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await rm(root, { recursive: true, force: true });
}
