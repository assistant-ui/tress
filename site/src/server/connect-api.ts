import { randomBytes } from "node:crypto";
import {
  connectHash,
  connectStore,
  deviceOnline,
  newDeviceId,
  type ConnectStore,
  type DeviceResult,
} from "./connect-store";
import { resolveDemoOwner, resolveDemoSession, SessionError, sessionResponse } from "./demo-session";
import { threadStore, type ThreadStore } from "./thread-store";
import type { WorkspaceDetails } from "@tress/workspaces";

const jsonHeaders = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie, Authorization",
};
function fail(message: string, status: number): never {
  throw new SessionError(message, status);
}
const sameOrigin = (request: Request) => {
  const origin = request.headers.get("origin");
  if (
    (origin && origin !== new URL(request.url).origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    fail("Use this site's connection controls.", 403);
};
const bodyOf = async (request: Request, max = 2048) => {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    fail("Expected JSON.", 415);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max)
    fail("Connection request is too large.", 413);
  if (!request.body) fail("Invalid connection request.", 400);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        fail("Connection request is too large.", 413);
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("Invalid JSON encoding.", 400);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("Invalid JSON.", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Invalid connection request.", 400);
  return value as Record<string, unknown>;
};
const bearer = (request: Request) => {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) fail("Missing device credential.", 401);
  const token = value.slice(7);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail("Invalid device credential.", 401);
  return connectHash(token);
};
const ownerThread = async (request: Request, registry: ThreadStore, id: unknown) => {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
    fail("Thread not found.", 404);
  const owner = await resolveDemoOwner(request, false, registry);
  if (!owner || !(await registry.list(owner.id)).some((thread) => thread.id === id))
    fail("Thread not found.", 404);
  return id;
};
const clean = (value: unknown, limit: number, name: string) => {
  if (typeof value !== "string") fail(`Invalid ${name}.`, 400);
  if (!value.trim() || value.length > limit)
    fail(`Invalid ${name}.`, 400);
  return value.trim();
};
const validResult = (value: unknown): value is DeviceResult => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (typeof result.ok !== "boolean") return false;
  if (result.ok) {
    if (typeof result.value === "string")
      return Buffer.byteLength(result.value, "utf8") <= 1_048_576;
    return (
      Array.isArray(result.value) &&
      result.value.length <= 1000 &&
      result.value.every(
        (item) =>
          item &&
          typeof item.name === "string" &&
          item.name.length <= 255 &&
          ["file", "directory"].includes(item.type),
      )
    );
  }
  return typeof result.error === "string" && result.error.length <= 1000;
};
const deviceDetails = (label: string, writable: boolean): WorkspaceDetails => ({
  environment: "device",
  access: "connected",
  storage: "filesystem",
  shell: "none",
  writable,
  label,
});

/** The public browser owns a thread; the CLI owns only a revocable device token. */
export const connectRequest = async (
  request: Request,
  action: string,
  devices: ConnectStore = connectStore(),
  registry: ThreadStore = threadStore(),
): Promise<Response> => {
  try {
    if (action === "offer" && request.method === "POST") {
      const body = await bodyOf(request);
      const label = clean(body.label, 80, "device label");
      const rootLabel = clean(body.rootLabel, 160, "folder label");
      if (typeof body.writable !== "boolean") fail("Invalid write permission.", 400);
      const budget = await registry.consume(
        [{ key: "connect-offers:host", limit: 500 }],
        Date.now(),
      );
      if (!budget) fail("Connection offers are temporarily full.", 429);
      const code = randomBytes(9).toString("base64url");
      const token = randomBytes(32).toString("base64url");
      await devices.offer({
        id: newDeviceId(),
        codeHash: connectHash(code),
        tokenHash: connectHash(token),
        label,
        rootLabel,
        writable: body.writable,
        expiresAt: Date.now() + 5 * 60_000,
      });
      return Response.json({ code, token, expiresInSeconds: 300 }, { status: 201, headers: jsonHeaders });
    }
    if (action === "claim" && request.method === "POST") {
      sameOrigin(request);
      const body = await bodyOf(request);
      const threadId = await ownerThread(request, registry, body.threadId);
      const code = clean(body.code, 32, "pairing code");
      const device = await devices.claim(connectHash(code), threadId);
      if (!device) fail("That pairing code is invalid or expired.", 404);
      return Response.json({ device: {
        id: device.id,
        label: device.label,
        rootLabel: device.rootLabel,
        writable: device.writable,
        online: deviceOnline(device),
        details: deviceDetails(device.label, device.writable),
      } }, { headers: jsonHeaders });
    }
    if (action === "status" && ["GET", "DELETE"].includes(request.method)) {
      if (request.method === "DELETE") sameOrigin(request);
      const threadId = new URL(request.url).searchParams.get("thread");
      if (!threadId || !/^[a-f0-9-]{36}$/.test(threadId))
        fail("Thread not found.", 404);
      if (request.method === "DELETE") {
        await ownerThread(request, registry, threadId);
        await devices.revoke(threadId);
        return Response.json({ disconnected: true }, { headers: jsonHeaders });
      }
      const owner = await resolveDemoOwner(request, false, registry);
      const manageable = Boolean(owner && (await registry.list(owner.id)).some((thread) => thread.id === threadId));
      if (!manageable) {
        let session;
        try {
          session = await resolveDemoSession(request, false, registry);
        } catch {
          fail("Thread not found.", 404);
        }
        if (session?.thread.id !== threadId) fail("Thread not found.", 404);
      }
      const device = await devices.device(threadId);
      return Response.json({ device: device ? {
        id: device.id,
        label: device.label,
        rootLabel: device.rootLabel,
        writable: device.writable,
        online: deviceOnline(device),
        details: deviceDetails(device.label, device.writable),
      } : null, manageable }, { headers: jsonHeaders });
    }
    if (action === "poll" && request.method === "POST") {
      const hash = bearer(request);
      const status = await devices.heartbeat(hash);
      if (!status) fail("Unknown device credential.", 401);
      if (status.revoked) fail("Connection expired or revoked.", 410);
      return Response.json(
        { paired: status.paired, job: status.paired ? await devices.take(hash) : null },
        { headers: jsonHeaders },
      );
    }
    if (action === "result" && request.method === "POST") {
      const hash = bearer(request);
      // Escaped control characters can expand a valid 1 MB file sixfold.
      const body = await bodyOf(request, 7_000_000);
      if (typeof body.id !== "string" || !/^[a-f0-9-]{36}$/.test(body.id))
        fail("Invalid job ID.", 400);
      if (!validResult(body.result)) fail("Invalid device result.", 400);
      if (!(await devices.complete(hash, body.id, body.result)))
        fail("Job not found or connection revoked.", 404);
      return Response.json({ accepted: true }, { headers: jsonHeaders });
    }
    return Response.json({ error: "Unsupported connection operation." }, { status: 405, headers: jsonHeaders });
  } catch (error) {
    return sessionResponse(error);
  }
};
