import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { build } from "esbuild";

const output = new URL(`../.tress/backend-test-${process.pid}.mjs`, import.meta.url);
await build({
  entryPoints: [new URL("../src/server/managed-backend.ts", import.meta.url).pathname],
  outfile: output.pathname,
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
});
const { managedBackendUrl } = await import(output.href);
after(() => rm(output, { force: true }));
const alias = "old-session-id-12345678901234567";
assert.equal(alias.length, 32);
const hash = createHash("sha256").update(alias).digest("hex");
const store = { get: async (value) => value === hash ? { id: "visitor-a" } : undefined };
const config = {
  kind: "cloud",
  origin: "https://managed.example.com",
  workspaceId: "tests",
  initialThreadId: "unused",
  backendUrl: "http://localhost:5311/api/chat?session=newSession12",
};
const pin = `http://localhost:5311/api/chat?session=${alias}`;
const refusal = (url) => Response.json({ detail: `thread is pinned to ${url}` }, { status: 403 });

test("a new attach alias resumes the same pinned callback and saved cloud thread", async () => {
  let calls = 0;
  const result = await managedBackendUrl(config, "visitor-a", "saved-thread", store, async (url, init) => {
    calls++;
    assert.equal(url.href, "https://managed.example.com/threads/managed~saved-thread/stream");
    assert.equal(init.headers["Aui-Backend-Url"], config.backendUrl);
    assert.equal(init.redirect, "error");
    return refusal(pin);
  });
  assert.equal(result, pin);
  assert.equal(calls, 1);
});

test("pin recovery cannot route to another visitor, host, path, or query", async () => {
  for (const url of [
    pin.replace("localhost", "elsewhere.example"),
    pin.replace("/api/chat", "/admin"),
    `${pin}&mode=other`,
    `${pin}&session=another-id12`,
    pin.replace(alias, "another-id12"),
    "not a URL",
  ]) {
    assert.equal(await managedBackendUrl(config, "visitor-a", "saved-thread", store, async () => refusal(url)), config.backendUrl);
  }
  assert.equal(await managedBackendUrl(config, "visitor-b", "saved-thread", store, async () => refusal(pin)), config.backendUrl);
});

test("a valid callback closes its probe; unrelated refusals and outages remain SDK errors", async () => {
  let cancelled = false;
  assert.equal(await managedBackendUrl(config, "visitor-a", "saved-thread", store, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }))), config.backendUrl);
  assert(cancelled);
  for (const response of [new Response("unauthorized", { status: 401 }), Response.json({ detail: "thread belongs to another workspace" }, { status: 403 }), new Response("invalid body", { status: 403 })]) {
    assert.equal(await managedBackendUrl(config, "visitor-a", "saved-thread", store, async () => response), config.backendUrl);
  }
  assert.equal(await managedBackendUrl(config, "visitor-a", "saved-thread", store, async () => { throw new Error("offline"); }), config.backendUrl);
});
