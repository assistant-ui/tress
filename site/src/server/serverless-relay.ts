import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { waitUntil } from "@vercel/functions";
import { textFrameOrClose } from "statewire/host-internal";
import type { StatewireHostInternal } from "statewire/host-internal";
import {
  accessHash,
  resolveDemoSession,
  type DemoSession,
} from "./demo-session";
import { threadMode } from "./config";
import { createManagedGateway } from "./managed";
import { describeClient } from "./presence";
import { relayStore, type RelayStore } from "./relay-store";
import type { AttachSocket, ThreadSocket } from "./thread-socket";

const LEASE = "Statewire-Lease";
const stale = () => Response.json({ error: "stale-lease" }, { status: 423 });
type Gateway = Awaited<ReturnType<typeof createManagedGateway>>;
type OpenGateway = (
  persistence: StatewireHostInternal.SocketHostPersistence,
) => Promise<Gateway>;

/** Legacy SSE attach (released `tress` binaries). Exported separately so two
 * independent workers can be exercised in integration tests. */
export async function relayStream(
  request: Request,
  session: DemoSession,
  store: RelayStore,
  open: OpenGateway,
  lifetimeMs = 210_000,
) {
  const clientId = request.headers.get("Statewire-Client-Id");
  if (!clientId || !/^[A-Za-z0-9._~-]{1,256}$/.test(clientId))
    return Response.json(
      { error: "Invalid Statewire-Client-Id." },
      { status: 400 },
    );
  const token = randomBytes(24).toString("base64url");
  const lease = accessHash(token);
  const scope = session.thread.id;
  const record = await store.connect(
    scope,
    describeClient(clientId, request),
    lease,
  );
  let saves = Promise.resolve();
  let gateway: Gateway | undefined;
  let closed = false;
  let cleanup: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelled = new AbortController();
  const stop = () => {
    if (cleanup) return cleanup;
    closed = true;
    clearTimeout(timer);
    cancelled.abort();
    request.signal.removeEventListener("abort", stop);
    gateway?.host.finish({ reason: "reconnect" });
    cleanup = (async () => {
      try {
        await store.release(lease);
        // A disconnected observer must not interrupt a submitted cloud run.
        await gateway?.drain();
        await saves;
      } finally {
        gateway?.dispose();
      }
    })().catch((error) => {
      if (error.message !== "Connection superseded.")
        console.error("Relay cleanup:", error.message);
    });
    if (process.env.VERCEL) waitUntil(cleanup);
    return cleanup;
  };
  try {
    gateway = await open({
      clientRecords: record ? [record] : [],
      onClientRecordsChange(records) {
        const current = records.find((entry) => entry.id === clientId);
        if (!current) return;
        const snapshot = structuredClone(current);
        saves = saves.then(() => store.save(scope, clientId, lease, snapshot));
        void saves.catch(() => stop());
      },
    });
    const upstream = await gateway.host.stream(request);
    const internalLease = upstream.headers.get(LEASE);
    if (!upstream.body || !internalLease) {
      await stop();
      return upstream;
    }
    const reader = upstream.body.getReader();
    request.signal.addEventListener("abort", stop, { once: true });
    timer = setTimeout(stop, lifetimeMs);
    // The SSE invocation owns this lease. Another Vercel instance may accept
    // POST /frames, but only this invocation admits it into Statewire.
    const poll = async () => {
      let heartbeatAt = 0;
      while (!closed) {
        if (Date.now() >= heartbeatAt) {
          const presence = await store.heartbeat(scope, lease);
          if (
            !presence ||
            presence.harness_thread_id !== gateway!.info().threadId
          ) {
            void stop();
            return;
          }
          gateway!.presence.setRemote(presence.clients);
          if (presence.files) gateway!.setFiles(presence.files);
          heartbeatAt = Date.now() + 3000;
        }
        for (const frame of await store.pending(lease)) {
          if (closed) return;
          const response = await gateway!.host.frames(
            new Request(request.url, {
              method: "POST",
              headers: {
                [LEASE]: internalLease,
                "Content-Type": "application/json",
              },
              body: frame.body,
            }),
          );
          // Persist admission watermarks before acknowledging a command.
          await saves;
          await store.complete(
            frame.id,
            response.status,
            await response.text(),
          );
        }
        await delay(400, undefined, { signal: cancelled.signal });
      }
    };
    void poll().catch((error) => {
      if (!closed) console.error("Relay connection:", error.message);
      void stop();
    });
    const headers = new Headers(upstream.headers);
    headers.set(LEASE, token);
    headers.set("Cache-Control", "private, no-store");
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            await saves;
            if (next.done) {
              controller.close();
              void stop();
            } else controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
            void stop();
          }
        },
        async cancel(reason) {
          void stop();
          await reader.cancel(reason).catch(() => {});
        },
      }),
      { status: upstream.status, headers },
    );
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * One WebSocket client on this invocation. Commands ride on the socket, so no
 * frame routing is needed; Postgres still carries presence, files and the
 * client's reconnect journal across instances. A `fin: reconnect` hands the
 * client to a fresh invocation before the platform's 300 s limit.
 */
export async function relaySocket(
  request: Request,
  clientId: string,
  session: DemoSession,
  store: RelayStore,
  open: OpenGateway,
  lifetimeMs = 210_000,
): Promise<AttachSocket> {
  const lease = accessHash(randomBytes(24).toString("base64url"));
  const scope = session.thread.id;
  const client = describeClient(clientId, request);
  const headers = Object.fromEntries(request.headers);
  return (socket) => {
    let saves = Promise.resolve();
    let outgoing = Promise.resolve();
    let gateway: Gateway | undefined;
    let connection: StatewireHostInternal.SocketConnection | null = null;
    let closed = false;
    let cleanup: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new AbortController();
    const early: { data: unknown }[] = [];
    // Persist admission watermarks before a packet can acknowledge a command.
    const ordered: ThreadSocket = {
      send(data) {
        const persisted = saves;
        outgoing = outgoing
          .then(() => persisted)
          .then(() => socket.send(data))
          .catch(() => {});
      },
      close(code, reason) {
        outgoing = outgoing.then(() => socket.close(code, reason));
      },
      onmessage: null,
      onclose: null,
    };
    const ready = (async () => {
      const record = await store.connect(scope, client, lease);
      if (closed) return undefined;
      return open({
        clientRecords: record ? [record] : [],
        onClientRecordsChange(records) {
          const current = records.find((entry) => entry.id === clientId);
          if (!current) return;
          const snapshot = structuredClone(current);
          saves = saves.then(() => store.save(scope, clientId, lease, snapshot));
          void saves.catch(() => stop());
        },
      });
    })();
    const stop = () => {
      if (cleanup) return cleanup;
      closed = true;
      clearTimeout(timer);
      cancelled.abort();
      if (connection) gateway?.host.finish({ reason: "reconnect" });
      else ordered.close(1012, "reconnect");
      cleanup = (async () => {
        const opened = await ready.catch(() => undefined);
        try {
          await store.release(lease);
          // A disconnected observer must not interrupt a submitted cloud run.
          await opened?.drain();
          await saves;
        } finally {
          opened?.dispose();
        }
      })().catch((error) => {
        if (error.message !== "Connection superseded.")
          console.error("Relay cleanup:", error.message);
      });
      if (process.env.VERCEL) waitUntil(cleanup);
      return cleanup;
    };
    const deliver = ({ data }: { data: unknown }) => {
      const text = textFrameOrClose(ordered, data);
      if (text !== null) connection?.message(text);
    };
    socket.onmessage = (event) => {
      if (connection) deliver(event);
      else if (!closed) early.push(event);
    };
    socket.onclose = () => {
      connection?.close();
      void stop();
    };
    const heartbeat = async () => {
      while (!closed) {
        const presence = await store.heartbeat(scope, lease);
        if (
          !presence ||
          presence.harness_thread_id !== gateway!.info().threadId
        )
          return void stop();
        gateway!.presence.setRemote(presence.clients);
        if (presence.files) gateway!.setFiles(presence.files);
        await delay(3000, undefined, { signal: cancelled.signal });
      }
    };
    ready.then(
      (opened) => {
        if (!opened || closed) return;
        gateway = opened;
        connection = opened.host.connect(clientId, ordered, { headers });
        if (!connection) return void stop();
        for (const event of early.splice(0)) deliver(event);
        timer = setTimeout(stop, lifetimeMs);
        void heartbeat().catch((error) => {
          if (!closed) console.error("Relay connection:", error.message);
          void stop();
        });
      },
      (error) => {
        console.error("Relay connection:", error.message);
        ordered.send(
          JSON.stringify({
            fin: { reason: "error", message: "The thread host is unavailable." },
          }),
        );
        void stop();
      },
    );
  };
}

export async function relayFrames(
  request: Request,
  session: DemoSession,
  store: RelayStore,
) {
  const token = request.headers.get(LEASE);
  if (!token || !/^[A-Za-z0-9_-]{32}$/.test(token)) return stale();
  if (Number(request.headers.get("Content-Length")) > 1_048_576)
    return new Response(null, { status: 413 });
  const body = await request.text();
  if (Buffer.byteLength(body) > 1_048_576)
    return new Response(null, { status: 413 });
  const id = randomUUID();
  if (!(await store.enqueue(session.thread.id, accessHash(token), id, body)))
    return stale();
  const until = Date.now() + 20_000;
  while (Date.now() < until && !request.signal.aborted) {
    const result = await store.result(id);
    if (!result) return stale();
    if (result.status !== null) {
      await store.forget(id);
      return new Response(result.response, {
        status: result.status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }
    await delay(100);
  }
  // Expiring the lease forces a clean reconnect and journal-based replay.
  await store.release(accessHash(token));
  return stale();
}

const serverlessSession = async (request: Request) => {
  const session = await resolveDemoSession(request);
  const mode = threadMode(request.url);
  if (!session || mode.kind !== "cloud")
    throw new Error(
      "Serverless mode requires isolated sessions and managed Harness.",
    );
  const backendUrl = new URL(mode.backendUrl);
  backendUrl.searchParams.set("session", session.token);
  const open: OpenGateway = (persistence) =>
    createManagedGateway(
      { ...mode, backendUrl: backendUrl.href },
      undefined,
      {
        scope: session.thread.id,
        threadId: session.thread.harnessThreadId,
        selectThread: (id) => relayStore().selectThread(session.thread.id, id),
      },
      persistence,
    );
  return { session, open };
};

/** Legacy SSE clients (released `tress` binaries); browsers use WebSockets. */
export const serverlessStream = async (request: Request) => {
  const { session, open } = await serverlessSession(request);
  return relayStream(request, session, relayStore(), open);
};

export const serverlessSocket = async (request: Request, clientId: string) => {
  const { session, open } = await serverlessSession(request);
  return relaySocket(request, clientId, session, relayStore(), open);
};

export const serverlessFrames = async (request: Request) => {
  const session = await resolveDemoSession(request);
  if (!session) return stale();
  return relayFrames(request, session, relayStore());
};
