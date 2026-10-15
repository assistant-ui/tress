import assert from "node:assert/strict";
import { test } from "node:test";
import { createTressAccess } from "../src/index.ts";

const origin = "https://app.example";
function fixture() {
  const grants = new Map([
    ["browser", { subject: "alice", connectionId: "session-alice", expiresAt: Date.now() + 60_000 }],
    ["terminal", { subject: "alice", connectionId: "terminal-alice", expiresAt: Date.now() + 60_000 }],
    ["other", { subject: "bob", connectionId: "terminal-bob", expiresAt: Date.now() + 60_000 }],
  ]);
  const writers = new Map();
  const cancelled = [];
  let commands = 0;
  const access = createTressAccess({
    origin,
    async authorize({ request }) {
      const grant = grants.get(request.headers.get("authorization"));
      if (!grant) throw new Response("Sign in", { status: 401 });
      if (grant.subject !== "alice") throw new Response("Private thread", { status: 403 });
      return grant;
    },
    host: {
      async fetch(request) {
        if (request.url.endsWith("/frames")) { commands++; return new Response(null); }
        const lease = `lease-${writers.size}`;
        const body = new ReadableStream({
          start(controller) {
            writers.set(lease, controller);
            controller.enqueue(new TextEncoder().encode('data: {"initial":true}\n\n'));
          },
          cancel() { cancelled.push(lease); },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream", "statewire-lease": lease } });
      },
    },
  });
  const request = (token, route = "stream", extra = {}) => new Request(`${origin}/threads/main/${route}`, {
    method: route === "frames" ? "POST" : "GET", ...extra,
    headers: { authorization: token, ...extra.headers },
  });
  return { access, grants, writers, cancelled, request, commands: () => commands };
}

test("app auth gates read and write; leases cannot cross grants", async () => {
  const f = fixture();
  assert.equal((await f.access.fetch(f.request("unknown"))).status, 401);
  assert.equal((await f.access.fetch(f.request("other"))).status, 403);
  const response = await f.access.fetch(f.request("terminal"));
  const lease = response.headers.get("statewire-lease");
  const headers = { "statewire-lease": lease };
  assert.equal((await f.access.fetch(f.request("browser", "frames", { headers }))).status, 403);
  assert.equal((await f.access.fetch(f.request("terminal", "frames", { headers }))).status, 200);
  assert.equal(f.commands(), 1);
  await response.body.cancel();
});

test("revocation closes only that terminal and prevents subsequent reads and writes", async () => {
  const f = fixture();
  const terminal = await f.access.fetch(f.request("terminal"));
  const browser = await f.access.fetch(f.request("browser"));
  const reader = terminal.body.getReader();
  const browserReader = browser.body.getReader();
  await reader.read();
  await browserReader.read();
  f.grants.delete("terminal"); // app persists this before broadcasting revocation
  f.access.revoke("terminal-alice");
  const ended = await reader.read();
  assert.match(new TextDecoder().decode(ended.value), /forbidden/);
  assert.equal((await reader.read()).done, true);
  assert.deepEqual(f.cancelled, [terminal.headers.get("statewire-lease")]);
  assert.equal((await f.access.fetch(f.request("terminal"))).status, 401);
  assert.equal((await f.access.fetch(f.request("terminal", "frames", { headers: { "statewire-lease": terminal.headers.get("statewire-lease") } }))).status, 401);
  f.writers.get(browser.headers.get("statewire-lease")).enqueue(new TextEncoder().encode("still running"));
  assert.equal(new TextDecoder().decode((await browserReader.read()).value), "still running");
  assert.equal(f.commands(), 0);
  await browserReader.cancel();
});

test("expiration ends a quiet stream without waiting for its next packet", async () => {
  const f = fixture();
  f.grants.get("terminal").expiresAt = Date.now() + 40;
  const response = await f.access.fetch(f.request("terminal"));
  const reader = response.body.getReader();
  await reader.read();
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    assert.match(new TextDecoder().decode((await reader.read()).value), /forbidden/);
    assert.equal((await reader.read()).done, true);
  } finally { clearTimeout(keepAlive); }
});

test("revocation during a slow command upload denies admission", async () => {
  const f = fixture();
  const stream = await f.access.fetch(f.request("terminal"));
  let input;
  const body = new ReadableStream({ start(controller) { input = controller; } });
  const result = f.access.fetch(f.request("terminal", "frames", {
    body, duplex: "half", headers: { "statewire-lease": stream.headers.get("statewire-lease") },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  f.access.revoke("terminal-alice");
  input.enqueue(new TextEncoder().encode('{"cmd":[]}'));
  input.close();
  assert.equal((await result).status, 403);
  assert.equal(f.commands(), 0);
});

test("browser origin validation and bounded frame bodies", async () => {
  const f = fixture();
  assert.equal((await f.access.fetch(f.request("browser", "frames", { headers: { origin: "https://evil.example", cookie: "session=x" } }))).status, 403);
  assert.equal((await f.access.fetch(f.request("browser", "frames", { headers: { cookie: "session=x" } }))).status, 403);
  assert.equal((await f.access.fetch(f.request("terminal", "frames", { body: "x".repeat(1024 * 1024 + 1) }))).status, 413);
});

test("a cancelled browser request releases its host stream", async () => {
  const f = fixture();
  const abort = new AbortController();
  const response = await f.access.fetch(f.request("browser", "stream", { signal: abort.signal }));
  const reader = response.body.getReader();
  await reader.read();
  abort.abort();
  assert.equal((await reader.read()).done, true);
  assert.equal(f.cancelled.length, 1);
});
