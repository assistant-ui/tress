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
  stdin: {
    contents: 'export * from "./src/lib/demo-config"; export * from "./src/lib/demo-page";',
    resolveDir: new URL("../", import.meta.url).pathname,
  },
  outfile: output.pathname,
  bundle: true,
  platform: "node",
  format: "esm",
});
const { observeDemoConfig, createDemoPage } = await import(output.href);
after(() => rm(output, { force: true }));
const config = {
  configured: true,
  model: "test-model",
  workspace: { mode: "local", writes: true },
};

test("each document gets a fresh session, while opening a session link resumes it", () => {
  const first = createDemoPage("https://demo.example/", "navigate");
  const reload = createDemoPage("https://demo.example/?session=previous1234", "reload");
  const nextReload = createDemoPage("https://demo.example/?session=previous1234", "reload");
  assert.match(first.url, /^\/api\/mode\?newSession=[A-Za-z0-9_-]{12}$/);
  assert.match(reload.url, /^\/api\/mode\?newSession=[A-Za-z0-9_-]{12}$/);
  assert.notEqual(first.url, reload.url);
  assert.notEqual(reload.url, nextReload.url);
  assert.equal(createDemoPage("https://demo.example/?session=previous1234", "navigate").url,
    "/api/mode?session=previous1234");
  assert.equal(createDemoPage("https://demo.example/?session=previous1234", "back_forward").url,
    "/api/mode?session=previous1234");
});

test("effect remounts share one bootstrap and explicit reconnects stay pinned", async () => {
  const calls = [];
  let finish;
  const page = createDemoPage("https://demo.example/", "reload", (url, options) => {
    calls.push({ url, options });
    return new Promise((resolve) => { finish = resolve; });
  });
  const aborted = new AbortController();
  const first = page.fetchConfig(page.url, { signal: aborted.signal });
  aborted.abort();
  const second = page.fetchConfig(page.url);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal.aborted, false);
  finish(Response.json(config));
  assert.deepEqual(await (await first).json(), config);
  assert.deepEqual(await (await second).json(), config);
  assert.deepEqual(await (await page.fetchConfig(page.url)).json(), config);
  assert.equal(calls.length, 1);
  const reconnect = page.fetchConfig("/api/mode?session=current12345");
  assert.equal(calls[1].url, "/api/mode?session=current12345");
  finish(Response.json(config));
  await reconnect;
});

test("bootstrap errors retry with the same creation token", async () => {
  const calls = [];
  const page = createDemoPage("https://demo.example/", "reload", async (url) => {
    calls.push(url);
    if (calls.length === 1) throw new Error("offline");
    return calls.length === 2 ? new Response("restarting", { status: 503 }) : Response.json(config);
  });
  await assert.rejects(page.fetchConfig(page.url), /offline/);
  assert.equal((await page.fetchConfig(page.url)).status, 503);
  assert.deepEqual(await (await page.fetchConfig(page.url)).json(), config);
  assert.deepEqual(calls, [page.url, page.url, page.url]);
});

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

test("expired sessions show the server explanation and stop automatic retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const updates = [];
  let calls = 0;
  const observer = observeDemoConfig(
    (update) => updates.push(update),
    async () => {
      calls++;
      return Response.json(
        { error: "This demo session has expired." },
        { status: 410 },
      );
    },
  );
  t.after(observer.dispose);
  await setImmediate();
  assert.deepEqual(updates.at(-1), {
    status: "error",
    message: "This demo session has expired.",
    retryable: false,
  });
  t.mock.timers.tick(60000);
  await setImmediate();
  assert.equal(calls, 1);
});

test("new-session rate limits honor Retry-After", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const observer = observeDemoConfig(
    () => {},
    async () => {
      calls++;
      return Response.json(
        { error: "Daily limit reached." },
        { status: 429, headers: { "Retry-After": "60" } },
      );
    },
  );
  t.after(observer.dispose);
  await setImmediate();
  t.mock.timers.tick(59000);
  await setImmediate();
  assert.equal(calls, 1);
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(calls, 2);
});
