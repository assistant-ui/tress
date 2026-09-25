import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

process.env.NODE_ENV = "test";
process.env.TRESS_WORKSPACE = "memory";
const output = new URL(
  `../.tress/managed-test-${process.pid}.mjs`,
  import.meta.url,
);
await build({
  entryPoints: [new URL("../src/server/managed.ts", import.meta.url).pathname],
  outfile: output.pathname,
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
});
const { createManagedGateway } = await import(output.href);
const { Harness } = await import("harness-sdk");
const { HARNESS_HOST_PROTOCOL } = await import("harness-sdk/host");
const { useUIMessageTransport } = await import("harness-sdk/ui-transport");
const { resource, useResource } = await import("@assistant-ui/tap");
const { StatewireSocketHost } = await import("statewire/host-internal");
const { StatewireClient, StatewireHttp } = await import("statewire");
const directory = await mkdtemp(join(tmpdir(), "tress-managed-test-"));
process.env.HARNESS_STATE_DIR = directory;
after(async () => {
  await rm(directory, { recursive: true, force: true });
  await rm(output, { force: true });
});

const wait = async (predicate, label) => {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out: ${label}`);
};
const transport = (host) =>
  StatewireHttp({
    url: "http://test.invalid/thread",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/frames")) return host.frames(request);
      const response = await host.stream(request);
      return new Response(
        response.body.pipeThrough(new TransformStream(), {
          signal: init.signal,
        }),
        {
          status: response.status,
          headers: response.headers,
        },
      );
    },
  });
const config = {
  kind: "cloud",
  origin: "https://managed.example.com",
  workspaceId: "tests",
  initialThreadId: "test-thread",
  backendUrl: "http://localhost/api/chat",
};

// The cloud is a real Harness protocol host; only the model stream is scripted.
test("managed gateway shares, resumes and rotates persisted threads in development strict mode", async () => {
  const hosts = new Map();
  const histories = [];
  const factory = (threadId) => {
    if (!hosts.has(threadId)) {
      const open = async ({ history }) => {
        histories.push(history);
        return new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: "start" });
            controller.enqueue({ type: "text-start", id: "text" });
            controller.enqueue({
              type: "text-delta",
              id: "text",
              delta: "Managed reply",
            });
            await new Promise((resolve) => setTimeout(resolve, 40));
            controller.enqueue({ type: "text-end", id: "text" });
            controller.enqueue({ type: "finish", finishReason: "stop" });
            controller.close();
          },
        });
      };
      const element = resource(() =>
        useResource(
          resource(useUIMessageTransport)({
            threadId,
            adapter: {
              batchApprovals: true,
              startTurn: open,
              continueTurn: open,
            },
          }),
        ),
      )();
      hosts.set(
        threadId,
        StatewireSocketHost(element, {
          protocol: HARNESS_HOST_PROTOCOL,
          key: [threadId],
        }),
      );
    }
    return new Harness({ transport: transport(hosts.get(threadId)) });
  };
  let gateway;
  const clients = [];
  const attach = async () => {
    const client = new StatewireClient({ transport: transport(gateway.host) });
    clients.push(client);
    await wait(
      () => client.state?.harness?.connection === "connected",
      "managed connection",
    );
    return client;
  };
  try {
    gateway = await createManagedGateway(config, factory);
    const first = await attach();
    const second = await attach();
    await first.commands.send("Remember this conversation");
    await wait(
      () => second.state.runs === 1 && second.state.status === "idle",
      "shared reply",
    );
    assert.equal(second.state.entries.at(-1).text, "Managed reply");
    first.dispose();
    second.dispose();
    gateway.dispose();
    gateway = await createManagedGateway(config, factory);
    const resumed = await attach();
    await wait(
      () => resumed.state.entries.length === 2,
      "persisted transcript",
    );
    await resumed.commands.send("Continue after restart");
    await wait(
      () => resumed.state.runs === 2 && resumed.state.status === "idle",
      "second reply",
    );
    assert.equal(histories.at(-1).length, 3, "cloud supplies the full history");
    await resumed.commands.reset();
    await wait(
      () =>
        resumed.state.harness.threadId !== "test-thread" &&
        resumed.state.harness.connection === "connected",
      "new cloud thread",
    );
    const id = resumed.state.harness.threadId;
    assert.equal(resumed.state.entries.length, 0);
    resumed.dispose();
    gateway.dispose();
    gateway = await createManagedGateway(config, factory);
    const again = await attach();
    assert.equal(
      again.state.harness.threadId,
      id,
      "clear selection survives restart",
    );
    assert.equal(
      hosts.size,
      2,
      "clear preserves the previous cloud conversation",
    );
  } finally {
    clients.forEach((client) => client.dispose());
    gateway?.dispose();
    hosts.forEach((host) => host.dispose());
  }
});

test("managed authentication errors are visible and never fall back to a local run", async () => {
  const gateway = await createManagedGateway(
    { ...config, initialThreadId: "bad-key" },
    () =>
      new Harness({
        transport: StatewireHttp({
          url: "http://test.invalid",
          fetch: async () => new Response("unauthorized", { status: 401 }),
        }),
      }),
  );
  const client = new StatewireClient({ transport: transport(gateway.host) });
  try {
    await wait(
      () => client.state?.harness?.connection === "stopped",
      "authentication failure",
    );
    assert.match(client.state.harness.error, /401|unauthoriz/i);
    await assert.rejects(client.commands.send("Must not run"));
    assert.equal(client.state.entries.length, 0);
  } finally {
    client.dispose();
    gateway.dispose();
  }
});
