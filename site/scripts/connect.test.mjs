import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Pool } from "pg";

const directory = await mkdtemp(join(tmpdir(), "tress-connect-test-"));
const output = new URL(`../.tress/connect-test-${process.pid}.mjs`, import.meta.url);
await build({
  stdin: {
    contents: `export * from "./src/server/connect-api";
      export * from "./src/server/connect-store";
      export * from "./src/server/connected-workspace";
      export * from "./src/server/demo-session";
      export * from "./src/server/thread-store";`,
    resolveDir: new URL("../", import.meta.url).pathname,
  },
  outfile: output.pathname,
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
});
const {
  connectRequest,
  createMemoryConnectStore,
  createPostgresConnectStore,
  createFileThreadStore,
  connectedCall,
  createConnectedWorkspace,
  resolveDemoOwner,
  resolveDemoSession,
  ownerCookie,
  connectHash,
} = await import(output.href);
after(async () => {
  await rm(output, { force: true });
  await rm(directory, { recursive: true, force: true });
});
process.env.TRESS_DEMO_SHARED = "0";
const registry = createFileThreadStore(join(directory, "registry"));
const devices = createMemoryConnectStore();
const url = (action, query = "") => `https://demo.example/api/connect/${action}${query}`;
const json = (action, body, cookie, token) =>
  new Request(url(action), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie, Origin: "https://demo.example" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
const call = (request, action) => connectRequest(request, action, devices, registry);
const visitor = async () => {
  const request = new Request("https://demo.example/api/mode");
  const owner = await resolveDemoOwner(request, true, registry);
  const session = await resolveDemoSession(request, true, registry, owner);
  return { session, cookie: ownerCookie(owner, request) };
};
const nextJob = async (token) => {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    const response = await call(json("poll", {}, undefined, token), "poll");
    const data = await response.json();
    if (data.job) return data.job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job was not delivered");
};

test("a visitor can claim only their own thread; a device can read and be revoked", async () => {
  const a = await visitor();
  const b = await visitor();
  const offer = await call(
    json("offer", { label: "Work Mac", rootLabel: "repo", writable: false }),
    "offer",
  );
  assert.equal(offer.status, 201);
  const { code, token } = await offer.json();
  assert.equal(code.length, 12);
  assert.equal(token.length, 43);
  assert.equal((await call(json("claim", { code, threadId: a.session.thread.id }, b.cookie), "claim")).status, 404);
  const claim = await call(json("claim", { code, threadId: a.session.thread.id }, a.cookie), "claim");
  assert.equal(claim.status, 200);
  assert.equal((await claim.json()).device.label, "Work Mac");
  assert.equal((await call(json("claim", { code, threadId: a.session.thread.id }, a.cookie), "claim")).status, 404);
  assert.equal((await call(new Request(url("status", `?thread=${a.session.thread.id}`)), "status")).status, 404);
  const shared = await call(new Request(url("status", `?thread=${a.session.thread.id}&session=${a.session.token}`)), "status");
  assert.equal(shared.status, 200);
  assert.equal((await shared.json()).manageable, false);
  const owned = await call(new Request(url("status", `?thread=${a.session.thread.id}`), { headers: { Cookie: a.cookie } }), "status");
  assert.equal((await owned.json()).manageable, true);
  assert.equal((await call(new Request(url("status", `?thread=${a.session.thread.id}&session=${a.session.token}`), {
    method: "DELETE",
    headers: { Origin: "https://demo.example" },
  }), "status")).status, 404);

  const poll = await call(json("poll", {}, undefined, token), "poll");
  assert.equal((await poll.json()).paired, true);
  const device = await devices.device(a.session.thread.id);
  const workspace = createConnectedWorkspace(a.session.thread.id, device, devices);
  const reading = workspace.readFile("note.txt");
  const job = await nextJob(token);
  assert.equal(job.operation, "read");
  assert.equal(job.path, "note.txt");
  assert.equal((await call(json("result", { id: job.id, result: { ok: true, value: "hello" } }, undefined, token), "result")).status, 200);
  assert.equal(await reading, "hello");
  await assert.rejects(workspace.writeFile("note.txt", "changed"), /read-only/);

  const interrupted = workspace.readFile("still-reading.txt");
  await nextJob(token);
  const revoke = await call(
    new Request(url("status", `?thread=${a.session.thread.id}`), {
      method: "DELETE",
      headers: { Cookie: a.cookie, Origin: "https://demo.example" },
    }),
    "status",
  );
  assert.equal(revoke.status, 200);
  await assert.rejects(interrupted, /disconnected/);
  assert.equal((await call(json("poll", {}, undefined, token), "poll")).status, 410);
  assert.equal(await devices.device(a.session.thread.id), undefined);
});

test("a writable connection can edit; jobs never cross thread boundaries", async () => {
  const a = await visitor();
  const b = await visitor();
  const offer = await call(
    json("offer", { label: "Laptop", rootLabel: "project", writable: true }),
    "offer",
  );
  const { code, token } = await offer.json();
  await call(json("claim", { code, threadId: a.session.thread.id }, a.cookie), "claim");
  await call(json("poll", {}, undefined, token), "poll");
  assert.equal(await devices.device(b.session.thread.id), undefined);
  const writing = connectedCall(a.session.thread.id, "write", "note.txt", "updated", devices);
  const job = await nextJob(token);
  assert.equal(job.content, "updated");
  assert.equal((await call(json("result", { id: job.id, result: { ok: true, value: "Wrote note.txt" } }, undefined, token), "result")).status, 200);
  assert.equal(await writing, "Wrote note.txt");
  assert.equal((await call(json("result", { id: job.id, result: { ok: true, value: "again" } }, undefined, "x".repeat(43)), "result")).status, 404);
  const reading = connectedCall(a.session.thread.id, "read", "control.txt", undefined, devices);
  const next = await nextJob(token);
  const escaped = "\0".repeat(1_048_576);
  assert.equal((await call(json("result", { id: next.id, result: { ok: true, value: escaped } }, undefined, token), "result")).status, 200);
  assert.equal((await reading).length, 1_048_576);
});

const binary = fileURLToPath(new URL("../../target/debug/tress", import.meta.url));
test("the native CLI pairs over HTTP and performs scoped file operations", {
  skip: !existsSync(binary),
  timeout: 25_000,
}, async () => {
  const root = join(directory, `native-${randomUUID()}`);
  await mkdir(root);
  await writeFile(join(root, "note.txt"), "before");
  await writeFile(join(directory, "outside.txt"), "outside secret");
  if (process.platform !== "win32") await symlink(join(directory, "outside.txt"), join(root, "escape.txt"));
  const store = createMemoryConnectStore();
  let origin = "";
  const server = createServer(async (incoming, outgoing) => {
    try {
      const parts = [];
      for await (const part of incoming) parts.push(part);
      const request = new Request(`${origin}${incoming.url}`, {
        method: incoming.method,
        headers: incoming.headers,
        ...(["GET", "HEAD"].includes(incoming.method) ? {} : { body: Buffer.concat(parts) }),
      });
      const action = new URL(request.url).pathname.split("/").pop();
      const response = await connectRequest(request, action, store, registry);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(500);
      outgoing.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  let child;
  try {
    const ownerRequest = new Request(`${origin}/api/mode`);
    const owner = await resolveDemoOwner(ownerRequest, true, registry);
    const session = await resolveDemoSession(ownerRequest, true, registry, owner);
    const cookie = ownerCookie(owner, ownerRequest);
    child = spawn(binary, ["connect", "--site", origin, "--root", root, "--allow-write"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (part) => { output += part; });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No pairing code: ${output}`)), 5000);
      child.stdout.on("data", (part) => {
        output += part;
        const match = output.match(/Code: ([A-Za-z0-9_-]{12})/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.once("exit", (status) => {
        clearTimeout(timer);
        reject(new Error(`Connector exited ${status}: ${output}`));
      });
    });
    const claim = await fetch(`${origin}/api/connect/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: origin },
      body: JSON.stringify({ threadId: session.thread.id, code }),
    });
    assert.equal(claim.status, 200);
    const until = Date.now() + 5000;
    while (!(await store.device(session.thread.id))?.lastSeenAt && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await store.device(session.thread.id))?.writable, true);
    assert.equal(await connectedCall(session.thread.id, "read", "note.txt", undefined, store), "before");
    assert.deepEqual(await connectedCall(session.thread.id, "list", "", undefined, store), [
      { name: "note.txt", type: "file" },
    ]);
    await connectedCall(session.thread.id, "write", "note.txt", "after", store);
    assert.equal(await readFile(join(root, "note.txt"), "utf8"), "after");
    await assert.rejects(connectedCall(session.thread.id, "read", "../outside.txt", undefined, store), /stay inside/);
    if (process.platform !== "win32")
      await assert.rejects(connectedCall(session.thread.id, "read", "escape.txt", undefined, store), /symlinks/);
    const revoke = await fetch(`${origin}/api/connect/status?thread=${session.thread.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: origin },
    });
    assert.equal(revoke.status, 200);
  } finally {
    if (child?.exitCode === null) child.kill("SIGTERM");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("separate PostgreSQL workers deliver exactly one scoped file job", {
  skip: !(process.env.TRESS_RELAY_TEST_DATABASE_URL ?? process.env.TRESS_DATABASE_URL),
}, async () => {
  const database = process.env.TRESS_RELAY_TEST_DATABASE_URL ?? process.env.TRESS_DATABASE_URL;
  const first = new Pool({ connectionString: database });
  const second = new Pool({ connectionString: database });
  const threadId = randomUUID();
  try {
    const migrations = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort())
      await first.query(await readFile(new URL(name, migrations), "utf8"));
    await first.query(
      `INSERT INTO tress_demo_threads (id, owner_id, access_hash, harness_thread_id)
       VALUES ($1, $2, $3, $4)`,
      [threadId, randomUUID(), connectHash(randomUUID()), `test-${threadId}`],
    );
    const a = createPostgresConnectStore(first);
    const b = createPostgresConnectStore(second);
    const tokenHash = connectHash(randomUUID());
    const codeHash = connectHash(randomUUID());
    await a.offer({ id: randomUUID(), tokenHash, codeHash, label: "Mac", rootLabel: "repo", writable: true, expiresAt: Date.now() + 60_000 });
    assert.equal((await b.claim(codeHash, threadId)).threadId, threadId);
    assert.deepEqual(await a.heartbeat(tokenHash), { paired: true, revoked: false });
    const job = { id: randomUUID(), operation: "write", path: "note.txt", content: "hello" };
    assert.equal(await a.enqueue(threadId, job), true);
    assert.equal((await b.take(tokenHash)).id, job.id);
    assert.equal(await a.take(tokenHash), undefined);
    assert.equal(await b.complete(tokenHash, job.id, { ok: true, value: "Wrote note.txt" }), true);
    assert.equal(await b.complete(tokenHash, job.id, { ok: true, value: "different" }), false);
    assert.deepEqual(await a.result(job.id), { status: "done", result: { ok: true, value: "Wrote note.txt" } });
    assert.equal(await a.revoke(threadId), true);
    assert.deepEqual(await b.heartbeat(tokenHash), { paired: true, revoked: true });
  } finally {
    await first.query("DELETE FROM tress_demo_threads WHERE id = $1", [threadId]).catch(() => {});
    await Promise.all([first.end(), second.end()]);
  }
});
