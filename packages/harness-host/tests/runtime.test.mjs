import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Harness } from "harness-sdk";
import { createTressClient } from "@tress/client";
import { StatewireHttp } from "statewire";
import { DefaultChatTransport } from "ai";
import { createBashWorkspace } from "@tress/workspaces/just-bash";
import { createLocalHarnessHost, createTressTransport } from "../src/index.mjs";
import { fileStorage } from "../src/storage.mjs";
import { createManagedHarnessHost } from "../src/managed.mjs";
import { startMachineHost } from "../src/server.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const {
  TressHostSession,
} = require("../../../site/src/server/pkg-node/tress_wasm.js");
export async function until(check) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for Harness");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
export async function http(handler) {
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: req.headers,
        signal: abort.signal,
        ...(!["GET", "HEAD"].includes(req.method) && {
          body: Readable.toWeb(req),
          duplex: "half",
        }),
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body)
        Readable.fromWeb(response.body)
          .on("error", () => res.destroy())
          .pipe(res);
      else res.end();
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
function sse(block) {
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

test("Harness owns the Rust/WASM conversation across clients and host restarts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tress-harness-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scripts = [
    {
      type: "tool_use",
      id: "call1",
      name: "write",
      input: { path: "hello.txt", content: "durable artifact" },
    },
    { type: "text", text: "File written" },
    { type: "text", text: "I remember the file" },
  ];
  const requests = [];
  const model = await http(async (req) => {
    requests.push(await req.json());
    return new Response(sse(scripts.shift()), {
      headers: { "content-type": "text/event-stream" },
    });
  });
  t.after(model.close);
  const workspace = createBashWorkspace();
  const path = join(directory, "thread.json");
  const open = async () => {
    const host = createLocalHarnessHost({
      threadId: "main",
      storage: fileStorage(path),
      transport: createTressTransport({
        Session: TressHostSession,
        workspace,
        url: model.url,
        model: "fixture",
        tools: { include: ["read", "write"] },
      }),
    });
    const server = await http((req) => host.fetch(req));
    const a = new Harness({ transport: StatewireHttp({ url: server.url }) });
    const b = createTressClient({ url: server.url });
    await until(() => !a.isLoading && !b.isLoading);
    return {
      a,
      b,
      host,
      async close() {
        a.dispose();
        b.dispose();
        await host.close();
        await server.close();
      },
    };
  };
  const first = await open();
  try {
    await first.a.sendMessage("Write a file");
    await until(() => !first.b.isBusy && first.b.messages.length === 2);
    assert.equal(await workspace.readFile("hello.txt"), "durable artifact");
    assert.equal(
      first.b.messages[1].parts.find((p) => p.type === "text").text,
      "File written",
    );
  } finally {
    await first.close();
  }
  const snapshot = JSON.parse(await readFile(path, "utf8"));
  assert.equal(Object.keys(snapshot.messages).length, 2);
  assert.ok(
    Object.values(snapshot.messages).some((node) =>
      node.message.parts.some((p) => p.type === "data-tress-context"),
    ),
  );
  const second = await open();
  try {
    assert.equal(second.a.messages.length, 2);
    await second.b.sendMessage("What did you write?");
    await until(() => !second.a.isBusy && second.a.messages.length === 4);
    assert.match(JSON.stringify(requests.at(-1).messages), /durable artifact/);
    assert.equal(requests.length, 3);
  } finally {
    await second.close();
  }
});

test("a failed durable write prevents model execution", async () => {
  let runs = 0;
  const host = createLocalHarnessHost({
    threadId: "main",
    onError() {},
    storage: {
      load: async () => undefined,
      save: async () => {
        throw new Error("disk full");
      },
    },
    transport: {
      reconnectToStream: async () => null,
      sendMessages: async () => {
        runs++;
        throw new Error("should not run");
      },
    },
  });
  const server = await http((req) => host.fetch(req));
  const client = new Harness({ transport: StatewireHttp({ url: server.url }) });
  try {
    await until(() => !client.isLoading);
    await client.sendMessage("write").catch(() => {});
    await until(() => client.error || client.transport.error);
    assert.equal(runs, 0);
  } finally {
    client.dispose();
    await host.close().catch(() => {});
    await server.close();
  }
});

test("managed Harness uses the SDK and forwards only host credentials", async (t) => {
  const model = await http(
    async () =>
      new Response(sse({ type: "text", text: "Managed reply" }), {
        headers: { "content-type": "text/event-stream" },
      }),
  );
  t.after(model.close);
  let saved;
  const remote = createLocalHarnessHost({
    threadId: "managed-thread",
    storage: {
      load: async () => saved,
      save: async (value) => {
        saved = value;
      },
    },
    transport: createTressTransport({
      Session: TressHostSession,
      workspace: createBashWorkspace(),
      url: model.url,
      model: "fixture",
    }),
  });
  let requests = 0;
  const managed = createManagedHarnessHost({
    origin: "https://fixture.harness.test",
    workspaceId: "workspace",
    threadId: "managed-thread",
    credential: async () => "server-only-key",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      assert.match(
        request.url,
        /^https:\/\/fixture.harness.test\/threads\/fixture~managed-thread\//,
      );
      assert.equal(
        request.headers.get("authorization"),
        "Bearer server-only-key",
      );
      assert.equal(request.headers.get("aui-workspace-id"), "workspace");
      assert.equal(request.headers.get("cookie"), null);
      requests++;
      return remote.fetch(request);
    },
  });
  const server = await http((req) => managed.fetch(req));
  const browser = new Harness({
    transport: StatewireHttp({
      url: server.url,
      headers: {
        Authorization: "Bearer browser-key",
        Cookie: "private-cookie",
      },
    }),
  });
  try {
    await until(() => !managed.client.isLoading && !browser.isLoading).catch(
      (error) => {
        throw new Error(
          `${error.message}: managed=${managed.client.transport.status}/${managed.client.transport.error?.message}, browser=${browser.transport.status}/${browser.transport.error?.message}, requests=${requests}`,
        );
      },
    );
    assert.ok(requests >= 2);
    assert.equal(browser.messages.length, 0);
    await browser.sendMessage("Hello from the interface");
    await until(
      () => !managed.client.isBusy && managed.client.messages.length === 2,
    );
    assert.equal(
      managed.client.messages[1].parts.find((part) => part.type === "text")
        .text,
      "Managed reply",
    );
    await remote.flush();
    assert.equal(Object.keys(saved.messages).length, 2);
    assert.equal(
      (await managed.fetch(new Request(`${server.url}/arbitrary`))).status,
      404,
    );
  } finally {
    browser.dispose();
    await managed.close();
    await server.close();
    await remote.close();
  }
});

test("machine host stores real files and denies unauthenticated and escaped reads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tress-machine-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "project");
  await mkdir(root);
  await writeFile(join(root, "artifact.bin"), Buffer.from([0, 1, 255]));
  await writeFile(join(directory, "outside.txt"), "private");
  await symlink(join(directory, "outside.txt"), join(root, "link.txt"));
  const host = await startMachineHost({
    root,
    stateDir: join(directory, "state"),
    Session: TressHostSession,
    model: "fixture",
    modelUrl: "http://unused",
    browserJs: "",
    allowWrite: true,
  });
  try {
    const headers = JSON.parse(await readFile(host.headersFile, "utf8"));
    assert.equal((await fetch(`${host.origin}/api/info`)).status, 401);
    assert.equal(
      (
        await fetch(`${host.origin}/api/info`, {
          headers: { ...headers, Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(`${host.origin}/api/file?path=../outside.txt`, { headers }))
        .status,
      403,
    );
    assert.equal(
      (await fetch(`${host.origin}/api/file?path=link.txt`, { headers }))
        .status,
      403,
    );
    const artifact = await fetch(`${host.origin}/api/file?path=artifact.bin`, {
      headers,
    });
    assert.deepEqual(
      Buffer.from(await artifact.arrayBuffer()),
      Buffer.from([0, 1, 255]),
    );
    const files = await (
      await fetch(`${host.origin}/api/files`, { headers })
    ).json();
    assert.deepEqual(
      files.map((file) => file.name),
      ["artifact.bin"],
    );
  } finally {
    await host.close();
  }
});

test(
  "managed SDK tunnel executes the machine's WASM tools and saves the remote thread",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "tress-managed-machine-"));
    const root = join(directory, "project");
    await mkdir(root);
    const originalWebSocket = globalThis.WebSocket;
    let socket;
    let backendUrl;
    let response;
    let controller;
    // Only the cloud socket is simulated: HarnessCloud's real tunnel code
    // fetches the real machine endpoint and returns its streamed response.
    class CloudSocket {
      OPEN = 1;
      readyState = 1;
      constructor(url) {
        assert.equal(
          url,
          "wss://fixture.harness.test/threads/fixture~managed-thread/tunnel",
        );
        socket = this;
        queueMicrotask(() => this.onopen());
      }
      send(encoded) {
        const frame = JSON.parse(encoded);
        if (frame.headers && !frame.type) {
          assert.equal(frame.headers.authorization, "Bearer server-only-key");
          backendUrl = frame.headers["aui-backend-url"];
        } else if (frame.type === "response") {
          const stream = new ReadableStream({
            start(value) {
              controller = value;
            },
          });
          response.resolve(
            new Response(stream, {
              status: frame.status,
              headers: frame.headers,
            }),
          );
        } else if (frame.type === "chunk")
          controller.enqueue(Buffer.from(frame.data, "base64"));
        else if (frame.type === "end") controller.close();
        else if (frame.type === "error") {
          const error = new Error(frame.message);
          response.reject(error);
          controller?.error(error);
        }
      }
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
    }
    globalThis.WebSocket = CloudSocket;
    const scripts = [
      {
        type: "tool_use",
        id: "managed-write",
        name: "write",
        input: { path: "managed.txt", content: "machine artifact" },
      },
      { type: "text", text: "Saved on the machine" },
    ];
    const model = await http(
      async () =>
        new Response(sse(scripts.shift()), {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    let saved;
    const remote = createLocalHarnessHost({
      threadId: "managed-thread",
      storage: {
        load: async () => saved,
        save: async (value) => {
          saved = value;
        },
      },
      transport: new DefaultChatTransport({
        api: "http://fixture.invalid/agent",
        fetch: async (_url, init) => {
          await until(() => backendUrl);
          return new Promise((resolve, reject) => {
            response = { resolve, reject };
            socket.onmessage({
              data: JSON.stringify({
                type: "request",
                id: "backend-request",
                url: backendUrl,
                method: init.method,
                headers: Object.fromEntries(new Headers(init.headers)),
                body: init.body,
              }),
            });
          });
        },
      }),
    });
    let host;
    let browser;
    try {
      host = await startMachineHost({
        root,
        stateDir: join(directory, "state"),
        Session: TressHostSession,
        model: "fixture",
        modelUrl: model.url,
        browserJs: "",
        allowWrite: true,
        cloud: {
          origin: "https://fixture.harness.test",
          workspaceId: "workspace",
          threadId: "managed-thread",
          credential: "server-only-key",
          fetch: (url, init) => remote.fetch(new Request(url, init)),
        },
      });
      const headers = JSON.parse(await readFile(host.headersFile, "utf8"));
      browser = createTressClient({ url: host.endpoint, headers });
      await until(() => !browser.isLoading);
      await browser.sendMessage("Write managed.txt");
      await until(() => !browser.isBusy && browser.messages.length === 2);
      assert.equal(browser.error, undefined);
      assert.equal(
        await readFile(join(root, "managed.txt"), "utf8"),
        "machine artifact",
      );
      assert.equal(
        browser.messages[1].parts.find((p) => p.type === "text").text,
        "Saved on the machine",
      );
      await remote.flush();
      assert.equal(Object.keys(saved.messages).length, 2);
    } finally {
      browser?.dispose();
      await host?.close();
      await remote.close();
      await model.close();
      globalThis.WebSocket = originalWebSocket;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "native CLI reopens the same Harness thread after stopping and restarting the host",
  { skip: !process.env.TRESS_TEST_BINARY },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "tress-cli-harness-"));
    const root = join(directory, "project");
    await mkdir(root);
    const requests = [];
    const model = await http(async (request) => {
      assert.equal(request.headers.get("x-api-key"), "fixture-key");
      assert.equal(request.headers.get("anthropic-workspace-id"), "fixture-workspace");
      requests.push(await request.json());
      return new Response(
        sse({
          type: "text",
          text:
            requests.length === 1 ? "Remembered alpha" : "Still remember alpha",
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    t.after(model.close);
    const env = {
      ...process.env,
      HOME: directory,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_STATE_HOME: join(directory, "state"),
      ANTHROPIC_API_KEY: "fixture-key",
      ANTHROPIC_WORKSPACE_ID: "  fixture-workspace  ",
      ANTHROPIC_BASE_URL: model.url,
      TRESS_THREAD_MODE: "local",
      TRESS_HOST_RUNTIME: fileURLToPath(
        new URL("../dist/host.mjs", import.meta.url),
      ),
    };
    delete env.TRESS_HOST;
    delete env.TRESS_SESSION;
    delete env.HARNESS_API_KEY;
    if (process.env.TRESS_TEST_EMBEDDED) delete env.TRESS_HOST_RUNTIME;
    const run = (...args) =>
      promisify(execFile)(process.env.TRESS_TEST_BINARY, args, {
        cwd: root,
        env,
        timeout: 25_000,
      });
    t.after(async () => {
      await run("serve", "--stop").catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 300));
      await rm(directory, { recursive: true, force: true });
    });
    assert.match(
      (await run("--local", "ask", "Remember alpha")).stdout,
      /Remembered alpha/,
    );
    await run("serve", "--stop");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.match(
      (await run("--local", "ask", "What do you remember?")).stdout,
      /Still remember alpha/,
    );
    assert.match(JSON.stringify(requests[1].messages), /Remember alpha/);
    const [namespace] = await readdir(join(directory, "state/tress/harness"));
    if (process.env.TRESS_TEST_EMBEDDED)
      assert.equal(
        (
          await readdir(
            join(directory, "state/tress/harness", namespace, "runtime"),
          )
        ).length,
        1,
      );
    const savedHost = JSON.parse(
      await readFile(
        join(directory, "state/tress/harness", namespace, "host.json"),
        "utf8",
      ),
    );
    const page = await fetch(savedHost.origin);
    assert.match(await page.text(), /href="\/browser.css"/);
    const css = await fetch(`${savedHost.origin}/browser.css`);
    assert.match(css.headers.get("content-type"), /text\/css/);
    assert.match(await css.text(), /\.tress-ui/);
    assert.match(
      await (await fetch(`${savedHost.origin}/browser.js`)).text(),
      /Thread transcript/,
    );
    const snapshot = JSON.parse(
      await readFile(
        join(directory, "state/tress/harness", namespace, "thread.json"),
        "utf8",
      ),
    );
    assert.equal(Object.keys(snapshot.messages).length, 4);
  },
);
