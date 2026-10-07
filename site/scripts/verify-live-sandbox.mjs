// Opt-in release check: a real Vercel sandbox, built host, native CLI, and
// browser protocol client. Model responses are scripted; sandbox I/O is real.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Sandbox } from "@vercel/sandbox";
import { createVercelWorkspace } from "@tress/workspaces/vercel";
import { StatewireClient, StatewireHttp } from "statewire";

const waitFor = async (predicate, label) => {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
};
const sse = (block) => [
  { type: "message_start" },
  { type: "content_block_start", index: 0, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } },
  { type: "content_block_delta", index: 0, delta: block.type === "text" ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: block.type === "text" ? "end_turn" : "tool_use" } },
  { type: "message_stop" },
].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

const marker = `SANDBOX-VERIFIED-${Date.now()}`;
const replies = [
  { type: "tool_use", id: "read1", name: "read", input: { path: "note.txt" } },
  { type: "tool_use", id: "shell1", name: "bash", input: { command: `node -e 'require("node:fs").writeFileSync("note.txt", "${marker}\\n")'` } },
  { type: "tool_use", id: "read2", name: "read", input: { path: "note.txt" } },
  { type: "text", text: "Sandbox edit finished." },
  { type: "tool_use", id: "read3", name: "read", input: { path: "note.txt" } },
  { type: "text", text: "Terminal verified the sandbox edit." },
];
const requests = [];
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  requests.push(JSON.parse(raw));
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(sse(replies[requests.length - 1] ?? { type: "text", text: "Unexpected model request." }));
});
let sandbox;
let host;
let terminal;
let browser;
try {
  sandbox = await Sandbox.create({
    name: `tress-release-${Date.now()}`,
    resources: { vcpus: 1 },
    persistent: false,
    timeout: 300_000,
  });
  const root = "/tmp/tress-release";
  await sandbox.fs.mkdir(root, { recursive: true });
  const workspace = await createVercelWorkspace({ sandbox, root });
  await workspace.writeFile("note.txt", "before sandbox edit\n");
  assert.equal(await workspace.readFile("note.txt"), "before sandbox edit\n");
  assert.deepEqual(await workspace.listFiles(), [{ name: "note.txt", type: "file" }]);
  await assert.rejects(workspace.readFile("../outside.txt"));
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
      HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "production",
      ANTHROPIC_API_KEY: "local-fixture-key",
      TRESS_API_URL: `http://127.0.0.1:${model.address().port}`,
      TRESS_THREAD_MODE: "local", TRESS_DEMO_SHARED: "1", TRESS_SERVERLESS: "0",
      TRESS_WORKSPACE: "vercel", TRESS_SANDBOX_NAME: sandbox.name,
      TRESS_WORKSPACE_ROOT: root, TRESS_ALLOW_WRITES: "1",
      TRESS_VISIBLE_FILES: '["note.txt"]', TRESS_DATABASE_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  host.stdout.on("data", (part) => { logs += part; });
  host.stderr.on("data", (part) => { logs += part; });
  await waitFor(async () => {
    if (host.exitCode !== null) throw new Error(logs);
    try { return (await fetch(`${origin}/api/mode`)).ok; } catch { return false; }
  }, "sandbox host");
  browser = new StatewireClient({ transport: StatewireHttp({ url: `${origin}/api/thread` }) });
  await waitFor(() => browser.connection.status === "connected" && browser.state, "browser protocol client");
  assert.equal(browser.state.workspace.details.environment, "sandbox");
  assert.equal(browser.state.workspace.details.shell, "native");
  const binary = process.env.TRESS_TEST_BINARY ?? fileURLToPath(new URL("../../target/debug/tress", import.meta.url));
  let terminalOutput = "";
  terminal = spawn(binary, ["attach", origin], { stdio: ["pipe", "pipe", "pipe"] });
  terminal.stdout.on("data", (part) => { terminalOutput += part; });
  terminal.stderr.on("data", (part) => { terminalOutput += part; });
  await waitFor(() => browser.state.clients.some((client) => client.kind === "terminal"), "terminal attached to sandbox host");
  await browser.commands.send("Edit the sandbox note with Node and read it back");
  await waitFor(() => terminalOutput.includes("Sandbox edit finished."), "browser run reaches terminal");
  assert.equal(await sandbox.fs.readFile(`${root}/note.txt`, "utf8"), `${marker}\n`);
  assert.equal(browser.state.files["note.txt"], `${marker}\n`);
  assert(requests[0].tools.some((tool) => tool.name === "bash"));
  assert(JSON.stringify(requests[3]).includes(marker));
  terminal.stdin.write("Read the sandbox note from the terminal\n");
  await waitFor(() => browser.state.runs === 2 && browser.state.status === "idle", "terminal run reaches browser");
  assert(browser.state.entries.some((entry) => entry.text === "Terminal verified the sandbox edit."));
  assert.equal(requests.length, 6);
  assert(JSON.stringify(requests[5]).includes(marker));
  console.log("✓ live Vercel sandbox: real read/write/list and Node execution; shared browser-protocol/native-terminal turns and file previews");
} finally {
  browser?.dispose();
  for (const child of [terminal, host]) {
    if (child?.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await sandbox?.stop();
}
