// Statewire over WebSocket for every Tress client. The SSE routes stay for
// already-installed `tress` binaries; nothing on this site dials them.

import type { Hooks } from "crossws";
import {
  clientIdFromUrl,
  textFrameOrClose,
  WS_SUBPROTOCOL,
} from "statewire/host-internal";
import type { StatewireHostInternal } from "statewire/host-internal";
import { getThreadBackend } from "./thread-backend";
import { sessionResponse } from "./demo-session";

/** One accepted socket as Statewire's host adapter expects it. */
export type ThreadSocket = StatewireHostInternal.Socket & {
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
};
export type AttachSocket = (socket: ThreadSocket) => void;

const refuse = (status: number, error: string) =>
  Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );

/** Browsers can't send headers on a socket, so the client's in-band frame is
 * all Statewire sees; this mirrors its HTTP refusal mapping onto `fin`. */
const finFor = async (response: Response): Promise<StatewireHostInternal.Fin> => {
  const { status } = response;
  const message = String(
    (await response.json().catch(() => null))?.error ?? `HTTP ${status}`,
  );
  const retry = Number(response.headers.get("retry-after"));
  if (status === 429 || status === 503)
    return {
      reason: "reconnect",
      message,
      code: "overloaded",
      ...(Number.isSafeInteger(retry) && retry > 0 ? { retry: retry * 1000 } : {}),
    };
  return {
    reason:
      status === 401
        ? "unauthorized"
        : status === 403
          ? "forbidden"
          : status < 500
            ? "protocol-error"
            : "error",
    message,
  };
};

const finish = (fin: StatewireHostInternal.Fin): AttachSocket => (socket) => {
  socket.send(JSON.stringify({ fin }));
  socket.close(1008, fin.reason);
};

/** Validates a `…/ws` upgrade request. A refusal `Response` rejects the
 * handshake; session errors are accepted and answered with `fin`, since a
 * browser cannot read a failed handshake's status. */
export const acceptThreadSocket = async (
  request: Request,
): Promise<Response | AttachSocket> => {
  // A WebSocket has no CORS. The upgrade carries the session cookie, so a
  // cross-site page must never be able to open one (native clients send no Origin).
  const origin = request.headers.get("origin");
  if (
    (origin && origin !== new URL(request.url).origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return refuse(403, "Cross-site connections are not allowed.");
  const offered = request.headers.get("sec-websocket-protocol") ?? "";
  if (!offered.split(",").some((value) => value.trim() === WS_SUBPROTOCOL))
    return refuse(400, `${WS_SUBPROTOCOL} is required.`);
  let clientId: string;
  try {
    clientId = clientIdFromUrl(request.url);
  } catch (error) {
    return refuse(400, (error as Error).message);
  }
  try {
    if (process.env.TRESS_SERVERLESS === "1")
      return await (
        await import("./serverless-relay")
      ).serverlessSocket(request, clientId);
    const backend = await getThreadBackend(request);
    // Reattaching either client also retries a stopped upstream connection.
    if ("reconnect" in backend) await backend.reconnect();
    const headers = Object.fromEntries(request.headers);
    return (socket) => {
      const connection = backend.host.connect(clientId, socket, { headers });
      if (!connection) return;
      const disconnect = backend.presence.connect(clientId, request);
      socket.onmessage = ({ data }) => {
        const text = textFrameOrClose(socket, data);
        if (text !== null) connection.message(text);
      };
      socket.onclose = () => {
        disconnect();
        connection.close();
      };
    };
  } catch (error) {
    let response: Response;
    try {
      response = sessionResponse(error);
    } catch {
      // Unexpected failures refuse the handshake; the client retries with backoff.
      console.error("Thread socket:", error);
      return refuse(500, "The thread host is unavailable.");
    }
    return finish(await finFor(response));
  }
};

/** crossws hooks for one upgrade; Nitro (production and Vercel) and the dev
 * server both resolve a connection's hooks through this. */
export const threadSocketHooks = async (
  request: Request,
): Promise<Partial<Hooks>> => {
  const accepted = await acceptThreadSocket(request);
  if (accepted instanceof Response) return { upgrade: () => accepted };
  let socket: ThreadSocket | undefined;
  return {
    upgrade: () => ({ protocol: WS_SUBPROTOCOL }),
    open(peer) {
      socket = {
        send: (data) => void peer.send(data),
        close: (code, reason) => peer.close(code, reason),
        onmessage: null,
        onclose: null,
      };
      accepted(socket);
    },
    message(_peer, message) {
      socket?.onmessage?.({ data: message.rawData });
    },
    close() {
      const closed = socket;
      socket = undefined;
      closed?.onclose?.();
    },
  };
};

const PARKED = Symbol.for("tress.thread-socket.parked");
const parked = ((globalThis as Record<symbol, unknown>)[PARKED] ??=
  new Map()) as Map<string, Partial<Hooks>>;

/** The route form, for Nitro: socket-middleware.ts hands these hooks to crossws. */
export const threadSocketRoute = async (request: Request) => {
  const key = request.headers.get("sec-websocket-key");
  if (!key || request.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return refuse(426, "WebSocket upgrade is required.");
  parked.set(key, await threadSocketHooks(request));
  // The middleware takes them within this request; never keep stray entries.
  setTimeout(() => parked.delete(key), 30_000).unref();
  return refuse(426, "WebSocket upgrade is required.");
};
