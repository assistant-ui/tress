import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "tress-session-test-"));
const output = new URL(
  `../.tress/sessions-test-${process.pid}.mjs`,
  import.meta.url,
);
await build({
  stdin: {
    contents:
      'export * from "./src/server/demo-session"; export * from "./src/server/thread-store"; export * from "./src/server/workspace";',
    resolveDir: new URL("../", import.meta.url).pathname,
  },
  outfile: output.pathname,
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
});
const {
  createFileThreadStore,
  resolveDemoSession,
  sessionCookie,
  openWorkspace,
  accessHash,
} = await import(output.href);
after(async () => {
  await rm(output, { force: true });
  await rm(directory, { recursive: true, force: true });
});
process.env.TRESS_DEMO_SHARED = "0";
const request = (url = "https://demo.example/api/mode", headers) =>
  new Request(url, { headers });

test("visitors get separate identities; cookies and explicit attach links resume exactly one", async () => {
  const store = createFileThreadStore(join(directory, "registry"));
  const first = await resolveDemoSession(request(), true, store);
  const second = await resolveDemoSession(request(), true, store);
  assert.match(first.token, /^[A-Za-z0-9_-]{12}$/);
  assert.notEqual(first.thread.id, second.thread.id);
  assert.notEqual(first.thread.ownerId, second.thread.ownerId);
  const cookie = sessionCookie(first, request());
  assert.match(cookie, /HttpOnly; SameSite=Lax/);
  assert.match(cookie, /Secure$/);
  assert.equal(
    (await resolveDemoSession(request(undefined, { cookie }), true, store))
      .thread.id,
    first.thread.id,
  );
  // An explicit link wins over a different visitor's cookie without changing it.
  const linked = await resolveDemoSession(
    request(`https://demo.example/api/sessions/${first.token}/stream`, {
      cookie: sessionCookie(second, request()),
    }),
    false,
    store,
  );
  assert.equal(linked.thread.id, first.thread.id);
  assert(!linked.fresh);
  await assert.rejects(
    resolveDemoSession(
      request(`https://demo.example/api/sessions/${first.thread.id}/stream`),
      false,
      store,
    ),
    { status: 404 },
  );
  await assert.rejects(
    resolveDemoSession(
      request("https://demo.example/api/thread/stream"),
      false,
      store,
    ),
    { status: 401 },
  );
  await assert.rejects(
    resolveDemoSession(
      request("https://demo.example/api/mode?session=invalid"),
      true,
      store,
    ),
    { status: 404 },
  );
  await store.selectThread(first.thread.accessHash, "new-managed-conversation");
  const restarted = createFileThreadStore(join(directory, "registry"));
  assert.equal(
    (await restarted.get(first.thread.accessHash)).harnessThreadId,
    "new-managed-conversation",
  );
  assert.equal(
    (await restarted.get(second.thread.accessHash)).harnessThreadId,
    second.thread.harnessThreadId,
  );
  for (const file of await readdir(join(directory, "registry"))) {
    const content = await readFile(join(directory, "registry", file), "utf8");
    assert(
      !content.includes(first.token) && !content.includes(second.token),
      "access tokens are never persisted in plaintext",
    );
  }
});

test("legacy IDs gain stable short aliases without changing ownership, files, or cloud selection", async () => {
  const store = createFileThreadStore(join(directory, "legacy"));
  const seed = await resolveDemoSession(request(), true, store);
  const old = "0123456789abcdef0123456789abcdef";
  const legacy = {
    ...seed.thread,
    id: "f735e715-d28f-4b0a-afb1-f40fd1d56257",
    accessHash: accessHash(old),
  };
  await store.create(legacy);
  const upgraded = await resolveDemoSession(
    request(undefined, { cookie: `tress_demo_session=${old}` }),
    true,
    store,
  );
  assert.match(upgraded.token, /^[A-Za-z0-9_-]{12}$/);
  assert.equal(upgraded.thread.id, legacy.id);
  assert(upgraded.fresh, "the owning browser receives the shorter cookie");
  const linked = await resolveDemoSession(
    request(`https://demo.example/api/mode?session=${old}`, {
      cookie: sessionCookie(seed, request()),
    }),
    true,
    store,
  );
  assert.equal(linked.token, upgraded.token);
  assert(
    !linked.fresh,
    "a shared link must not overwrite another visitor's cookie",
  );
  await store.selectThread(accessHash(upgraded.token), "rotated-cloud-thread");
  const reopened = createFileThreadStore(join(directory, "legacy"));
  for (const token of [old, upgraded.token]) {
    const resumed = await resolveDemoSession(
      request(`https://demo.example/api/sessions/${token}/stream`),
      false,
      reopened,
    );
    assert.equal(resumed.thread.id, legacy.id);
    assert.equal(resumed.thread.harnessThreadId, "rotated-cloud-thread");
  }
  await assert.rejects(
    store.addAccess(seed.thread.accessHash, accessHash(upgraded.token)),
    /already exists/,
  );
  assert.equal((await reopened.get(accessHash(upgraded.token))).id, legacy.id);
});

test("local demo workspaces isolate file writes and keep each visitor's files across reopening", async () => {
  process.env.TRESS_WORKSPACE = "local";
  process.env.TRESS_WORKSPACE_ROOT = join(directory, "files");
  process.env.TRESS_LOCAL_DEMO = "1";
  const store = createFileThreadStore(join(directory, "workspaces"));
  const first = await resolveDemoSession(request(), true, store);
  const second = await resolveDemoSession(request(), true, store);
  const a = await openWorkspace(first.thread.id);
  const b = await openWorkspace(second.thread.id);
  await a.writeFile("notes.md", "visitor A only");
  assert(!(await b.readFile("notes.md")).includes("visitor A"));
  assert.equal(
    await (await openWorkspace(first.thread.id)).readFile("notes.md"),
    "visitor A only",
  );
  await assert.rejects(openWorkspace("../../outside"));
});
