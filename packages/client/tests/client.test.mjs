import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import postcss from "postcss";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { createTressClient } from "../dist/index.js";

test("sends credentials in the first WebSocket frame and refreshes them after a refusal", async (t) => {
  const attaches = [];
  const server = createServer();
  const sockets = new WebSocketServer({
    server,
    handleProtocols: (offered) => (offered.has("statewire.v1") ? "statewire.v1" : false),
  });
  sockets.on("connection", (socket, request) => {
    socket.once("message", (data) => {
      attaches.push({ url: request.url, auth: request.headers.authorization, frame: JSON.parse(String(data)) });
      if (attaches.length === 1)
        socket.send(JSON.stringify({ fin: { reason: "unauthorized", message: "unauthorized" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const calls = [];
  const client = createTressClient({
    url: `http://127.0.0.1:${server.address().port}/api/threads/main/`,
    headers: ({ staleAuth }) => {
      calls.push(staleAuth);
      return { Authorization: `Bearer ${staleAuth ? "refreshed" : "first"}` };
    },
  });
  t.after(async () => {
    client.dispose();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const deadline = Date.now() + 8000;
  while (attaches.length < 2 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(attaches.length, 2);
  assert.deepEqual(calls.slice(0, 2), [false, true]);
  for (const attach of attaches) {
    const url = new URL(attach.url, "http://host");
    assert.equal(url.pathname, "/api/threads/main/ws");
    assert.deepEqual([...url.searchParams.keys()], ["client"]);
    assert.equal(attach.auth, undefined);
  }
  assert.equal(attaches[0].frame.headers.authorization, "Bearer first");
  assert.equal(attaches[1].frame.headers.authorization, "Bearer refreshed");
});

test("rejects endpoints that would carry credentials or a query", () => {
  for (const url of [
    "file:///thread",
    "ws://app.example/thread",
    "https://user:pass@app.example/thread",
    "https://app.example/thread?secret=key",
    "https://app.example/thread#key",
  ])
    assert.throws(() => createTressClient({ url }), /HTTP/);
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
      'import { createTressClient } from "./dist/index.js"; if (typeof createTressClient !== "function") throw new Error("Missing exports");',
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
