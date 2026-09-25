import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { test } from "node:test";
import { build } from "esbuild";
import { Pool } from "pg";
import { resource, useResource } from "@assistant-ui/tap";
import { Harness } from "harness-sdk";
import { HARNESS_HOST_PROTOCOL } from "harness-sdk/host";
import { useUIMessageTransport } from "harness-sdk/ui-transport";
import { StatewireSocketHost } from "statewire/host-internal";
import { StatewireClient, StatewireHttp } from "statewire";

const database =
  process.env.TRESS_RELAY_TEST_DATABASE_URL ?? process.env.TRESS_DATABASE_URL;
const wait = async (predicate, label) => {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
};

test(
  "separate serverless workers share commands, presence, history and reconnect journals",
  { skip: !database },
  async (t) => {
    process.env.NODE_ENV = "test";
    process.env.TRESS_WORKSPACE = "memory";
    const output = new URL(
      `../.tress/relay-test-${process.pid}.mjs`,
      import.meta.url,
    );
    await build({
      stdin: {
        contents: `export * from './src/server/serverless-relay';
        export * from './src/server/relay-store';
        export * from './src/server/thread-store';
        export * from './src/server/workspace-storage';
        export * from './src/server/managed';`,
        resolveDir: new URL("../", import.meta.url).pathname,
      },
      outfile: output.pathname,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
    });
    const {
      createRelayStore,
      createPostgresThreadStore,
      createManagedGateway,
      workspaceFiles,
      relayStream,
      relayFrames,
    } = await import(output.href);
    const { createBashWorkspace } = await import("@tress/workspaces/just-bash");
    const fullFiles = {
      ".hidden.md": "persist",
      "nested/note.md": "hello",
      "large.md": "x".repeat(110000),
    };
    assert.deepEqual(
      { ...(await workspaceFiles(createBashWorkspace({ files: fullFiles }))) },
      fullFiles,
    );
    const poolA = new Pool({ connectionString: database, max: 5 });
    const poolB = new Pool({ connectionString: database, max: 5 });
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await poolA.query(await readFile(new URL(name, directory), "utf8"));
    const registry = createPostgresThreadStore(poolA);
    const storeA = createRelayStore(poolA);
    const storeB = createRelayStore(poolB);
    const ids = [];
    const clients = [];
    const gateways = [];
    const cloudHosts = new Map();
    const calls = [];
    t.after(async () => {
      clients.forEach((client) => client.dispose());
      await Promise.all(gateways.map((gateway) => gateway.drain()));
      gateways.forEach((gateway) => gateway.dispose());
      cloudHosts.forEach((host) => host.dispose());
      await new Promise((resolve) => setTimeout(resolve, 300));
      await poolA.query(
        "DELETE FROM tress_demo_threads WHERE id = ANY($1::uuid[])",
        [ids],
      );
      await Promise.all([poolA.end(), poolB.end()]);
      await rm(output, { force: true });
    });
    const newSession = async () => {
      const id = randomUUID();
      const thread = {
        id,
        ownerId: randomUUID(),
        accessHash: createHash("sha256").update(id).digest("hex"),
        harnessThreadId: `test-${id}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await registry.create(thread);
      ids.push(id);
      return { token: "test-token", thread, fresh: false };
    };
    const session = await newSession();
    const other = await newSession();
    const cloudTransport = (host) =>
      StatewireHttp({
        url: "http://cloud.test/thread",
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (request.url.endsWith("/frames")) return host.frames(request);
          const response = await host.stream(request);
          return new Response(
            response.body.pipeThrough(new TransformStream(), {
              signal: init.signal,
            }),
            { status: response.status, headers: response.headers },
          );
        },
      });
    const factory = (threadId) => {
      if (!cloudHosts.has(threadId)) {
        const open = async () => {
          calls.push(threadId);
          return new ReadableStream({
            async start(controller) {
              await storeA.saveFiles(
                session.thread.id,
                threadId,
                {
                  "notes.md": "Live file update",
                  ".hidden.md": "Keep this file too",
                },
                { "notes.md": "Live file update" },
              );
              controller.enqueue({ type: "start" });
              controller.enqueue({ type: "text-start", id: "text" });
              controller.enqueue({
                type: "text-delta",
                id: "text",
                delta: "Reply from the cloud",
              });
              controller.enqueue({
                type: "message-metadata",
                messageMetadata: {
                  provider: {
                    tress: { files: { "notes.md": "Live file update" } },
                  },
                },
              });
              await new Promise((resolve) => setTimeout(resolve, 800));
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
        cloudHosts.set(
          threadId,
          StatewireSocketHost(element, {
            protocol: HARNESS_HOST_PROTOCOL,
            key: [threadId],
          }),
        );
      }
      return new Harness({
        transport: cloudTransport(cloudHosts.get(threadId)),
      });
    };
    let attaches = 0;
    let lease;
    const transport = (lifetime = 60000) =>
      StatewireHttp({
        url: "http://two-workers.test/thread",
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const current = {
            ...session,
            thread: await registry.get(session.thread.accessHash),
          };
          // All POSTs go to worker B, even though worker A owns the live stream.
          if (request.url.endsWith("/frames"))
            return relayFrames(request, current, storeB);
          attaches++;
          const response = await relayStream(
            request,
            current,
            storeA,
            async (persistence) => {
              const gateway = await createManagedGateway(
                {
                  kind: "cloud",
                  origin: "https://cloud.test",
                  workspaceId: "test",
                  initialThreadId: current.thread.harnessThreadId,
                  backendUrl: "http://localhost/api/chat",
                },
                factory,
                {
                  scope: current.thread.id,
                  threadId: current.thread.harnessThreadId,
                  selectThread: (id) =>
                    storeA.selectThread(current.thread.id, id),
                },
                persistence,
              );
              gateways.push(gateway);
              return gateway;
            },
            lifetime,
          );
          lease = response.headers.get("Statewire-Lease");
          return new Response(
            response.body.pipeThrough(new TransformStream(), {
              signal: init.signal,
            }),
            { status: response.status, headers: response.headers },
          );
        },
      });
    const browser = new StatewireClient({ transport: transport(5500) });
    const terminal = new StatewireClient({ transport: transport() });
    clients.push(browser, terminal);
    await wait(
      () =>
        browser.state?.harness?.connection === "connected" &&
        terminal.state?.harness?.connection === "connected",
      "both clients ready",
    );
    await browser.commands.send("first prompt");
    await wait(
      () => terminal.state?.runs === 1,
      "terminal receives browser reply",
    );
    await wait(
      () => browser.state?.clients.length === 2,
      "presence across workers",
    );
    await wait(
      () => terminal.state.files["notes.md"] === "Live file update",
      "live files across workers",
    );
    assert.equal(
      (await storeA.files(session.thread.id))[".hidden.md"],
      "Keep this file too",
    );
    assert.equal(
      terminal.state.files[".hidden.md"],
      undefined,
      "stored files are separate from visible previews",
    );

    const denied = await relayFrames(
      new Request("http://test/frames", {
        method: "POST",
        headers: { "Statewire-Lease": lease },
        body: '{"cmd":[]}',
      }),
      other,
      storeB,
    );
    assert.equal(denied.status, 423, "another session cannot use this lease");

    const before = attaches;
    await wait(
      () =>
        attaches > before && browser.state?.harness?.connection === "connected",
      "automatic invocation renewal",
    );
    await browser.commands.send("second prompt after renewal");
    await wait(
      () => terminal.state?.runs === 2,
      "journal continues command sequence after renewal",
    );
    assert.equal(
      calls.length,
      2,
      "renewal never duplicates a completed prompt",
    );

    await terminal.commands.reset();
    await storeA.saveFiles(
      session.thread.id,
      session.thread.harnessThreadId,
      { stale: "old run" },
      {},
    );
    assert.equal(
      await storeA.files(session.thread.id),
      null,
      "an old run cannot overwrite a cleared workspace",
    );
    await wait(
      () =>
        browser.state?.entries.length === 0 &&
        terminal.state?.entries.length === 0,
      "clear reaches both workers",
    );
    await wait(
      () => browser.state?.harness?.connection === "connected",
      "browser follows replacement thread",
    );
    const sending = browser.commands
      .send("continue after disconnect")
      .catch(() => {});
    await wait(() => terminal.state?.status === "running", "cloud run started");
    browser.dispose();
    await wait(
      () => terminal.state?.runs === 1 && terminal.state?.status === "idle",
      "cloud run survives observer disconnect",
    );
    await sending;
    assert.equal(calls.length, 3);
  },
);
