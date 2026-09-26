import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Pool } from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const directory = await mkdtemp(join(tmpdir(), "tress-session-test-"));
const output = new URL(
  `../.tress/sessions-test-${process.pid}.mjs`,
  import.meta.url,
);
await build({
  stdin: {
    contents:
      'export * from "./src/server/demo-session"; export * from "./src/server/thread-store"; export * from "./src/server/workspace"; export * from "./src/server/thread-list";',
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
  createPostgresThreadStore,
  resolveDemoOwner,
  ownerCookie,
  threadListRequest,
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

for (const backend of ["file", "postgres"])
  test(
    `${backend}: an owner manages multiple threads while attach IDs only grant one thread`,
    {
      skip:
        backend === "postgres" &&
        !(
          process.env.TRESS_RELAY_TEST_DATABASE_URL ??
          process.env.TRESS_DATABASE_URL
        ),
    },
    async (t) => {
      let pool;
      let store;
      const owners = [];
      if (backend === "postgres") {
        pool = new Pool({
          connectionString:
            process.env.TRESS_RELAY_TEST_DATABASE_URL ??
            process.env.TRESS_DATABASE_URL,
        });
        const migrations = new URL("../migrations/", import.meta.url);
        for (const name of (await readdir(migrations))
          .filter((name) => name.endsWith(".sql"))
          .sort())
          await pool.query(await readFile(new URL(name, migrations), "utf8"));
        store = createPostgresThreadStore(pool);
        t.after(async () => {
          await pool.query(
            "DELETE FROM tress_demo_threads WHERE owner_id = ANY($1::uuid[])",
            [owners],
          );
          await pool.query(
            "DELETE FROM tress_demo_owners WHERE id = ANY($1::uuid[])",
            [owners],
          );
          await pool.end();
        });
      } else store = createFileThreadStore(join(directory, "sidebar"));
      const boot = async (cookie, url) => {
        const req = request(url, cookie ? { cookie } : {});
        const owner = await resolveDemoOwner(req, true, store);
        owners.push(owner.id);
        const session = await resolveDemoSession(req, true, store, owner);
        return {
          owner,
          session,
          cookie: [ownerCookie(owner, req), sessionCookie(session, req)]
            .map((value) => value.split(";")[0])
            .join("; "),
        };
      };
      if (backend === "postgres") {
        const importDirectory = join(directory, "import-sidebar");
        const source = createFileThreadStore(importDirectory);
        const owner = await resolveDemoOwner(request(), true, source);
        owners.push(owner.id);
        const session = await resolveDemoSession(
          request(),
          true,
          source,
          owner,
        );
        await source.update(owner.id, session.thread.id, {
          title: "Imported workspace",
          archivedAt: new Date().toISOString(),
        });
        await promisify(execFile)(
          process.execPath,
          ["scripts/import-sessions.mjs"],
          {
            cwd: new URL("../", import.meta.url).pathname,
            env: {
              ...process.env,
              TRESS_DATABASE_URL:
                process.env.TRESS_RELAY_TEST_DATABASE_URL ??
                process.env.TRESS_DATABASE_URL,
              TRESS_SESSION_DIR: importDirectory,
            },
          },
        );
        assert.equal(await store.owner(accessHash(owner.token)), owner.id);
        const imported = await store.get(accessHash(session.token));
        assert.equal(imported.title, "Imported workspace");
        assert(imported.archivedAt);
      }
      const a = await boot();
      const b = await boot();
      const api = (visitor, method, suffix = "", body = {}, extra = {}) =>
        threadListRequest(
          new Request(`https://demo.example/api/threads${suffix}`, {
            method,
            headers: {
              cookie: visitor.cookie,
              "Content-Type": "application/json",
              ...extra,
            },
            ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
          }),
          store,
        );
      const listed = await (await api(a, "GET")).json();
      assert.deepEqual(
        listed.threads.map((thread) => thread.id),
        [a.session.thread.id],
      );
      assert(!JSON.stringify(listed).includes(a.owner.token));
      assert(!JSON.stringify(listed).includes(a.session.thread.accessHash));
      const created = await api(a, "POST");
      assert.equal(created.status, 201);
      const next = (await created.json()).session;
      const saved = await store.get(accessHash(next.attachId));
      assert.equal(saved.ownerId, a.owner.id);
      assert.notEqual(saved.id, a.session.thread.id);
      assert.equal((await (await api(a, "GET")).json()).threads.length, 2);
      const select = async () =>
        (await (await api(a, "POST", `/${saved.id}`)).json()).session;
      assert.equal(
        (await select()).attachId,
        next.attachId,
        "switching never rotates the attach ID",
      );
      assert.equal(
        (await boot(a.cookie)).session.thread.id,
        a.session.thread.id,
      );
      assert.equal((await api(b, "POST", `/${saved.id}`)).status, 404);
      assert.equal(
        (await api(b, "PATCH", `/${saved.id}`, { title: "stolen" })).status,
        404,
      );
      assert.equal(
        (await api({ cookie: `tress_demo_session=${next.attachId}` }, "GET"))
          .status,
        401,
      );
      assert.equal(
        (await api(a, "POST", "", {}, { origin: "https://foreign.example" }))
          .status,
        403,
      );
      assert.equal(
        (await api(a, "PATCH", `/${saved.id}`, { title: " " })).status,
        400,
      );
      assert.equal(
        (await api(a, "PATCH", `/${saved.id}`, { title: "x".repeat(81) }))
          .status,
        400,
      );
      await Promise.all([
        api(a, "PATCH", `/${saved.id}`, { title: "My workspace" }),
        store.selectThread(saved.accessHash, "rotated-by-terminal"),
      ]);
      await api(a, "PATCH", `/${saved.id}`, {
        title: "automatic title",
        ifUntitled: true,
      });
      assert.equal((await store.get(saved.accessHash)).title, "My workspace");
      assert.equal(
        (await store.get(saved.accessHash)).harnessThreadId,
        "rotated-by-terminal",
      );
      await api(a, "PATCH", `/${saved.id}`, { archived: true });
      assert((await store.get(saved.accessHash)).archivedAt);
      assert.equal(
        (await select()).attachId,
        next.attachId,
        "archiving keeps the original connection usable",
      );
      await api(a, "PATCH", `/${saved.id}`, { archived: false });
      assert.equal((await store.get(saved.accessHash)).archivedAt, null);
      const shared = await boot(
        b.cookie,
        `https://demo.example/api/mode?session=${next.attachId}`,
      );
      assert.equal(shared.session.thread.id, saved.id);
      assert.equal(shared.owner.id, b.owner.id);
      assert.equal((await (await api(shared, "GET")).json()).threads.length, 1);
      const stolenCookie = await boot(`tress_demo_session=${next.attachId}`);
      assert.notEqual(
        stolenCookie.owner.id,
        a.owner.id,
        "a thread cookie cannot recover an established owner",
      );
      assert.equal(
        (await (await api(stolenCookie, "GET")).json()).threads.length,
        0,
      );
      const legacy = await resolveDemoSession(request(), true, store);
      const adopted = await boot(`tress_demo_session=${legacy.token}`);
      assert.equal(adopted.owner.id, legacy.thread.ownerId);
      assert.equal(adopted.session.thread.id, legacy.thread.id);
      assert.equal(
        (await store.get(accessHash(legacy.token))).id,
        legacy.thread.id,
        "existing terminal IDs stay valid",
      );
      if (backend === "file") {
        const restarted = createFileThreadStore(join(directory, "sidebar"));
        assert.equal(
          await restarted.owner(accessHash(a.owner.token)),
          a.owner.id,
        );
        assert.equal((await restarted.list(a.owner.id)).length, 2);
      }
    },
  );
