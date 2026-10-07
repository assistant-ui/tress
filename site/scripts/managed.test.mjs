import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
const { createManagedGateway, managedGateway } = await import(output.href);
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
const scriptedFactory = (hosts, histories, beforeReply = async () => {}) => {
  const factory = (threadId) => {
    if (!hosts.has(threadId)) {
      const open = async ({ history }) => {
        histories.push(history);
        return new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: "start" });
            await beforeReply(history);
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
  return factory;
};

for (const fail of [false, true]) {
  test(`hosted CLI waits after managed admission for the ${fail ? "failure" : "complete reply"}`, async () => {
    const hosts = new Map();
    const histories = [];
    let finish;
    const gate = new Promise((resolve) => (finish = resolve));
    const factory = scriptedFactory(hosts, histories, async (history) => {
      if (history.length === 1) return;
      await gate;
      if (fail) throw new Error("delayed model failed");
    });
    const gateway = await createManagedGateway(
      { ...config, initialThreadId: `cli-${randomUUID()}` },
      factory,
    );
    const browser = new StatewireClient({ transport: transport(gateway.host) });
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = new Request(`http://localhost${request.url}`, {
        method: request.method,
        headers: request.headers,
        ...(body ? { body } : {}),
      });
      const reply = request.url.endsWith("/frames")
        ? await gateway.host.frames(input)
        : await gateway.host.stream(input);
      response.writeHead(reply.status, Object.fromEntries(reply.headers));
      if (!reply.body) return response.end();
      const stream = Readable.fromWeb(reply.body);
      stream.on("error", () => response.destroy());
      response.on("close", () => stream.destroy());
      stream.pipe(response);
    });
    let terminal;
    try {
      await wait(() => browser.state?.harness?.connection === "connected", "gateway ready");
      await browser.commands.send("Earlier prompt");
      await wait(() => browser.state.runs === 1, "previous conversation");
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const cli = process.env.TRESS_TEST_CLI ?? new URL("../../target/debug/tress", import.meta.url).pathname;
      terminal = spawn(cli, ["ask", "Wait for this managed reply"], {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          XDG_CONFIG_HOME: join(directory, `cli-${randomUUID()}`),
          TRESS_HOST: `http://127.0.0.1:${server.address().port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      terminal.stdout.on("data", (chunk) => (output += chunk));
      terminal.stderr.on("data", (chunk) => (output += chunk));
      const exited = once(terminal, "exit");
      await wait(() => output.includes("Wait for this managed reply"), "accepted CLI prompt");
      assert.equal(
        await Promise.race([
          exited.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 150)),
        ]),
        false,
        "Admission must not end the CLI before the model completes",
      );
      finish();
      await wait(() => terminal.exitCode !== null, "CLI completion");
      const [code] = await exited;
      if (fail) {
        assert.notEqual(code, 0, output);
        assert.match(output, /delayed model failed/);
      } else {
        assert.equal(code, 0, output);
        assert.equal(output.split("Managed reply").length - 1, 1, "print the new reply exactly once without history");
        assert.equal(browser.state.entries.at(-1).text, "Managed reply");
        assert.equal(browser.state.runs, 2);
      }
    } finally {
      finish();
      terminal?.kill();
      browser.dispose();
      gateway.dispose();
      hosts.forEach((host) => host.dispose());
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

test("managed gateway shares, resumes and rotates persisted threads in development strict mode", async () => {
  const hosts = new Map();
  const histories = [];
  const factory = scriptedFactory(hosts, histories);
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
    assert.equal(second.state.workspace.mode, "memory");
    assert.deepEqual(second.state.workspace.details, {
      environment: "virtual", access: "in-process", storage: "memory",
      shell: "simulated", writable: true, label: "virtual workspace",
    });
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

test("hot reload replaces an incompatible cached gateway once and retains its thread", async () => {
  const holder = globalThis[Symbol.for("tress.managed.gateway")];
  let disposed = 0;
  let release;
  holder.version = undefined;
  holder.gateway = new Promise((resolve) => (release = resolve));
  const migrationConfig = {
    ...config,
    origin: "http://managed.invalid",
    initialThreadId: "reload-thread",
  };
  const first = managedGateway(migrationConfig);
  const second = managedGateway(migrationConfig);
  assert.equal(first, second, "concurrent reconnects share a single migration");
  release({ dispose: () => disposed++ }); // A pre-presence gateway.
  const gateway = await first;
  try {
    assert.equal(disposed, 1, "the old host and tunnel are retired once");
    assert.equal(gateway.info().threadId, "reload-thread");
    assert.equal(typeof gateway.presence.connect, "function");
    assert.equal(await managedGateway(migrationConfig), gateway);

    // A newly loaded module must reuse the compatible host and its tunnel.
    const reloaded = await import(`${output.href}?reload`);
    assert.equal(await reloaded.managedGateway(migrationConfig), gateway);
  } finally {
    gateway.dispose();
    holder.gateway = undefined;
  }
});

test("reattaching retries a stopped cloud connection once without rotating the conversation", async () => {
  const hosts = new Map();
  const factory = scriptedFactory(hosts, []);
  const session = { scope: randomUUID(), threadId: "retry-thread", selectThread: async () => assert.fail("must not rotate") };
  const previous = await createManagedGateway(config, factory, session);
  const seed = new StatewireClient({ transport: transport(previous.host) });
  await wait(() => seed.state?.harness?.connection === "connected", "initial connection");
  await seed.commands.send("Keep this history");
  await wait(() => seed.state?.runs === 1 && seed.state.status === "idle", "saved reply");
  seed.dispose();
  previous.dispose();
  let attempts = 0;
  const gateway = await createManagedGateway(config, (id) => {
    attempts++;
    if (attempts === 1)
      return new Harness({ transport: StatewireHttp({
        url: "http://test.invalid",
        fetch: async () => new Response("unavailable credential", { status: 401 }),
      }) });
    return factory(id);
  }, session);
  const clients = [];
  try {
    const first = new StatewireClient({ transport: transport(gateway.host) });
    clients.push(first);
    await wait(() => first.state?.harness?.connection === "stopped", "stopped upstream");
    await Promise.all([gateway.reconnect(), gateway.reconnect()]);
    assert.equal(attempts, 2, "concurrent clients share the retry");
    const second = new StatewireClient({ transport: transport(gateway.host) });
    clients.push(second);
    await wait(() => second.state?.harness?.connection === "connected", "recovered cloud");
    assert.equal(second.state.harness.threadId, "retry-thread");
    assert.equal(second.state.entries[0].text, "Keep this history");
    assert.equal(second.state.entries.at(-1).text, "Managed reply");
    await gateway.reconnect();
    assert.equal(attempts, 2, "healthy cloud connections are not replaced");
  } finally {
    clients.forEach((client) => client.dispose());
    gateway.dispose();
    hosts.forEach((host) => host.dispose());
  }
});

test("isolated managed sessions rotate only their own stored thread and resume it", async () => {
  const hosts = new Map();
  const factory = scriptedFactory(hosts, []);
  const scopes = { a: randomUUID(), b: randomUUID() };
  const records = new Map([
    ["a", "visitor-a"],
    ["b", "visitor-b"],
  ]);
  const session = (scope) => ({
    scope: scopes[scope],
    threadId: records.get(scope),
    selectThread: async (id) => {
      records.set(scope, id);
    },
  });
  const clients = [];
  const gateways = [];
  const attach = async (scope) => {
    const gateway = await createManagedGateway(config, factory, session(scope));
    gateways.push(gateway);
    const client = new StatewireClient({ transport: transport(gateway.host) });
    clients.push(client);
    await wait(
      () => client.state?.harness?.connection === "connected",
      "session connection",
    );
    return client;
  };
  try {
    const first = await attach("a");
    const second = await attach("b");
    await first.commands.send("Only visitor A sees this");
    await wait(
      () => first.state.runs === 1 && first.state.status === "idle",
      "A reply",
    );
    assert.equal(second.state.entries.length, 0);
    assert.equal(second.state.harness.threadId, "visitor-b");
    await first.commands.reset();
    await wait(
      () =>
        first.state.harness.threadId !== "visitor-a" &&
        first.state.harness.connection === "connected",
      "A rotation",
    );
    const selected = records.get("a");
    assert.equal(first.state.harness.threadId, selected);
    assert.equal(records.get("b"), "visitor-b");
    first.dispose();
    gateways[0].dispose();
    const resumed = await attach("a");
    assert.equal(resumed.state.harness.threadId, selected);
    assert.equal(resumed.state.entries.length, 0);
    assert.equal(hosts.size, 3, "old A history remains alongside new A and B");
  } finally {
    clients.forEach((client) => client.dispose());
    gateways.forEach((gateway) => gateway.dispose());
    hosts.forEach((host) => host.dispose());
  }
});
