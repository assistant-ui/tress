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
import { listenFetch } from "@assistant-ui/pinboard/node";

// A socket's first frame carries its credentials (and any commands queued while
// it was offline). Until the host answers it, a bigger message closes the socket
// with 1009 before it is buffered; the hello lifts the cap to Pinboard's default.
const UNAUTHENTICATED_MAX_PAYLOAD = 1024 * 1024;
const capUntilHello = (accepted) =>
  accepted instanceof Response
    ? accepted
    : {
        ...accepted,
        maxPayload: UNAUTHENTICATED_MAX_PAYLOAD,
        attach(socket, limits) {
          const send = socket.send;
          socket.send = (data) => {
            // Statewire sends `syn` only to an authorized attach.
            if (socket.send !== send && JSON.parse(data).syn) {
              socket.send = send;
              limits.lift();
            }
            send(data);
          };
          accepted.attach(socket, limits);
        },
      };

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
    // Browsers can't set headers on a WebSocket: the token arrives in the
    // socket's first frame, which Statewire hands to `authorize`.
    const authorize = ({ headers }) => {
      if (!equal(headers.authorization, `Bearer ${saved.token}`))
        throw new Response("Unauthorized", { status: 401 });
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
        // The run stops when the caller stops reading. (Pinboard aborts
        // `request.signal` once a body has been read, not on disconnect.)
        const run = new AbortController();
        const stream = await transport.sendMessages({
          messages: body.messages,
          abortSignal: run.signal,
        });
        const reader = stream.getReader();
        return createUIMessageStreamResponse({
          stream: new ReadableStream({
            async pull(controller) {
              const { done, value } = await reader.read();
              if (done) controller.close();
              else controller.enqueue(value);
            },
            cancel(reason) {
              run.abort(reason);
              return reader.cancel(reason);
            },
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
          // Clients use this to tell a host that serves Statewire WebSockets
          // from one started by an older release (HTTP/SSE only).
          websocket: "/api/threads/main/ws",
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
    const upgrade = async (request) => {
      const url = new URL(request.url);
      if (url.origin !== origin)
        return new Response("Invalid host", { status: 403 });
      const requestOrigin = request.headers.get("origin");
      if (requestOrigin && requestOrigin !== origin)
        return new Response("Origin denied", { status: 403 });
      if (url.pathname !== "/api/threads/main/ws")
        return new Response("Not found", { status: 404 });
      return capUntilHello(await thread.upgrade(request));
    };
    // Pinboard serves the app: HTTP through `fetch`, `…/ws` through `upgrade`.
    server = await listenFetch(
      { fetch: handler, upgrade },
      {
        host: "127.0.0.1",
        port: options.port ?? 0,
        log: { error: (_message, error) => (options.onError ?? console.error)(error) },
      },
    );
    origin = `http://127.0.0.1:${server.port}`;
    thread = options.cloud
      ? createManagedHarnessHost({
          ...options.cloud,
          url: `${origin}/agent/${saved.backendToken}`,
          authorize,
        })
      : createLocalHarnessHost({
          threadId: "main",
          transport,
          storage: fileStorage(join(directory, "thread.json")),
          authorize,
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
          server.server.closeAllConnections();
          await server.close();
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
    await server?.close();
    await release();
    throw error;
  }
}

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tress workspace</title><link rel="stylesheet" href="/browser.css"></head><body><div id="root"></div><noscript>Enable JavaScript to connect to your Tress host.</noscript><script type="module" src="/browser.js"></script></body></html>`;
