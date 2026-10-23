import { createServer } from "node:http";
import { Readable } from "node:stream";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  readFile,
  realpath,
  mkdir,
  chmod,
  lstat,
  open,
} from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join, relative, sep } from "node:path";
import lockfile from "proper-lockfile";
import { createUIMessageStreamResponse } from "ai";
import { createLocalHarnessHost, createTressTransport } from "./index.mjs";
import { createManagedHarnessHost } from "./managed.mjs";
import { fileStorage } from "./storage.mjs";
import { machineWorkspace } from "./workspace.mjs";

const equal = (a, b) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (value, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
export async function startMachineHost(options) {
  const root = await realpath(options.root);
  const directory = resolve(options.stateDir);
  if (directory === root || directory.startsWith(root + sep))
    throw new Error("Store Harness state outside the project.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const release = await lockfile.lock(directory, {
    stale: 10_000,
    retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000 },
  });
  let thread;
  let server;
  try {
    const metadata = fileStorage(join(directory, "host.json"));
    const binding = {
      root,
      mode: options.cloud ? "managed" : "local",
      origin: options.cloud?.origin ?? null,
      workspaceId: options.cloud?.workspaceId ?? null,
      threadId: options.cloud?.threadId ?? "main",
    };
    let saved = await metadata.load();
    if (saved && JSON.stringify(saved.binding) !== JSON.stringify(binding))
      throw new Error(
        "This state directory belongs to another workspace or Harness backend.",
      );
    saved ??= {
      binding,
      token: randomBytes(32).toString("hex"),
      backendToken: randomBytes(32).toString("hex"),
    };
    const workspace = await machineWorkspace({
      root,
      allowExec: options.allowExec,
    });
    const transport = createTressTransport({
      Session: options.Session,
      workspace,
      url: options.modelUrl,
      model: options.model,
      headers: options.modelHeaders,
      maxSteps: options.maxSteps,
      system:
        options.system ??
        "You are Tress. Work in the configured project. Use tools to verify your work.",
      tools: {
        include: [
          "read",
          "ls",
          ...(options.allowWrite ? ["write", "edit"] : []),
          ...(options.allowExec ? ["bash"] : []),
        ],
      },
    });
    let origin;
    const handler = async (request) => {
      const url = new URL(request.url);
      if (url.origin !== origin)
        return new Response("Invalid host", { status: 403 });
      const requestOrigin = request.headers.get("origin");
      if (requestOrigin && requestOrigin !== origin)
        return new Response("Origin denied", { status: 403 });
      if (url.pathname === "/")
        return new Response(page, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy":
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
            "referrer-policy": "no-referrer",
          },
        });
      if (url.pathname === "/browser.js")
        return new Response(options.browserJs, {
          headers: { "content-type": "text/javascript" },
        });
      if (url.pathname === "/browser.css")
        return new Response(options.browserCss ?? "", {
          headers: { "content-type": "text/css" },
        });
      if (
        options.cloud &&
        equal(url.pathname, `/agent/${saved.backendToken}`)
      ) {
        if (request.method !== "POST")
          return new Response(null, { status: 405 });
        const body = await request.json();
        const managedId = `${new URL(options.cloud.origin).hostname.split(".")[0]}~${binding.threadId}`;
        if (body.id !== binding.threadId && body.id !== managedId)
          return new Response("Wrong managed thread", { status: 403 });
        return createUIMessageStreamResponse({
          stream: await transport.sendMessages({
            messages: body.messages,
            abortSignal: request.signal,
          }),
        });
      }
      if (!equal(request.headers.get("authorization"), `Bearer ${saved.token}`))
        return new Response("Unauthorized", { status: 401 });
      if (url.pathname.startsWith("/api/threads/main/"))
        return thread.fetch(request);
      if (url.pathname === "/api/info")
        return json({
          ...binding,
          headersFile: join(directory, "headers.json"),
          model: options.model,
          allowWrite: !!options.allowWrite,
          allowExec: !!options.allowExec,
        });
      if (url.pathname === "/api/flush" && request.method === "POST") {
        await thread.flush?.();
        return json({ saved: true });
      }
      if (url.pathname === "/api/stop" && request.method === "POST") {
        setTimeout(
          () =>
            void close().catch((error) =>
              (options.onError ?? console.error)(error),
            ),
          20,
        );
        return json({ stopping: true });
      }
      if (url.pathname === "/api/files" && request.method === "GET")
        return json(
          await workspace.listFiles(url.searchParams.get("path") ?? ""),
        );
      if (url.pathname === "/api/file" && request.method === "GET") {
        const path = url.searchParams.get("path") ?? "";
        const target = resolve(root, path);
        const rel = relative(root, target);
        if (
          !rel ||
          rel.startsWith("..") ||
          rel.split(sep).some((s) => s === "." || s === "..")
        )
          return new Response("Invalid file", { status: 403 });
        let part = root;
        for (const segment of rel.split(sep)) {
          part = join(part, segment);
          if ((await lstat(part)).isSymbolicLink())
            return new Response("Symlinks are not available", { status: 403 });
        }
        const file = await open(
          target,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
            return new Response("File unavailable or too large", {
              status: 413,
            });
          return new Response(await file.readFile(), {
            headers: {
              "content-type": "application/octet-stream",
              "content-disposition": "attachment",
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
            },
          });
        } finally {
          await file.close();
        }
      }
      return new Response("Not found", { status: 404 });
    };
    server = createServer(async (incoming, outgoing) => {
      const abort = new AbortController();
      outgoing.on("close", () => abort.abort());
      try {
        if (incoming.headers.host !== new URL(origin).host) {
          outgoing.writeHead(403).end();
          return;
        }
        let body;
        if (!["GET", "HEAD"].includes(incoming.method)) {
          const chunks = [];
          let bytes = 0;
          for await (const chunk of incoming) {
            bytes += chunk.length;
            if (bytes > 8 * 1024 * 1024) {
              outgoing.writeHead(413).end();
              return;
            }
            chunks.push(chunk);
          }
          body = Buffer.concat(chunks);
        }
        const request = new Request(new URL(incoming.url, origin), {
          method: incoming.method,
          headers: incoming.headers,
          signal: abort.signal,
          ...(body && { body }),
        });
        const response = await handler(request);
        outgoing.writeHead(
          response.status,
          Object.fromEntries(response.headers),
        );
        if (response.body)
          Readable.fromWeb(response.body)
            .on("error", () => outgoing.destroy())
            .pipe(outgoing);
        else outgoing.end();
      } catch (error) {
        if (!outgoing.headersSent)
          outgoing
            .writeHead(500, { "content-type": "text/plain" })
            .end("Host request failed");
        else outgoing.destroy();
        options.onError?.(error);
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    thread = options.cloud
      ? createManagedHarnessHost({
          ...options.cloud,
          url: `${origin}/agent/${saved.backendToken}`,
        })
      : createLocalHarnessHost({
          threadId: "main",
          transport,
          storage: fileStorage(join(directory, "thread.json")),
          onError: options.onError,
        });
    await fileStorage(join(directory, "headers.json")).save({
      Authorization: `Bearer ${saved.token}`,
    });
    await metadata.save({ ...saved, origin, pid: process.pid });
    const browserUrl = `${origin}/#${saved.token}`;
    let closing;
    const close = () =>
      (closing ??= (async () => {
        try {
          await thread.close();
        } finally {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
          await release();
        }
      })());
    return {
      origin,
      browserUrl,
      endpoint: `${origin}/api/threads/main`,
      headersFile: join(directory, "headers.json"),
      close,
    };
  } catch (error) {
    await thread?.close().catch(() => {});
    server?.closeAllConnections();
    server?.close();
    await release();
    throw error;
  }
}

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tress workspace</title><link rel="stylesheet" href="/browser.css"></head><body><div id="root"></div><noscript>Enable JavaScript to connect to your Tress host.</noscript><script type="module" src="/browser.js"></script></body></html>`;
