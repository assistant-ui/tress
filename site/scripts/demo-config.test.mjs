import assert from "node:assert/strict";
import { after, test } from "node:test";
import { rm } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { build } from "esbuild";

const output = new URL(
  `../.tress/config-test-${process.pid}.mjs`,
  import.meta.url,
);
await build({
  entryPoints: [new URL("../src/lib/demo-config.ts", import.meta.url).pathname],
  outfile: output.pathname,
  bundle: true,
  platform: "node",
  format: "esm",
});
const { observeDemoConfig } = await import(output.href);
after(() => rm(output, { force: true }));
const config = {
  configured: true,
  model: "test-model",
  workspace: { mode: "local", writes: true },
};

test("a failed configuration fetch recovers automatically when the host returns", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const updates = [];
  let calls = 0;
  const observer = observeDemoConfig(
    (update) => updates.push(update),
    async (url, options) => {
      assert.equal(url, "/api/mode");
      assert.equal(options.cache, "no-store");
      return ++calls === 1
        ? new Response("restarting", { status: 503 })
        : Response.json(config);
    },
  );
  t.after(observer.dispose);
  await setImmediate();
  assert.equal(updates.at(-1).status, "error");
  t.mock.timers.tick(999);
  await setImmediate();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.deepEqual(updates.at(-1), { status: "ready", config });
  observer.retryIfNeeded();
  t.mock.timers.tick(15000);
  await setImmediate();
  assert.equal(calls, 2, "a healthy tab stops retrying");
});

test("retry now bypasses backoff without starting duplicate requests", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const updates = [];
  let calls = 0;
  let finish;
  const observer = observeDemoConfig(
    (update) => updates.push(update),
    async () => {
      if (++calls === 1) return Response.json({ error: "not a configuration" });
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  );
  t.after(observer.dispose);
  await setImmediate();
  assert.equal(updates.at(-1).status, "error");
  void observer.retry();
  observer.retryIfNeeded();
  assert.equal(calls, 2);
  finish(Response.json(config));
  await setImmediate();
  assert.equal(updates.at(-1).status, "ready");
  t.mock.timers.tick(15000);
  await setImmediate();
  assert.equal(calls, 2, "the cancelled backoff cannot overwrite success");
});

test("hung requests time out and disposed tabs cancel their retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const updates = [];
  let signal;
  let calls = 0;
  const observer = observeDemoConfig(
    (update) => updates.push(update),
    async (_url, options) => {
      calls++;
      signal = options.signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    },
  );
  t.after(observer.dispose);
  t.mock.timers.tick(10000);
  await setImmediate();
  assert(signal.aborted);
  assert.equal(updates.at(-1).status, "error");
  observer.dispose();
  const count = updates.length;
  t.mock.timers.tick(15000);
  observer.retryIfNeeded();
  await setImmediate();
  assert.equal(calls, 1);
  assert.equal(updates.length, count);
});

test("a late response after unmount cannot change the page", async () => {
  const updates = [];
  let finish;
  const observer = observeDemoConfig(
    (update) => updates.push(update),
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  observer.dispose();
  finish(Response.json(config));
  await setImmediate();
  assert.deepEqual(updates, [{ status: "loading" }]);
});
