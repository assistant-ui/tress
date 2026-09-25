import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { waitUntil } from "@vercel/functions";
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

const LEASE = "Statewire-Lease";
const stale = () => Response.json({ error: "stale-lease" }, { status: 423 });
type Gateway = Awaited<ReturnType<typeof createManagedGateway>>;
type OpenGateway = (
  persistence: StatewireHostInternal.SocketHostPersistence,
) => Promise<Gateway>;

/** Exported separately so two independent workers can be exercised in integration tests. */
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

export const serverlessStream = async (request: Request) => {
  const session = await resolveDemoSession(request);
  const mode = threadMode(request.url);
  if (!session || mode.kind !== "cloud")
    throw new Error(
      "Serverless mode requires isolated sessions and managed Harness.",
    );
  const backendUrl = new URL(mode.backendUrl);
  backendUrl.searchParams.set("session", session.token);
  return relayStream(request, session, relayStore(), (persistence) =>
    createManagedGateway(
      { ...mode, backendUrl: backendUrl.href },
      undefined,
      {
        scope: session.thread.id,
        threadId: session.thread.harnessThreadId,
        selectThread: (id) => relayStore().selectThread(session.thread.id, id),
      },
      persistence,
    ),
  );
};

export const serverlessFrames = async (request: Request) => {
  const session = await resolveDemoSession(request);
  if (!session) return stale();
  return relayFrames(request, session, relayStore());
};
