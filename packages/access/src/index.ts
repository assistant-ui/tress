/** The application resolves both browser sessions and terminal grants. */
export type AccessGrant = {
  subject: string;
  /** A server-owned grant/session ID, distinct for each revocable connection. */
  connectionId: string;
  /** Unix time in milliseconds. Expiration closes existing streams as well. */
  expiresAt: number;
};

/** One accepted WebSocket, as `ws` and statewire-node expose it. */
export type AccessSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
};
/** statewire-node's `host.upgrade` result: a refusal, or the accept. Also a
 * Pinboard `Accept`: `maxPayload` caps every message before it is buffered. */
export type AccessUpgrade = {
  protocol: string;
  maxPayload?: number;
  attach(socket: AccessSocket): void;
};

export type AccessOptions = {
  /** Reuse the application's thread host. Its lifetime remains app-owned. */
  host: {
    fetch(request: Request): Promise<Response>;
    upgrade?(request: Request): Promise<Response | AccessUpgrade>;
  };
  /** Canonical app origin; do not derive this from an untrusted Host header. */
  origin: string;
  /**
   * Authenticate and authorize THIS thread. Throw a 401/403 Response to deny.
   * For a WebSocket, `request` carries the upgrade's headers over the headers
   * the client sent in its first frame (where browsers put credentials).
   */
  authorize(context: {
    request: Request;
    action: "read" | "write";
  }): AccessGrant | Promise<AccessGrant>;
  maxFrameBytes?: number;
};

type Attachment = { grant: AccessGrant; stop(): void };
const fin = (reason: "unauthorized" | "forbidden", message: string) =>
  JSON.stringify({ fin: { reason, message } });
const MAX_QUEUED_FRAMES = 64;
const AUTHORIZE_TIMEOUT_MS = 10_000;
const denied = () => new Response("Connection is not authorized", { status: 403 });
const encoder = new TextEncoder();
const revokedFrame = encoder.encode(
  'data: {"fin":{"reason":"forbidden","message":"Application access ended"}}\n\n',
);

/**
 * One adapter per thread host, shared by its browser and terminal routes.
 * Persist revocations in the app first, then call revoke on every owning worker.
 * Commands already admitted to the host are not undone by disconnecting a client.
 */
export function createTressAccess(options: AccessOptions) {
  const origin = new URL(options.origin).origin;
  const revoked = new Set<string>();
  const attachments = new Set<Attachment>();
  const leases = new Map<string, Attachment>();
  const maxFrameBytes = options.maxFrameBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1)
    throw new Error("maxFrameBytes must be a positive integer");

  const valid = (grant: AccessGrant) =>
    typeof grant.subject === "string" && grant.subject.length > 0 &&
    typeof grant.connectionId === "string" && grant.connectionId.length > 0 &&
    Number.isFinite(grant.expiresAt) && grant.expiresAt > Date.now() &&
    !revoked.has(grant.connectionId);
  const same = (a: AccessGrant, b: AccessGrant) =>
    a.subject === b.subject && a.connectionId === b.connectionId;
  const authorize = async (
    request: Request,
    action: "read" | "write" = request.method === "GET" ? "read" : "write",
  ) => {
    const grant = await options.authorize({ request, action });
    if (!valid(grant)) throw denied();
    return grant;
  };

  const readFrame = async (request: Request): Promise<Uint8Array | undefined> => {
    if (request.body === null) return undefined;
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxFrameBytes) {
          await reader.cancel();
          throw new Response("Frame too large", { status: 413 });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
    return body;
  };

  const fetch = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const stream = path.endsWith("/stream");
    const frames = path.endsWith("/frames");
    if (!stream && !frames) return new Response(null, { status: 404 });
    if (!(stream && request.method === "GET") && request.method !== "POST")
      return new Response(null, { status: 405, headers: { Allow: stream ? "GET, POST" : "POST" } });
    // Cookie-authenticated writes must come from the app. Non-browser clients
    // can omit Origin; the application still authenticates every request.
    const requestOrigin = request.headers.get("origin");
    if (requestOrigin !== null && requestOrigin !== origin) return denied();
    if (requestOrigin === null && request.headers.has("cookie") && request.method !== "GET")
      return denied();
    try {
      const grant = await authorize(request);
      let forwarded = request;
      if (request.method === "POST") {
        // Complete the bounded body before the final auth check. Revocation
        // during a slow upload cannot slip a command through later.
        const body = await readFrame(request);
        const fresh = await authorize(request);
        if (!same(grant, fresh) || !valid(grant)) return denied();
        forwarded = new Request(request.url, {
          method: request.method, headers: request.headers,
          body: body === undefined ? undefined : new Uint8Array(body).buffer,
          signal: request.signal,
        });
      }
      if (frames) {
        const lease = request.headers.get("statewire-lease");
        const attachment = lease === null ? undefined : leases.get(lease);
        if (!attachment || !valid(attachment.grant) || !same(grant, attachment.grant))
          return denied();
        return await options.host.fetch(forwarded);
      }
      const response = await options.host.fetch(forwarded);
      if (!response.ok || response.body === null) return response;
      if (!valid(grant) || request.signal.aborted) {
        await response.body.cancel().catch(() => {});
        return denied();
      }
      const reader = response.body.getReader();
      const lease = response.headers.get("statewire-lease");
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const cleanup = () => {
        if (closed) return false;
        closed = true;
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        attachments.delete(attachment);
        if (lease !== null && leases.get(lease) === attachment) leases.delete(lease);
        return true;
      };
      const stop = (notify: boolean) => {
        if (!cleanup()) return;
        if (notify) controller.enqueue(revokedFrame);
        controller.close();
        void reader.cancel().catch(() => {});
      };
      const abort = () => stop(false);
      const attachment: Attachment = { grant, stop: () => stop(true) };
      const expire = () => {
        if (!valid(grant)) { stop(true); return; }
        timer = setTimeout(expire, Math.min(grant.expiresAt - Date.now(), 2 ** 31 - 1));
        timer.unref?.();
      };
      const body = new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
        async pull() {
          try {
            const next = await reader.read();
            if (closed) return;
            if (!valid(grant)) { stop(true); return; }
            if (next.done) { if (cleanup()) controller.close(); }
            else controller.enqueue(next.value);
          } catch (error) {
            if (cleanup()) controller.error(error);
          }
        },
        async cancel(reason) { if (cleanup()) await reader.cancel(reason); },
      });
      attachments.add(attachment);
      if (lease !== null) leases.set(lease, attachment);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      else expire();
      return new Response(body, { status: response.status, headers: response.headers });
    } catch (error) {
      if (error instanceof Response && [401, 403, 413].includes(error.status)) return error;
      throw error;
    }
  };

  // A socket is one attachment: its first frame authorizes it, and every later
  // frame (each one a command) rechecks the grant's expiry and revocation.
  const upgrade = async (request: Request): Promise<Response | AccessUpgrade> => {
    if (!options.host.upgrade)
      return new Response("WebSocket upgrades are not served", { status: 426 });
    // Browsers send Origin and cookies on every upgrade; only the app may use them.
    const requestOrigin = request.headers.get("origin");
    if (requestOrigin !== null && requestOrigin !== origin) return denied();
    if (requestOrigin === null && request.headers.has("cookie")) return denied();
    const accepted = await options.host.upgrade(request);
    if (accepted instanceof Response) return accepted;
    return {
      protocol: accepted.protocol,
      maxPayload: maxFrameBytes,
      attach(socket) {
        const inner: AccessSocket = {
          send: (data) => socket.send(data),
          close: (code, reason) => socket.close(code, reason),
          onmessage: null,
          onclose: null,
        };
        accepted.attach(inner);
        let state: "waiting" | "authorizing" | "open" | "closed" = "waiting";
        let queued: unknown[] = [];
        let timer: ReturnType<typeof setTimeout> | undefined;
        let attachment: Attachment | undefined;
        const end = (code: number, frame?: string) => {
          if (state === "closed") return;
          state = "closed";
          queued = [];
          clearTimeout(timer);
          if (attachment) attachments.delete(attachment);
          try {
            if (frame !== undefined) socket.send(frame);
            socket.close(code, "access");
          } catch {}
          inner.onclose?.();
        };
        const admit = async (data: unknown) => {
          let headers: Headers;
          try {
            const first = JSON.parse(String(data)) as { headers?: HeadersInit };
            headers = new Headers(first.headers);
            request.headers.forEach((value, name) => headers.set(name, value));
          } catch {
            return end(1008);
          }
          let grant: AccessGrant;
          try {
            grant = await authorize(new Request(request.url, { headers }), "write");
          } catch (error) {
            const forbidden = error instanceof Response && error.status === 403;
            return end(1008, forbidden
              ? fin("forbidden", "Connection is not authorized")
              : fin("unauthorized", "unauthorized"));
          }
          if (state === "closed") return;
          clearTimeout(timer);
          attachment = { grant, stop: () => end(1008, fin("forbidden", "Application access ended")) };
          attachments.add(attachment);
          const expire = () => {
            if (!valid(grant)) return attachment!.stop();
            timer = setTimeout(expire, Math.min(grant.expiresAt - Date.now(), 2 ** 31 - 1));
            (timer as { unref?: () => void }).unref?.();
          };
          expire();
          if (state === "closed") return;
          state = "open";
          for (const frame of [data, ...queued]) inner.onmessage?.({ data: frame });
          queued = [];
        };
        socket.onmessage = ({ data }) => {
          if (state === "closed") return;
          if (typeof data === "string" && encoder.encode(data).byteLength > maxFrameBytes)
            return end(1009);
          if (state === "waiting") {
            state = "authorizing";
            // An application authorize that never settles must not hold the socket.
            timer = setTimeout(() => end(1008, fin("unauthorized", "Authorization timed out")), AUTHORIZE_TIMEOUT_MS);
            (timer as { unref?: () => void }).unref?.();
            void admit(data);
          } else if (state === "authorizing") {
            if (queued.length >= MAX_QUEUED_FRAMES) return end(1013);
            queued.push(data);
          }
          else if (!valid(attachment!.grant)) attachment!.stop();
          else inner.onmessage?.({ data });
        };
        socket.onclose = () => end(1000);
      },
    };
  };

  return {
    fetch,
    /** Accept a WebSocket for the host; pass the result to your WebSocket server. */
    upgrade,
    /** Revoke this grant on this worker; app storage must deny it after restart. */
    revoke(connectionId: string) {
      revoked.add(connectionId);
      for (const attachment of [...attachments])
        if (attachment.grant.connectionId === connectionId) attachment.stop();
    },
  };
}
