import { createServer } from "node:http";
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { createUIMessageStream, DirectChatTransport } from "ai";
import { AISDKTransport } from "@harness-sdk/ai-sdk";
import { statewireHost } from "statewire-node";
import { HARNESS_HOST_PROTOCOL } from "harness-sdk/host";
import { createTressAccess } from "@tress/access";

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
const access = createTressAccess({
  origin, host: thread,
  authorize({ request }) {
    const auth = request.headers.get("authorization");
    const grant = auth === null ? browserSession(request)
      : auth.startsWith("Bearer ") ? identities.grants[hash(auth.slice(7))] : undefined;
    if (!grant || grant.revoked || grant.expiresAt <= Date.now()) throw new Response("Sign in or renew your terminal grant", { status: 401 });
    if (grant.subject !== "example-owner" || grant.threadId !== "main") throw new Response("Forbidden", { status: 403 });
    return { subject: grant.subject, connectionId: grant.id, expiresAt: grant.expiresAt };
  },
});
const json = (value, init = {}) => Response.json(value, { ...init, headers: { "cache-control": "no-store", ...init.headers } });
async function handle(request) {
  const path = new URL(request.url).pathname;
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
    authenticated: true, endpoint: `${origin}/api/threads/main`, browserUrl: origin,
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
    return json({ ok: true });
  }
  if (path === "/api/metrics" && request.method === "GET") return json(metrics);
  return new Response("Not found", { status: 404 });
}
const dev = process.argv.includes("--dev")
  ? await (await import("vite")).createServer({ server: { middlewareMode: true }, appType: "spa" })
  : null;
const dist = resolve("dist");
const server = createServer(async (incoming, outgoing) => {
  try {
    const path = new URL(incoming.url, origin).pathname;
    if (!path.startsWith("/api/")) {
      if (dev) { dev.middlewares(incoming, outgoing); return; }
      const file = path === "/" ? resolve(dist, "index.html") : resolve(dist, `.${decodeURIComponent(path)}`);
      if (!file.startsWith(dist + sep)) { outgoing.writeHead(404).end(); return; }
      const content = await readFile(file).catch(() => null);
      if (content === null) { outgoing.writeHead(404).end(); return; }
      outgoing.setHeader("content-type", ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" })[extname(file)] ?? "application/octet-stream");
      outgoing.end(content); return;
    }
    const abort = new AbortController();
    incoming.on("aborted", () => abort.abort());
    outgoing.on("close", () => abort.abort());
    const request = new Request(new URL(incoming.url, origin), {
      method: incoming.method, headers: incoming.headers, signal: abort.signal,
      ...(!["GET", "HEAD"].includes(incoming.method) && { body: Readable.toWeb(incoming), duplex: "half" }),
    });
    const response = await handle(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).on("error", () => outgoing.destroy()).pipe(outgoing);
    else outgoing.end();
  } catch (error) {
    console.error("Request failed", error);
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end("Request failed");
  }
});
server.listen(port, process.env.HOST ?? "127.0.0.1", () => console.log(`App listening at ${origin}`));
async function shutdown() {
  server.close(); await thread.close(); await writes; await dev?.close(); process.exit(0);
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
