import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatewireClient, StatewireHttp } from "statewire";

const root = await mkdtemp(join(tmpdir(), "tress-isolation-"));
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const input = JSON.parse(raw);
  const write = typeof input.messages.at(-1).content === "string";
  const events = [
    { type: "message_start" },
    {
      type: "content_block_start",
      index: 0,
      content_block: write
        ? { type: "tool_use", id: "write-1", name: "write", input: {} }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: write
        ? {
            type: "input_json_delta",
            partial_json: JSON.stringify({
              path: "notes.md",
              content: "Visitor A's private file\n",
            }),
          }
        : { type: "text_delta", text: "Saved only in your workspace." },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: write ? "tool_use" : "end_turn" },
    },
    { type: "message_stop" },
  ];
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const url = `http://127.0.0.1:${port}`;
const wait = async (condition, label) => {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}\n${logs}`);
};
let logs = "";
let host, terminal;
const clients = [];
const start = async () => {
  host = spawn(process.execPath, [".farm/.output/server/index.mjs"], {
    cwd: new URL("../", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      TRESS_THREAD_MODE: "local",
      TRESS_DEMO_SHARED: "0",
      TRESS_DATABASE_URL: "",
      TRESS_SESSION_DIR: join(root, "registry"),
      TRESS_WORKSPACE: "local",
      TRESS_LOCAL_DEMO: "1",
      TRESS_WORKSPACE_ROOT: join(root, "files"),
      TRESS_VISIBLE_FILES: '[""]',
      TRESS_ALLOW_WRITES: "1",
      ANTHROPIC_API_KEY: "test",
      TRESS_API_URL: `http://127.0.0.1:${model.address().port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  host.stdout.on("data", (chunk) => (logs += chunk));
  host.stderr.on("data", (chunk) => (logs += chunk));
  await wait(async () => {
    if (host.exitCode !== null) throw new Error(logs);
    try {
      return (await fetch(url)).ok;
    } catch {
      return false;
    }
  }, "server startup");
};
const bootstrap = async (cookie) => {
  const response = await fetch(`${url}/api/mode`, {
    headers: cookie ? { cookie } : {},
  });
  assert.equal(response.status, 200, await response.clone().text());
  return {
    config: await response.json(),
    cookie:
      response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ") || cookie,
  };
};
const attach = async (config) => {
  const client = new StatewireClient({
    transport: StatewireHttp({ url: `${url}${config.session.clientUrl}` }),
  });
  clients.push(client);
  await wait(() => client.state?.files["notes.md"], "scoped stream and files");
  return client;
};
try {
  await start();
  const a = await bootstrap();
  const b = await bootstrap();
  assert.match(a.config.session.attachId, /^[A-Za-z0-9_-]{12}$/);
  assert.notEqual(a.config.session.id, b.config.session.id);
  assert.equal(
    (await bootstrap(a.cookie)).config.session.id,
    a.config.session.id,
  );
  const first = await attach(a.config);
  const second = await attach(b.config);
  assert.equal(first.state.clients.length, 1);
  assert.equal(second.state.clients.length, 1);
  await first.commands.send("Write a note for visitor A");
  await wait(
    () => first.state.status === "idle" && first.state.runs === 1,
    "visitor A reply",
  );
  assert.equal(first.state.files["notes.md"], "Visitor A's private file\n");
  assert.equal(second.state.entries.length, 0);
  assert(!second.state.files["notes.md"].includes("Visitor A"));
  let output = "";
  terminal = spawn(
    new URL("../../target/debug/tress", import.meta.url).pathname,
    ["attach", url, "-s", a.config.session.attachId],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  terminal.stdout.on("data", (chunk) => (output += chunk));
  terminal.stderr.on("data", (chunk) => (output += chunk));
  await wait(
    () => output.includes("Saved only in your workspace."),
    "terminal joins A",
  );
  await wait(
    () => first.state.clients.length === 2,
    "A's browser and terminal presence",
  );
  assert.equal(second.state.clients.length, 1);
  terminal.stdin.end("/exit\n");
  await once(terminal, "exit");
  terminal = undefined;
  assert.equal((await fetch(`${url}/api/thread/stream`)).status, 401);
  assert.equal(
    (await fetch(`${url}/api/sessions/${a.config.session.id}/stream`)).status,
    404,
  );
  const token = a.config.session.clientUrl.split("/").at(-1);
  const forged = await fetch(`${url}/api/chat?session=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: `tress-${b.config.session.id}`,
      messages: [
        {
          role: "user",
          parts: [{ type: "text", text: "Read the other visitor's files" }],
        },
      ],
    }),
  });
  assert.equal(forged.status, 403);
  for (const client of clients) client.dispose();
  host.kill("SIGTERM");
  await once(host, "exit");
  await start();
  const resumed = await bootstrap(a.cookie);
  assert.equal(resumed.config.session.id, a.config.session.id);
  assert.equal(
    (await attach(resumed.config)).state.files["notes.md"],
    "Visitor A's private file\n",
  );
  assert.equal(
    await readFile(join(a.config.workspace.root, "notes.md"), "utf8"),
    "Visitor A's private file\n",
  );
  console.log(
    "✓ isolated visitors: separate history/files/presence, exact terminal attachment, access checks, and disk identity/files survive restart",
  );
} finally {
  clients.forEach((client) => client.dispose());
  terminal?.kill();
  if (host?.exitCode === null) {
    host.kill("SIGTERM");
    await once(host, "exit");
  }
  model.close();
  await rm(root, { recursive: true, force: true });
}
