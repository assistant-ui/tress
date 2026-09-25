import type { ThreadState } from "../lib/thread";

const CLIENT_ID_HEADER = "Statewire-Client-Id";
const LEASE_HEADER = "Statewire-Lease";

type Client = ThreadState["clients"][number];
type Listener = (clients: Client[]) => void;

const browserName = (userAgent: string) => {
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/OPR\//.test(userAgent)) return "Opera";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/Chrome\//.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent)) return "Safari";
  return "Browser";
};

const platformName = (userAgent: string) => {
  if (/iPhone|iPad/.test(userAgent)) return "iOS";
  if (/Android/.test(userAgent)) return "Android";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "macOS";
  if (/Linux/.test(userAgent)) return "Linux";
  return "unknown OS";
};

const describeClient = (id: string, request: Request): Client => {
  const userAgent = request.headers.get("user-agent") ?? "";
  const browser = /Mozilla|Chrome|Chromium|Safari|Firefox|Edg\//.test(userAgent);
  return {
    id,
    kind: browser ? "browser" : userAgent ? "api" : "terminal",
    label: browser
      ? `${browserName(userAgent)} on ${platformName(userAgent)}`
      : userAgent
        ? "API client"
        : "tress terminal",
  };
};

/** Tracks active Statewire streams. A client id is counted once across reconnect overlap. */
export const createPresenceTracker = () => {
  const active = new Map<string, { client: Client; streams: number }>();
  const listeners = new Set<Listener>();
  const snapshot = () =>
    [...active.values()]
      .map(({ client }) => client)
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const publish = () => {
    const clients = snapshot();
    for (const listener of listeners) listener(clients);
  };

  return {
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect(id: string, request: Request) {
      const current = active.get(id);
      active.set(id, {
        client: describeClient(id, request),
        streams: (current?.streams ?? 0) + 1,
      });
      publish();
      let connected = true;
      return () => {
        if (!connected) return;
        connected = false;
        const latest = active.get(id);
        if (!latest) return;
        if (latest.streams > 1) latest.streams -= 1;
        else active.delete(id);
        publish();
      };
    },
  };
};

export type PresenceTracker = ReturnType<typeof createPresenceTracker>;

/** Keeps presence tied to the lifetime of a successful SSE attachment. */
export const trackStreamPresence = (
  request: Request,
  response: Response,
  presence: PresenceTracker,
) => {
  const clientId = request.headers.get(CLIENT_ID_HEADER);
  if (!clientId || !response.body || !response.headers.has(LEASE_HEADER)) {
    return response;
  }

  const disconnect = presence.connect(clientId, request);
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          disconnect();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        disconnect();
        controller.error(error);
      }
    },
    async cancel(reason) {
      disconnect();
      await reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
