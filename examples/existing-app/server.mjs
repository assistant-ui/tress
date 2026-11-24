import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createUIMessageStream, DirectChatTransport } from "ai";
import { AISDKTransport } from "@harness-sdk/ai-sdk";
import { statewireHost } from "statewire-node";
import { resource } from "@assistant-ui/tap";
import { useStatewireState, useStatewireCommands } from "statewire/host";
import { HARNESS_THREADS_PROTOCOL } from "harness-sdk";
import { HARNESS_HOST_PROTOCOL } from "harness-sdk/host";
import { createTressAccess } from "@tress/access";
import { listenFetch } from "@assistant-ui/pinboard/node";

const password = process.env.APP_PASSWORD;
if (!password || password.length < 12) throw new Error("Set APP_PASSWORD to at least 12 characters.");
const port = Number(process.env.PORT ?? 3000);
const origin = process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
if (new URL(origin).origin !== origin) throw new Error("PUBLIC_ORIGIN must be a bare HTTP(S) origin.");
const dataDir = resolve(process.env.DATA_DIR ?? ".data");
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function load(name, fallback) {
  try { return JSON.parse(await readFile(resolve(dataDir, name), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
let writes = Promise.resolve();
function save(name, value) {
  const encoded = JSON.stringify(value);
  const next = writes.then(async () => {
    const path = resolve(dataDir, name);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, encoded, { mode: 0o600 });
    await rename(temporary, path);
  });
  writes = next.catch(() => {});
  return next;
}
const identities = await load("access.json", { sessions: {}, grants: {} });
const metrics = { runs: 0 };
const sampleTransport = {
  async sendMessages({ messages }) {
    metrics.runs++;
    const prompt = messages.at(-1)?.parts.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";
    return createUIMessageStream({ execute: async ({ writer }) => {
      const id = randomUUID();
      writer.write({ type: "start", messageId: id });
      writer.write({ type: "text-start", id: "text" });
      for (const delta of [`Echo: `, prompt]) {
        await new Promise((done) => setTimeout(done, 150));
        writer.write({ type: "text-delta", id: "text", delta });
      }
      writer.write({ type: "text-end", id: "text" });
      writer.write({ type: "finish", finishReason: "stop" });
    } });
  },
  async reconnectToStream() { return null; },
};
// Export an existing AI SDK agent from a server module to replace the echo.
const transport = process.env.AGENT_MODULE
  ? new DirectChatTransport({ agent: (await import(pathToFileURL(resolve(process.env.AGENT_MODULE)).href)).default })
  : sampleTransport;
const thread = statewireHost({
  key: ["main"],
  transport: (restored) => AISDKTransport({ threadId: "main", transport, ...(restored && { initialState: restored }) }),
  storage: { load: () => load("thread.json", undefined), save: (snapshot) => save("thread.json", snapshot) },
  persistDebounceMs: 20,
  onError: (error) => console.error("Thread persistence failed", error),
  protocol: HARNESS_HOST_PROTOCOL,
});
function browserSession(request) {
  const token = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith("app_session="))?.slice(12);
  const session = token ? identities.sessions[hash(token)] : undefined;
  return session?.expiresAt > Date.now() ? session : undefined;
}
function authorize({ request }) {
  const auth = request.headers.get("authorization");
  const grant = auth === null ? browserSession(request)
    : auth.startsWith("Bearer ") ? identities.grants[hash(auth.slice(7))] : undefined;
  if (!grant || grant.revoked || grant.expiresAt <= Date.now()) throw new Response("Sign in or renew your terminal grant", { status: 401 });
  if (grant.subject !== "example-owner" || grant.threadId !== "main") throw new Response("Forbidden", { status: 403 });
  return { subject: grant.subject, connectionId: grant.id, expiresAt: grant.expiresAt };
}
const access = createTressAccess({ origin, host: thread, authorize });
// This app owns one conversation. Real apps project their existing, authorized
// thread index into this protocol; never copy conversations into a second store.
const ThreadList = resource(() => {
  const [state] = useStatewireState(() => ({ threads: [{
    id: "main", title: "Existing app conversation", status: "regular",
    updatedAt: new Date().toISOString(),
  }] }));
  return { state, commands: useStatewireCommands({}) };
});
const listHost = statewireHost({ protocol: HARNESS_THREADS_PROTOCOL, transport: ThreadList() });
const listAccess = createTressAccess({ origin, host: listHost, authorize });
const json = (value, init = {}) => Response.json(value, { ...init, headers: { "cache-control": "no-store", ...init.headers } });
async function handle(request) {
  const path = new URL(request.url).pathname;
  if (path === "/.well-known/tress.json" && request.method === "GET") return json({
    version: 1, threads: "/api/thread-list", thread: "/api/threads/{id}",
  });
  if (path.startsWith("/api/thread-list/")) return listAccess.fetch(request);
  if (path.startsWith("/api/threads/main/")) return access.fetch(request);
  if (request.method !== "GET" && request.headers.get("origin") !== origin) return new Response("Origin denied", { status: 403 });
  if (path === "/api/login" && request.method === "POST") {
    const body = await request.text();
    if (body.length > 4096) return new Response("Login too large", { status: 413 });
    let candidate;
    try { candidate = JSON.parse(body).password; } catch { return new Response("Invalid login", { status: 400 }); }
    if (typeof candidate !== "string" || !timingSafeEqual(Buffer.from(hash(candidate)), Buffer.from(hash(password)))) return new Response("Incorrect password", { status: 401 });
    const token = randomBytes(32).toString("base64url");
    identities.sessions[hash(token)] = { id: randomUUID(), subject: "example-owner", threadId: "main", expiresAt: Date.now() + 86_400_000 };
    await save("access.json", identities);
    return json({ ok: true }, { headers: { "set-cookie": `app_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${origin.startsWith("https:") ? "; Secure" : ""}` } });
  }
  const session = browserSession(request);
  if (path === "/api/session" && request.method === "GET") return json(session ? {
    authenticated: true, endpoint: `${origin}/api/threads/main`, application: origin, browserUrl: origin,
    connections: Object.values(identities.grants).filter((grant) => !grant.revoked && grant.expiresAt > Date.now()).map(({ id, expiresAt }) => ({ id, expiresAt })),
  } : { authenticated: false });
  if (!session) return new Response("Sign in", { status: 401 });
  if (path === "/api/connections" && request.method === "POST") {
    const token = randomBytes(32).toString("base64url");
    const grant = { id: randomUUID(), subject: session.subject, threadId: "main", expiresAt: Date.now() + 3_600_000 };
    identities.grants[hash(token)] = grant;
    await save("access.json", identities);
    return json({ id: grant.id, headers: { Authorization: `Bearer ${token}` } });
  }
  if (path.startsWith("/api/connections/") && request.method === "DELETE") {
    const id = path.slice("/api/connections/".length);
    const grant = Object.values(identities.grants).find((value) => value.id === id && value.subject === session.subject);
    if (!grant) return new Response("Grant not found", { status: 404 });
    grant.revoked = true;
    await save("access.json", identities);
    access.revoke(id);
    listAccess.revoke(id);
    return json({ ok: true });
  }
  if (path === "/api/metrics" && request.method === "GET") return json(metrics);
  return new Response("Not found", { status: 404 });
}
const dist = resolve("dist");
async function serveFile(path) {
  const file = path === "/" ? resolve(dist, "index.html") : resolve(dist, `.${decodeURIComponent(path)}`);
  if (!file.startsWith(dist + sep)) return new Response(null, { status: 404 });
  const content = await readFile(file).catch(() => null);
  if (content === null) return new Response(null, { status: 404 });
  return new Response(content, { headers: { "content-type": ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" })[extname(file)] ?? "application/octet-stream" } });
}
const api = (path) => path.startsWith("/api/") || path === "/.well-known/tress.json";
// Pinboard serves the app: HTTP through `fetch`, and Statewire's `…/ws` upgrades
// through `upgrade`. Browsers can't set headers on a socket: the app cookie rides
// on the upgrade, terminal grants arrive in the first frame, and @tress/access
// authorizes both before the host sees a frame.
const app = {
  fetch: (request) => {
    const path = new URL(request.url).pathname;
    return api(path) ? handle(request) : serveFile(path);
  },
  upgrade: (request) => {
    const path = new URL(request.url).pathname;
    const gate = path === "/api/threads/main/ws" ? access : path === "/api/thread-list/ws" ? listAccess : null;
    return gate ? gate.upgrade(request) : new Response(null, { status: 404 });
  },
};
const host = process.env.HOST ?? "127.0.0.1";
// `--dev`: Vite serves the frontend on the app's port and forwards the API, sockets included.
const dev = process.argv.includes("--dev");
const server = await listenFetch(app, { host, port: dev ? 0 : port });
const vite = dev
  ? await (await import("vite")).createServer({ server: { host, port, strictPort: true, proxy: Object.fromEntries(["/api", "/.well-known"].map((prefix) => [prefix, { target: `http://127.0.0.1:${server.port}`, ws: true }])) } })
  : null;
await vite?.listen();
console.log(`App listening at ${origin}`);
async function shutdown() {
  await vite?.close(); await server.close(); await thread.close(); await listHost.close(); await writes; process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
