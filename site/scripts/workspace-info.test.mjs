import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const output = new URL(`../.tress/workspace-info-test-${process.pid}.mjs`, import.meta.url);
await build({
  entryPoints: [new URL("../src/server/workspace.ts", import.meta.url).pathname],
  outfile: output.pathname,
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
});
const { workspaceInfo } = await import(output.href);
after(() => rm(output, { force: true }));

test("local workspace metadata identifies the visitor's folder, not the shared parent", () => {
  process.env.TRESS_WORKSPACE = "local";
  process.env.TRESS_WORKSPACE_ROOT = ".tress/workspace";
  process.env.TRESS_WORKSPACE_ENVIRONMENT = "device";
  const scope = "a41ed8b6-1903-4034-a5cb-77f7f83d81a2";
  assert.deepEqual(workspaceInfo(scope), {
    mode: "local",
    details: { environment: "device", access: "in-process", storage: "filesystem", shell: "none", writable: false, label: "host directory" },
    root: resolve(".tress/workspace/threads", scope),
  });
  assert.throws(() => workspaceInfo("../other"), /Invalid workspace id/);
});

test("virtual and sandbox metadata never exposes a configured host path", () => {
  process.env.TRESS_WORKSPACE_ROOT = "/host/private";
  process.env.TRESS_WORKSPACE = "memory";
  assert.deepEqual(workspaceInfo(), { mode: "memory", details: { environment: "virtual", access: "in-process", storage: "memory", shell: "simulated", writable: true, label: "virtual workspace" } });
  process.env.TRESS_WORKSPACE = "overlay";
  assert.deepEqual(workspaceInfo(), { mode: "overlay", details: { environment: "device", access: "in-process", storage: "overlay", shell: "simulated", writable: true, label: "local overlay" } });
  process.env.TRESS_WORKSPACE = "vercel";
  assert.deepEqual(workspaceInfo(), { mode: "vercel", details: { environment: "sandbox", access: "connected", storage: "filesystem", shell: "none", writable: false, label: "remote sandbox" } });
  delete process.env.TRESS_WORKSPACE_ENVIRONMENT;
});
