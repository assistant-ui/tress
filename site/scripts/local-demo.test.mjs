import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareLocalDemo } from "./local-demo.mjs";

test("local demo seeds a disk workspace and preserves edits on restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tress-local-demo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await prepareLocalDemo(root);
  assert.match(
    await readFile(join(root, "notes.md"), "utf8"),
    /This file lives on your computer/,
  );
  assert.match(
    await readFile(join(root, "README.md"), "utf8"),
    /Local workspace demo/,
  );
  await writeFile(join(root, "notes.md"), "Keep the user's changes.\n");
  await prepareLocalDemo(root);
  assert.equal(
    await readFile(join(root, "notes.md"), "utf8"),
    "Keep the user's changes.\n",
  );
});
