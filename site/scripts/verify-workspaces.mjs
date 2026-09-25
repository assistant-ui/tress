// Exercises the Farm server, compiled WASM, statewire, and native attach.
// Uses temporary files and a scripted local model; no cloud credentials required.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StatewireClient, StatewireHttp } from "statewire";
import { readUIMessageStream } from "ai";

const development = process.argv.includes("--dev");
const runtime = development ? "development" : "production";

const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
};
const sse = (block) =>
  [
    { type: "message_start" },
    {
      type: "content_block_start",
      index: 0,
      content_block:
        block.type === "text"
          ? { type: "text", text: "" }
          : { ...block, input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta:
        block.type === "text"
          ? { type: "text_delta", text: block.text }
          : {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: block.type === "text" ? "end_turn" : "tool_use" },
    },
    { type: "message_stop" },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");

const requests = [];
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const last = body.messages.at(-1).content;
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (last === "Create the demo file") {
    response.end(
      sse({
        type: "tool_use",
        id: "write1",
        name: "write",
        input: { path: "demo.txt", content: "changed by the shared host\n" },
      }),
    );
  } else {
    // Leave time for all clients to disconnect after the file update.
    await new Promise((resolve) => setTimeout(resolve, 500));
    response.end(sse({ type: "text", text: "Completed with shared context." }));
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelUrl = `http://127.0.0.1:${model.address().port}`;
const root = await mkdtemp(join(tmpdir(), "tress-host-integration-"));
let host;
let terminal;
const clients = [];
try {
  for (const mode of ["memory", "local"]) {
    requests.length = 0;
    await writeFile(join(root, "demo.txt"), "original\n");
    const portProbe = createServer();
    await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
    const port = portProbe.address().port;
    await new Promise((resolve) => portProbe.close(resolve));
    const url = `http://${development ? "localhost" : "127.0.0.1"}:${port}`;
    let hostOutput = "";
    const args = development
      ? ["node_modules/@farm.js/cli/bin/farm.js", "dev", "--port", String(port)]
      : [".farm/.output/server/index.mjs"];
    host = spawn(process.execPath, args, {
      cwd: new URL("../", import.meta.url),
      env: {
        ...process.env,
        NODE_ENV: runtime,
        PORT: String(port),
        HOST: "127.0.0.1",
        ANTHROPIC_API_KEY: "local-test-key",
        TRESS_API_URL: modelUrl,
        TRESS_THREAD_MODE: "local",
        TRESS_DEMO_SHARED: "1",
        TRESS_WORKSPACE: mode,
        TRESS_WORKSPACE_ROOT: root,
        TRESS_VISIBLE_FILES: '["demo.txt"]',
        TRESS_ALLOW_WRITES: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    host.stdout.on("data", (data) => {
      hostOutput += data;
    });
    host.stderr.on("data", (data) => {
      hostOutput += data;
    });
    await waitFor(async () => {
      if (host.exitCode !== null) throw new Error(hostOutput);
      try {
        return (await fetch(`${url}/api/mode`)).ok;
      } catch {
        return false;
      }
    }, `${runtime} server`);
    const config = await (await fetch(`${url}/api/mode`)).json();
    assert.equal(config.workspace.mode, mode);
    const attach = async () => {
      const client = new StatewireClient({
        transport: StatewireHttp({ url: `${url}/api/thread` }),
      });
      clients.push(client);
      await waitFor(
        () => client.connection.status === "connected" && client.state,
        "client connection",
      );
      return client;
    };
    const first = await attach();
    const second = await attach();
    await waitFor(
      () => first.state.clients.length === 2 && second.state.clients.length === 2,
      "live client presence",
    );
    assert.equal(
      new Set(second.state.clients.map((client) => client.id)).size,
      2,
      "presence uses distinct Statewire client identities",
    );
    void first.commands.send("Create the demo file").catch(() => {});
    await waitFor(
      () => second.state.files["demo.txt"] === "changed by the shared host\n",
      "live file update",
    ).catch((error) => {
      throw new Error(
        `${error.message}\nState: ${JSON.stringify(second.state)}\nHost: ${hostOutput}`,
      );
    });
    assert.equal(
      second.state.status,
      "running",
      "file previews must update before the run finishes",
    );
    first.dispose();
    second.dispose();
    await new Promise((resolve) => setTimeout(resolve, 650));
    const returning = await attach();
    await waitFor(
      () => returning.state.status === "idle" && returning.state.runs === 1,
      "run survives disconnection",
    );
    assert.equal(
      returning.state.files["demo.txt"],
      "changed by the shared host\n",
    );

    let terminalOutput = "";
    terminal = spawn(
      fileURLToPath(new URL("../../target/debug/tress", import.meta.url)),
      ["attach", url],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    terminal.stdout.on("data", (data) => {
      terminalOutput += data;
    });
    terminal.stderr.on("data", (data) => {
      terminalOutput += data;
    });
    await waitFor(
      () => terminalOutput.includes("Completed with shared context."),
      "terminal catches up",
    );
    await waitFor(
      () =>
        returning.state.clients.length === 2 &&
        returning.state.clients.some((client) => client.kind === "terminal"),
      "terminal presence reaches browser",
    );
    terminal.stdin.write("Remember our earlier change\n");
    await waitFor(
      () => returning.state.runs === 2 && returning.state.status === "idle",
      "terminal prompt reaches browser state",
    );
    assert.equal(
      requests.at(-1).messages.length,
      5,
      "follow-up retains tool and assistant history",
    );
    assert.equal(
      returning.state.entries.at(-2).text,
      "Remember our earlier change",
    );
    terminal.stdin.write("/files\n/status\n/exit\n");
    await once(terminal, "exit");
    assert.match(terminalOutput, /demo.txt/);
    assert.match(terminalOutput, /2 connected clients/);
    terminal = undefined;
    await waitFor(
      () => returning.state.clients.length === 1,
      "terminal disconnect leaves live presence",
    );

    await returning.commands.reset();
    await waitFor(
      () =>
        returning.state.entries.length === 0 &&
        returning.state.status === "idle",
      "clear",
    );
    if (mode === "local") {
      assert.equal(
        await readFile(join(root, "demo.txt"), "utf8"),
        "changed by the shared host\n",
      );
      assert.equal(
        returning.state.files["demo.txt"],
        "changed by the shared host\n",
      );
    } else assert.equal(returning.state.files["demo.txt"], undefined);
    await returning.commands.send("After clear");
    assert.equal(
      requests.at(-1).messages.length,
      1,
      "clear resets model context",
    );
    returning.dispose();

    // Each managed turn creates a fresh WASM session from cloud-supplied history.
    const history = [];
    const managedTurn = async (prompt) => {
      history.push({
        id: `user-${history.length}`,
        role: "user",
        parts: [{ type: "text", text: prompt }],
      });
      const response = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: `managed-${mode}`, messages: history }),
      });
      assert.equal(response.status, 200);
      const chunks = (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
        .map((line) => JSON.parse(line.slice(6)));
      assert(
        !chunks.some((chunk) => chunk.type === "error"),
        JSON.stringify(chunks),
      );
      const stream = new ReadableStream({
        start(controller) {
          chunks.forEach((chunk) => controller.enqueue(chunk));
          controller.close();
        },
      });
      let message;
      for await (const value of readUIMessageStream({ stream }))
        message = value;
      assert(message);
      history.push(message);
      return message;
    };
    requests.length = 0;
    const result = await managedTurn("Create the demo file");
    assert(
      result.parts.some(
        (part) =>
          part.type === "dynamic-tool" && part.state === "output-available",
      ),
      "managed tool activity is persisted",
    );
    assert(
      result.parts.some((part) => part.type === "data-tress-context"),
      "managed stream carries a model checkpoint",
    );
    await managedTurn("Remember our earlier change");
    assert.equal(
      requests.at(-1).messages.length,
      5,
      "fresh managed turn restores full tool and model context",
    );
    if (mode === "local")
      assert.equal(
        await readFile(join(root, "demo.txt"), "utf8"),
        "changed by the shared host\n",
      );
    host.kill("SIGTERM");
    await once(host, "exit");
    host = undefined;
    console.log(
      `✓ ${runtime}/${mode}: live files, two clients, disconnect/reconnect, native terminal follow-up, clear, managed checkpoint restoration`,
    );
  }
} finally {
  for (const client of clients) client.dispose();
  terminal?.kill("SIGTERM");
  host?.kill("SIGTERM");
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await rm(root, { recursive: true, force: true });
}
