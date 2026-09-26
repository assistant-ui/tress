import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { Pool } from "pg";
import { resource } from "@assistant-ui/tap";
import { StatewireSocketHost } from "statewire/host-internal";
import { useStatewireCommands, useStatewireState } from "statewire/host";
import { HARNESS_HOST_PROTOCOL } from "harness-sdk/host";

const root = await mkdtemp(join(tmpdir(), "tress-health-policy-"));
const output = new URL(
  `../.tress/health-policy-${process.pid}.mjs`,
  import.meta.url,
);
await build({
  stdin: {
    contents: `export * from './src/server/health'; export * from './src/server/demo-policy'; export * from './src/server/thread-store'; export * from './src/server/demo-session'; export * from './src/server/managed';`,
    resolveDir: new URL("../", import.meta.url).pathname,
  },
  outfile: output.pathname,
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
});
const {
  checkHost,
  createFileThreadStore,
  createPostgresThreadStore,
  consumeBudget,
  assertSessionActive,
  resolveDemoSession,
  DemoPolicyError,
  policyResponse,
  sweepManagedGateways,
} = await import(output.href);
const keys = [
  "ANTHROPIC_API_KEY",
  "TRESS_MODEL",
  "TRESS_API_URL",
  "HARNESS_API_KEY",
  "HARNESS_ORIGIN",
  "HARNESS_WORKSPACE",
  "HARNESS_THREAD_ID",
  "TRESS_THREAD_MODE",
  "TRESS_RUNS_PER_OWNER_DAY",
  "TRESS_RUNS_PER_HOST_DAY",
  "TRESS_SESSIONS_PER_OWNER_DAY",
  "TRESS_SESSIONS_PER_HOST_DAY",
  "TRESS_SESSION_TTL_HOURS",
  "TRESS_HOST_IDLE_MINUTES",
  "TRESS_DEMO_SHARED",
];
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
beforeEach(() => {
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: "fake-model-secret",
    TRESS_MODEL: "fixture-model",
    TRESS_API_URL: "https://provider.example/v1/messages",
    HARNESS_API_KEY: "fake-harness-secret",
    HARNESS_ORIGIN: "https://fixture.harness.example",
    HARNESS_WORKSPACE: "fixture",
    TRESS_DEMO_SHARED: "0",
  });
});
after(async () => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
  await rm(output, { force: true });
});
const store = (name) => createFileThreadStore(join(root, name));
const request = () => new Request("https://host.example/api/health");

test("health uses host credentials, closes streams, and never generates a completion", async () => {
  const calls = [];
  let closed = 0;
  const result = await checkHost(
    request(),
    undefined,
    store("health"),
    async (url, options) => {
      calls.push(url.href);
      assert.equal(options.method, undefined);
      assert.equal(options.redirect, "error");
      assert(options.signal);
      if (url.hostname === "provider.example")
        assert.equal(options.headers["x-api-key"], "fake-model-secret");
      else
        assert.equal(
          options.headers.Authorization,
          "Bearer fake-harness-secret",
        );
      return new Response(
        new ReadableStream({
          cancel() {
            closed++;
          },
        }),
      );
    },
  );
  assert(result.ok);
  assert.equal(closed, 2);
  assert(calls.some((url) => url.endsWith("/v1/models/fixture-model")));
  assert(calls.some((url) => url.includes("/threads/fixture~")));
  assert(!JSON.stringify(result).includes("secret"));
});

test("health distinguishes database failure, rejected Harness access, and unsupported model metadata", async () => {
  const result = await checkHost(
    request(),
    undefined,
    {
      check: async () => {
        throw new Error("secret database URL");
      },
    },
    async (url) =>
      new Response("secret upstream response", {
        status: url.hostname === "provider.example" ? 404 : 403,
      }),
  );
  assert(!result.ok);
  assert.equal(result.checks.find((c) => c.name === "Storage").status, "error");
  assert.equal(result.checks.find((c) => c.name === "Model").status, "unknown");
  assert.match(
    result.checks.find((c) => c.name === "Harness").message,
    /HTTP 403/,
  );
  assert(!JSON.stringify(result).includes("secret"));
});

test("Harness diagnostics negotiate with the real Statewire host without sending commands", async () => {
  const host = StatewireSocketHost(
    resource(() => {
      const [state] = useStatewireState(() => ({ status: "idle" }));
      const commands = useStatewireCommands({
        send: () => assert.fail("Diagnostics must not send commands"),
      });
      return { state, commands };
    })(),
    { protocol: HARNESS_HOST_PROTOCOL },
  );
  try {
    const result = await checkHost(
      request(),
      undefined,
      store("protocol"),
      async (url, init) => {
        if (url.hostname === "provider.example")
          return Response.json({ id: "fixture-model" });
        assert.equal(
          init.method,
          undefined,
          "Only a GET stream probe is allowed",
        );
        return host.stream(new Request(url, init));
      },
    );
    assert.equal(result.ok, true, JSON.stringify(result.checks));
  } finally {
    host.dispose();
  }
});

test("missing model key and network failure produce actionable checks", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  let requests = 0;
  const result = await checkHost(
    request(),
    undefined,
    store("missing"),
    async (url) => {
      assert.notEqual(url.hostname, "provider.example");
      requests++;
      throw new Error("offline secret");
    },
  );
  assert.equal(requests, 1);
  assert(!result.ok);
  assert.match(
    result.checks.find((c) => c.name === "Model").message,
    /no model credential/,
  );
  assert.match(
    result.checks.find((c) => c.name === "Harness").message,
    /could not be reached/,
  );
});

const exerciseBudgets = async (registry, now, prefix = "") => {
  process.env.TRESS_RUNS_PER_OWNER_DAY = "2";
  process.env.TRESS_RUNS_PER_HOST_DAY = "3";
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      consumeBudget(registry, "runs", `${prefix}a`, now),
    ),
  );
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    2,
  );
  await consumeBudget(registry, "runs", `${prefix}b`, now);
  await assert.rejects(
    consumeBudget(registry, "runs", `${prefix}b`, now),
    (error) => error.status === 429,
  );
  await consumeBudget(registry, "runs", `${prefix}a`, now + 86_400_000);
};

test("file budgets serialize requests across instances and survive reopening", async () => {
  const a = store("budget"),
    b = store("budget");
  let round = 0;
  await exerciseBudgets(
    { consume: (...args) => (++round % 2 ? a : b).consume(...args) },
    Date.parse("2040-01-01T12:00:00Z"),
  );
  const reopened = store("budget");
  await consumeBudget(
    reopened,
    "runs",
    "a",
    Date.parse("2040-01-02T13:00:00Z"),
  );
  await assert.rejects(
    consumeBudget(reopened, "runs", "a", Date.parse("2040-01-02T13:00:00Z")),
    { status: 429 },
  );
  const response = policyResponse(new DemoPolicyError("limit", 429, 60));
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(response.status, 429);
});

test("new-session limits preserve existing threads", async () => {
  process.env.TRESS_SESSIONS_PER_OWNER_DAY = "1";
  const registry = store("session-limit");
  const owner = { id: randomUUID(), token: "a".repeat(32), fresh: false };
  const first = await resolveDemoSession(request(), true, registry, owner);
  await assert.rejects(resolveDemoSession(request(), true, registry, owner), {
    status: 429,
  });
  assert.equal((await registry.list(owner.id)).length, 1);
  assert.equal(
    (await registry.get(first.thread.accessHash)).id,
    first.thread.id,
  );
});

test("expired explicit links fail; ambient cookies can start fresh without deleting history", async () => {
  process.env.TRESS_SESSION_TTL_HOURS = "1";
  const registry = store("expiry");
  const first = await resolveDemoSession(request(), true, registry);
  const file = join(root, "expiry", first.thread.accessHash + ".json");
  const thread = JSON.parse(await readFile(file, "utf8"));
  thread.createdAt = new Date(Date.now() - 7_200_000).toISOString();
  await writeFile(file, JSON.stringify(thread));
  assert.throws(() => assertSessionActive(thread), { status: 410 });
  await assert.rejects(
    resolveDemoSession(
      new Request(`https://host.example/api/mode?session=${first.token}`),
      true,
      registry,
    ),
    { status: 410 },
  );
  const fresh = await resolveDemoSession(
    new Request("https://host.example/api/mode", {
      headers: { cookie: `tress_demo_session=${first.token}` },
    }),
    true,
    registry,
  );
  assert.notEqual(fresh.thread.id, first.thread.id);
  assert(await registry.get(first.thread.accessHash));
});

test("cleanup preserves active managed runs and connected clients", () => {
  process.env.TRESS_HOST_IDLE_MINUTES = "1";
  const caches = globalThis[Symbol.for("tress.managed.session-gateways.v1")];
  const removed = [];
  for (const [id, busy, clients] of [
    ["idle", false, 0],
    ["running", true, 0],
    ["attached", false, 1],
  ]) {
    const ready = {
      isBusy: () => busy,
      presence: { count: () => clients },
      dispose: () => removed.push(id),
    };
    caches.set(id, { ready, gateway: Promise.resolve(ready), lastActiveAt: 0 });
  }
  sweepManagedGateways(120_000);
  assert.deepEqual(removed, ["idle"]);
  assert(caches.has("running") && caches.has("attached"));
  caches.clear();
});

const database = process.env.TRESS_RELAY_TEST_DATABASE_URL;
test(
  "PostgreSQL budgets serialize workers and roll back rejected reservations",
  { skip: !database },
  async (t) => {
    const poolA = new Pool({ connectionString: database, max: 5 });
    const poolB = new Pool({ connectionString: database, max: 5 });
    const migrations = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(migrations))
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await poolA.query(await readFile(new URL(name, migrations), "utf8"));
    const day = "2041-05-01";
    t.after(async () => {
      await poolA.query("DELETE FROM tress_demo_usage WHERE day >= $1::date", [
        day,
      ]);
      await Promise.all([poolA.end(), poolB.end()]);
    });
    const a = createPostgresThreadStore(poolA),
      b = createPostgresThreadStore(poolB);
    let round = 0;
    await exerciseBudgets(
      { consume: (...args) => (++round % 2 ? a : b).consume(...args) },
      Date.parse(day + "T12:00:00Z"),
      randomUUID(),
    );
    await a.check();
  },
);

test("both model entry points enforce the budget before invoking the provider", async (t) => {
  const routeOutput = new URL(
    `../.tress/policy-routes-${process.pid}.mjs`,
    import.meta.url,
  );
  await build({
    stdin: {
      contents: `export { POST as chat } from './src/app/api/chat/route'; export { POST as messages } from './src/app/api/messages/route';`,
      resolveDir: new URL("../", import.meta.url).pathname,
    },
    outfile: routeOutput.pathname,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "no-model-in-test",
        setup(api) {
          api.onResolve({ filter: /server\/agent$/ }, () => ({
            path: "agent",
            namespace: "mock",
          }));
          api.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
            contents:
              'export async function openSession() { throw new Error("Provider must not run after budget denial"); }',
          }));
        },
      },
    ],
  });
  t.after(() => rm(routeOutput, { force: true }));
  const routes = await import(routeOutput.href);
  const savedDirectory = process.env.TRESS_SESSION_DIR;
  const savedDatabase = process.env.TRESS_DATABASE_URL;
  process.env.TRESS_SESSION_DIR = join(root, "routes");
  delete process.env.TRESS_DATABASE_URL;
  t.after(() => {
    if (savedDirectory === undefined) delete process.env.TRESS_SESSION_DIR;
    else process.env.TRESS_SESSION_DIR = savedDirectory;
    if (savedDatabase === undefined) delete process.env.TRESS_DATABASE_URL;
    else process.env.TRESS_DATABASE_URL = savedDatabase;
    delete globalThis[Symbol.for("tress.demo.thread-store.v4")].store;
  });
  const registry = store("routes");
  const session = await resolveDemoSession(request(), true, registry);
  process.env.TRESS_RUNS_PER_OWNER_DAY = "1";
  process.env.TRESS_RUNS_PER_HOST_DAY = "1";
  await consumeBudget(registry, "runs", session.thread.ownerId);
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("No upstream request allowed");
  });
  const input = (path, body) =>
    new Request(`https://host.example/api/${path}?session=${session.token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const chat = await routes.chat(
    input("chat", {
      id: session.thread.harnessThreadId,
      messages: [{ role: "user", parts: [{ type: "text", text: "test" }] }],
    }),
  );
  const legacy = await routes.messages(
    input("messages", { messages: [{ role: "user", content: "test" }] }),
  );
  for (const response of [chat, legacy]) {
    assert.equal(response.status, 429);
    assert(Number(response.headers.get("Retry-After")) > 0);
    assert.match((await response.json()).error, /daily run limit/);
  }
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});
