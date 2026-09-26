// Exercise the built host and real CLI against a local model fixture.
// No production credentials or database are used. --preview keeps the UI open.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = await mkdtemp(join(tmpdir(), "tress-health-integration-"));
const environment = { ...process.env };
for (const key of Object.keys(environment)) {
  if (
    /^(ANTHROPIC_|HARNESS_|TRESS_|VERCEL)/.test(key) ||
    key === "PUBLIC_BACKEND_URL"
  )
    delete environment[key];
}
let generations = 0;
let metadataChecks = 0;
const model = createServer(async (request, response) => {
  assert.equal(request.headers["x-api-key"], "mock-host-key");
  if (request.method === "GET" && request.url === "/v1/models/test-model") {
    metadataChecks++;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "test-model" }));
    return;
  }
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v1/messages");
  for await (const _ of request) {
    /* consume the request body */
  }
  generations++;
  const events = [
    { type: "message_start" },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Answered by the mock host." },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ];
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
});
let host;
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
      ...environment,
      NODE_ENV: "production",
      PORT: String(port),
      HOST: "127.0.0.1",
      ANTHROPIC_API_KEY: "mock-host-key",
      TRESS_API_URL: `http://127.0.0.1:${model.address().port}/v1/messages`,
      TRESS_MODEL: "test-model",
      TRESS_THREAD_MODE: "local",
      TRESS_WORKSPACE: "memory",
      TRESS_SESSION_DIR: join(root, "sessions"),
      TRESS_RUNS_PER_OWNER_DAY: "1",
      TRESS_RUNS_PER_HOST_DAY: "3",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  host.stdout.on("data", (data) => {
    logs += data;
  });
  host.stderr.on("data", (data) => {
    logs += data;
  });
  let config;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (host.exitCode !== null) throw new Error(logs);
    try {
      const response = await fetch(`${origin}/api/mode`);
      if (response.ok) {
        config = await response.json();
        break;
      }
    } catch {
      /* host is starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(config?.session, `Host did not start: ${logs}`);
  const id = config.session.attachId;
  const binary = fileURLToPath(
    new URL("../../target/debug/tress", import.meta.url),
  );
  const cli = (...args) =>
    promisify(execFile)(binary, args, {
      cwd: root,
      timeout: 20000,
      env: {
        ...environment,
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        // An invalid header value makes accidental client-side provider use fail.
        ANTHROPIC_API_KEY: "invalid\npersonal-key-must-not-be-used",
      },
    });
  await cli("setup", "--host", origin, "-s", id);
  const diagnostic = await cli("doctor", "--check-api");
  assert.match(diagnostic.stdout, /Storage: Session storage/);
  assert.match(diagnostic.stdout, /Model: Model metadata access verified/);
  assert.match(diagnostic.stdout, /Harness: Local host selected/);
  assert.equal(generations, 0, "diagnostics never generate a completion");
  assert.equal(metadataChecks, 1);
  const answer = await cli("ask", "hello");
  assert.match(answer.stdout, /Answered by the mock host/);
  await assert.rejects(cli("ask", "again"), (error) => {
    assert.match(error.stderr, /daily run limit/);
    return true;
  });
  const legacy = await fetch(`${origin}/api/messages?session=${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(legacy.status, 429);
  assert(Number(legacy.headers.get("Retry-After")) > 0);
  const health = await fetch(`${origin}/api/health?session=${id}`);
  assert.equal((await health.json()).ok, true);
  assert.equal(metadataChecks, 1, "browser and CLI share cached diagnostics");
  assert.equal(generations, 1, "over-budget requests never reach the model");
  console.log(
    "Verified: host-key execution, browser/CLI diagnostics, cached metadata, and run limits.",
  );
  if (process.argv.includes("--preview")) {
    console.log(`Preview: ${origin}/?session=${id}`);
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  }
} finally {
  if (host?.exitCode === null) {
    host.kill("SIGTERM");
    await once(host, "exit");
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await rm(root, { recursive: true, force: true });
}
