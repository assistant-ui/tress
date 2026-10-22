import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import postcss from "postcss";
import { createTressFetch } from "../dist/index.js";

test("refreshes application credentials on stream and command/frame requests", async () => {
  const requests = [];
  let token = "first";
  const fetcher = createTressFetch({
    url: "https://app.example/api/threads/main",
    headers: () => ({ Authorization: `Bearer ${token}` }),
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response();
    },
  });
  await fetcher("https://app.example/api/threads/main/stream", {
    headers: { Accept: "text/event-stream" },
  });
  token = "refreshed";
  await fetcher(
    new Request("https://app.example/api/threads/main/frames", {
      headers: { "X-Request-ID": "request-1" },
    }),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  assert.equal(requests[0].init.headers.get("Authorization"), "Bearer first");
  assert.equal(requests[0].init.headers.get("Accept"), "text/event-stream");
  assert.equal(
    requests[1].init.headers.get("Authorization"),
    "Bearer refreshed",
  );
  assert.equal(requests[1].init.headers.get("X-Request-ID"), "request-1");
  assert.equal(
    requests[1].init.headers.get("Content-Type"),
    "application/json",
  );
  assert.equal(requests[1].init.credentials, "same-origin");
  assert.equal(requests[1].init.redirect, "error");
});

test("does not forward credentials to other origins, threads, or redirects", async () => {
  let fetched = false;
  const fetcher = createTressFetch({
    url: "https://app.example/api/threads/main/",
    headers: { Authorization: "private" },
    fetch: async () => {
      fetched = true;
      return new Response();
    },
  });
  for (const url of [
    "https://other.example/api/threads/main/stream",
    "https://app.example/api/threads/main-other/stream",
    "https://app.example/api/threads/main/../other/stream",
    "http://app.example/api/threads/main/stream",
  ])
    await assert.rejects(fetcher(url), /restricted/);
  assert.equal(fetched, false);
  for (const url of [
    "file:///thread",
    "https://user:pass@app.example/thread",
    "https://app.example/thread?secret=key",
    "https://app.example/thread#key",
  ])
    assert.throws(() => createTressFetch({ url }), /HTTP/);
});

test("embedded stylesheet is scoped and needs no external fonts or theme requests", async () => {
  const css = postcss.parse(
    await readFile(new URL("../dist/styles.css", import.meta.url), "utf8"),
  );
  css.walkAtRules("import", () => assert.fail("External CSS import"));
  css.walkRules((rule) => {
    if (rule.parent.type === "atrule" && /keyframes$/.test(rule.parent.name))
      return;
    for (const selector of rule.selectors)
      assert.match(selector, /^\.tress-ui(?:[\s.:[]|$)/);
  });
});

test("headless bundle imports in an isolated directory without React", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tress-client-headless-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL("../dist/", import.meta.url), join(directory, "dist"), {
    recursive: true,
  });
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import { createTressClient, createTressFetch } from "./dist/index.js"; if (typeof createTressClient !== "function" || typeof createTressFetch !== "function") throw new Error("Missing exports");',
    ],
    { cwd: directory },
  );
});

test("React entry supports server prerendering without browser globals", async () => {
  const { createElement } = await import("react");
  const { renderToString } = await import("react-dom/server");
  const { TressThread } = await import("../dist/react.js");
  const html = renderToString(
    createElement(TressThread, { url: "/api/threads/main" }),
  );
  assert.match(html, /Thread transcript/);
  assert.match(html, /Ask tress/);
});
