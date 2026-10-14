/** The application resolves both browser sessions and terminal grants. */
export type AccessGrant = {
  subject: string;
  /** A server-owned grant/session ID, distinct for each revocable connection. */
  connectionId: string;
  /** Unix time in milliseconds. Expiration closes existing streams as well. */
  expiresAt: number;
};

export type AccessOptions = {
  /** Reuse the application's thread host. Its lifetime remains app-owned. */
  host: { fetch(request: Request): Promise<Response> };
  /** Canonical app origin; do not derive this from an untrusted Host header. */
  origin: string;
  /** Authenticate and authorize THIS thread. Throw a 401/403 Response to deny. */
  authorize(context: {
    request: Request;
    action: "read" | "write";
  }): AccessGrant | Promise<AccessGrant>;
  maxFrameBytes?: number;
};

type Attachment = { grant: AccessGrant; stop(): void };
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
  const authorize = async (request: Request) => {
    const grant = await options.authorize({
      request,
      action: request.method === "GET" ? "read" : "write",
    });
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

  return {
    fetch,
    /** Revoke this grant on this worker; app storage must deny it after restart. */
    revoke(connectionId: string) {
      revoked.add(connectionId);
      for (const attachment of [...attachments])
        if (attachment.grant.connectionId === connectionId) attachment.stop();
    },
  };
}
