import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createAgent } from "../src/agent.js";
import { createBashWorkspace } from "../src/just-bash.js";
import { WORKSPACE_TOOLS } from "../src/tools.js";
import type { HostSessionConstructor } from "../src/types.js";

const require = createRequire(import.meta.url);
const { TressHostSession } =
  require("../../../site/src/server/pkg-node/tress_wasm.js") as {
    TressHostSession: HostSessionConstructor;
  };
type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };
function sse(block: Block) {
  return [
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
}
async function mockModel(scripts: Block[]) {
  const requests: Array<{
    messages: Array<{ content: unknown }>;
    system: string;
  }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const block = scripts.shift();
    if (!block) {
      res.writeHead(500);
      res.end("unexpected request");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse(block));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
const text = (text: string): Block => ({ type: "text", text });
const tool = (name: string, input: unknown): Block => ({
  type: "tool_use",
  id: "call1",
  name,
  input,
});

test("compiled Rust/WASM awaits JS tools, retains context and restores checkpoints", async (t) => {
  const mock = await mockModel([
    tool("write", { path: "hello.txt", content: "hello" }),
    text("written"),
    text("follow-up"),
    text("restored"),
  ]);
  t.after(mock.close);
  const workspace = createBashWorkspace();
  let observed = false;
  const options = {
    Session: TressHostSession,
    workspace,
    url: mock.url,
    model: "test",
    system: "custom system",
    tools: {
      include: WORKSPACE_TOOLS,
      authorize: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return true;
      },
      onToolResult: async () => {
        assert.equal(await workspace.readFile("hello.txt"), "hello");
        observed = true;
      },
    },
  };
  const agent = createAgent(options);
  const events: string[] = [];
  const pending = agent.send("write", (event) => events.push(event.type));
  await assert.rejects(agent.send("concurrent"), /already running/);
  await pending;
  assert.equal(observed, true);
  assert.deepEqual(events, ["tool", "tool_done", "text", "idle"]);
  assert.match(JSON.stringify(mock.requests[1].messages), /Wrote hello.txt/);
  assert.equal(mock.requests[0].system, "custom system");
  await agent.send("remember it?");
  assert.equal(mock.requests[2].messages.length, 5);
  const messages = agent.checkpoint();
  agent.dispose();
  const restored = createAgent({ ...options, messages });
  await restored.send("continue");
  assert.equal(mock.requests[3].messages.length, 7);
  restored.clear();
  assert.deepEqual(restored.checkpoint(), []);
  assert.equal(await workspace.readFile("hello.txt"), "hello");
  restored.dispose();
});

test("bridge turns rejected async callbacks into model-visible errors", async (t) => {
  const mock = await mockModel([tool("read", { path: "x" }), text("handled")]);
  t.after(mock.close);
  const session = new TressHostSession(
    mock.url,
    "test",
    {},
    JSON.stringify([{ name: "read", input_schema: { type: "object" } }]),
    async () => {
      throw new Error("remote disconnected");
    },
  );
  await session.send("read", () => {});
  assert.match(
    JSON.stringify(mock.requests[1].messages),
    /remote disconnected/,
  );
  assert.match(JSON.stringify(mock.requests[1].messages), /"is_error":true/);
  session.free();
});

test("unregistered tool calls never reach the host callback", async (t) => {
  const mock = await mockModel([tool("secret", {}), text("denied")]);
  t.after(mock.close);
  let calls = 0;
  const session = new TressHostSession(mock.url, "test", {}, "[]", async () => {
    calls++;
    return "{}";
  });
  await session.send("try", () => {});
  assert.equal(calls, 0);
  assert.match(JSON.stringify(mock.requests[1].messages), /Unknown tool/);
  session.free();
});
