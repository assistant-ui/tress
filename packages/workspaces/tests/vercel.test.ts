import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  realpath,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "@vercel/sandbox";
import {
  createVercelWorkspace,
  type VercelSandboxClient,
} from "../src/vercel.js";

// Compile-time check against the installed SDK, without credentials/network.
const acceptsSandbox = (sandbox: Sandbox): VercelSandboxClient => sandbox;
void acceptsSandbox;

test("remote adapter uses SDK file APIs, preserves command arguments, and refuses path escapes", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "tress-remote-contract-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "remote root");
  await mkdir(root);
  const calls: unknown[] = [];
  const sandbox: VercelSandboxClient = {
    fs: { readFile, writeFile, mkdir, readdir, realpath },
    async runCommand(params) {
      calls.push(params);
      return {
        exitCode: 7,
        stdout: async () => "output",
        stderr: async () => "failure",
      };
    },
  };
  const workspace = await createVercelWorkspace({
    sandbox,
    root,
    timeoutMs: 1234,
  });
  await workspace.writeFile("src/file with ' quotes.txt", "remote");
  assert.equal(
    await workspace.readFile("src/file with ' quotes.txt"),
    "remote",
  );
  assert.deepEqual(await workspace.listFiles("src"), [
    { name: "file with ' quotes.txt", type: "file" },
  ]);
  assert.deepEqual(await workspace.exec!("npm test && echo '$HOME'"), {
    stdout: "output",
    stderr: "failure",
    exitCode: 7,
  });
  assert.deepEqual(calls, [
    {
      cmd: "bash",
      args: ["-c", "npm test && echo '$HOME'"],
      cwd: await realpath(root),
      env: undefined,
      timeoutMs: 1234,
    },
  ]);
  await writeFile(join(parent, "outside"), "private");
  await symlink(parent, join(root, "link"));
  await assert.rejects(workspace.readFile("../outside"));
  await assert.rejects(workspace.readFile("link/outside"));
  await assert.rejects(workspace.writeFile("link/new/path", "no"));
  assert.equal(await readFile(join(parent, "outside"), "utf8"), "private");
});
