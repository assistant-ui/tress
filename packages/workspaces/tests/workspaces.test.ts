import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBashWorkspace } from "../src/just-bash.js";
import { createLocalWorkspace } from "../src/local.js";
import { createWorkspaceTools, WORKSPACE_TOOLS } from "../src/tools.js";
import { snapshotWorkspace } from "../src/snapshot.js";

test("virtual shell and file tools share writes, directories, and exit status", async () => {
  const workspace = createBashWorkspace({ files: { "note.txt": "hello" } });
  const tools = createWorkspaceTools(workspace, { include: WORKSPACE_TOOLS });
  assert.equal(
    (
      await tools.execute("bash", {
        command: "mkdir -p src; cat note.txt | tr a-z A-Z > src/out.txt",
      })
    ).is_error,
    false,
  );
  assert.equal(await workspace.readFile("src/out.txt"), "HELLO");
  await workspace.writeFile("src/next.txt", "next");
  assert.equal((await workspace.exec!("cat src/next.txt")).stdout, "next");
  assert.equal(
    (await tools.execute("bash", { command: "false" })).is_error,
    true,
  );
  assert.deepEqual(await workspace.listFiles("src"), [
    { name: "next.txt", type: "file" },
    { name: "out.txt", type: "file" },
  ]);
});

test("local disk and overlay modes are scoped and keep different write semantics", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "tress-local-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "project");
  await mkdir(root);
  await writeFile(join(root, "note.txt"), "original");
  await writeFile(join(parent, "outside.txt"), "private");
  const overlay = await createLocalWorkspace({ root, mode: "overlay" });
  await overlay.exec!("echo preview > note.txt");
  assert.equal(await overlay.readFile("note.txt"), "preview\n");
  assert.equal(await readFile(join(root, "note.txt"), "utf8"), "original");
  const local = await createLocalWorkspace({ root });
  await local.exec!("echo persisted > note.txt");
  assert.equal(await readFile(join(root, "note.txt"), "utf8"), "persisted\n");
  await local.writeFile("nested/new.txt", "created");
  assert.equal((await local.exec!("cat nested/new.txt")).stdout, "created");
  // Constructing/using a local workspace must not seed unrelated host folders.
  assert.deepEqual((await readdir(root)).sort(), ["nested", "note.txt"]);
  await symlink(join(parent, "outside.txt"), join(root, "escape"));
  for (const workspace of [local, overlay]) {
    await assert.rejects(workspace.readFile("../outside.txt"));
    await assert.rejects(workspace.readFile("/etc/passwd"));
    await assert.rejects(workspace.readFile("escape"));
    assert.notEqual((await workspace.exec!("cat escape")).exitCode, 0);
  }
  await assert.rejects(local.writeFile("escape", "overwrite"));
  // Overlay writes can shadow the link in memory without following it.
  await overlay.writeFile("escape", "preview only");
  assert.equal(await overlay.readFile("escape"), "preview only");
  assert.equal(await readFile(join(parent, "outside.txt"), "utf8"), "private");
});

test("policy fails closed before mutations and custom tools", async () => {
  const workspace = createBashWorkspace({ files: { "a.txt": "keep" } });
  assert.equal(
    (
      await createWorkspaceTools(workspace).execute("write", {
        path: "a.txt",
        content: "oops",
      })
    ).is_error,
    true,
  );
  let customCalls = 0;
  const tools = createWorkspaceTools(workspace, {
    include: WORKSPACE_TOOLS,
    authorize: async () => false,
    custom: [
      {
        name: "deploy",
        description: "test",
        input_schema: { type: "object" },
        execute: async () => {
          customCalls++;
          return { content: "done", is_error: false };
        },
      },
    ],
  });
  assert.match(
    (await tools.execute("write", { path: "a.txt", content: "oops" })).content,
    /denied/,
  );
  assert.equal((await tools.execute("deploy", {})).is_error, true);
  assert.equal(customCalls, 0);
  assert.equal(await workspace.readFile("a.txt"), "keep");
  const failingPolicy = createWorkspaceTools(workspace, {
    include: WORKSPACE_TOOLS,
    authorize: async () => {
      throw new Error("policy unavailable");
    },
  });
  assert.equal(
    (await failingPolicy.execute("write", { path: "a.txt", content: "oops" }))
      .is_error,
    true,
  );
  assert.equal(await workspace.readFile("a.txt"), "keep");
});

test("edits reject ambiguous text and invalid input; observer failure does not imply failed writes", async () => {
  const workspace = createBashWorkspace({ files: { a: "aaa" } });
  const observed: unknown[] = [];
  const tools = createWorkspaceTools(workspace, {
    include: WORKSPACE_TOOLS,
    onToolResult: () => {
      throw new Error("viewer unavailable");
    },
    onObserverError: (error) => {
      observed.push(error);
    },
  });
  for (const old of ["", "aa", "missing"])
    assert.equal(
      (await tools.execute("edit", { path: "a", old, new: "b" })).is_error,
      true,
    );
  assert.equal(
    (await tools.execute("write", { path: 123, content: "x" })).is_error,
    true,
  );
  assert.equal(
    (await tools.execute("edit", { path: "a", old: "aaa", new: "b" })).is_error,
    false,
  );
  assert.equal(await workspace.readFile("a"), "b");
  assert.ok(observed.length);
});

test("file previews are opt-in, bounded, exclude hidden files and do not mutate the workspace", async () => {
  const workspace = createBashWorkspace({
    files: {
      "src/a": "1234",
      "src/b": "1234",
      ".env": "secret",
      "node_modules/dep": "skip",
      "key.pem": "skip",
      binary: "a\0b",
    },
  });
  assert.deepEqual(
    { ...(await snapshotWorkspace(workspace, { paths: [] })) },
    {},
  );
  assert.deepEqual(
    {
      ...(await snapshotWorkspace(workspace, {
        paths: ["src"],
        maxTotalChars: 5,
      })),
    },
    { "src/a": "1234" },
  );
  assert.deepEqual(
    { ...(await snapshotWorkspace(workspace, { paths: [""] })) },
    { "src/a": "1234", "src/b": "1234" },
  );
  assert.equal(await workspace.readFile(".env"), "secret");
  assert.deepEqual(
    {
      ...(await snapshotWorkspace(workspace, {
        paths: ["src"],
        maxEntries: 1,
      })),
    },
    {},
  );
});
