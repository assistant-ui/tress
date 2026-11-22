import { Harness, HarnessCloud } from "harness-sdk";
import { WS_SUBPROTOCOL } from "./websocket.mjs";

const MAX_QUEUED_FRAMES = 64;

/** Keep the managed credential and SDK's backend tunnel in the machine host. */
export function createManagedHarnessHost(options) {
  const {
    fetch: fetcher = globalThis.fetch,
    webSocket: WebSocketImpl = globalThis.WebSocket,
    authorize,
    ...cloud
  } = options;
  // The SDK validates the origin, ids and credential and maintains the tunnel.
  // A WebSocket lets the cloud thread's Durable Object hibernate between frames.
  const client = new Harness({
    transport: HarnessCloud({ ...cloud, transport: "websocket" }),
  });
  const origin = new URL(cloud.origin);
  const harnessId = origin.hostname.split(".")[0];
  const threadUrl = new URL(`/threads/${harnessId}~${cloud.threadId}`, origin);
  const cloudHeaders = async () => ({
    authorization: `Bearer ${typeof cloud.credential === "function" ? await cloud.credential() : cloud.credential}`,
    "aui-workspace-id": cloud.workspaceId,
    ...(cloud.url && { "aui-backend-url": cloud.url }),
    ...(cloud.userId && { "aui-user-id": cloud.userId }),
  });
  // Relay one interface socket to the cloud thread's socket. The interface's
  // credentials arrive in its first frame and never leave this host; the cloud
  // credential replaces them, and only Statewire negotiation headers pass on.
  const relay = (socket, target, upgradeHeaders) => {
    let upstream;
    let state = "waiting";
    let queued = [];
    let closed = false;
    const close = (code, reason) => {
      if (closed) return;
      closed = true;
      try {
        socket.close(code, reason);
      } catch {}
      try {
        upstream?.close();
      } catch {}
    };
    const refuse = (error) => {
      const status = error instanceof Response ? error.status : 401;
      const reason = status === 403 ? "forbidden" : "unauthorized";
      try {
        socket.send(JSON.stringify({ fin: { reason, message: reason } }));
      } catch {}
      close(1008, reason);
    };
    const open = async (data) => {
      let first;
      try {
        first = JSON.parse(String(data));
      } catch {}
      const { headers: offered, ...lanes } = first ?? {};
      if (
        !offered ||
        typeof offered !== "object" ||
        Object.values(offered).some((value) => typeof value !== "string")
      )
        return close(1008, "malformed headers");
      const headers = Object.fromEntries(new Headers(offered));
      try {
        await authorize?.({ headers: { ...headers, ...upgradeHeaders } });
      } catch (error) {
        return refuse(error);
      }
      if (closed) return;
      const forwarded = {};
      for (const [name, value] of Object.entries(headers))
        if (name.startsWith("statewire-")) forwarded[name] = value;
      const frame = JSON.stringify({
        headers: { ...forwarded, ...(await cloudHeaders()) },
        ...lanes,
      });
      if (closed) return;
      upstream = new WebSocketImpl(target, [WS_SUBPROTOCOL]);
      upstream.onopen = () => {
        if (upstream.protocol !== WS_SUBPROTOCOL)
          return close(1002, "subprotocol");
        upstream.send(frame);
        for (const next of queued) upstream.send(next);
        queued = [];
        state = "open";
      };
      upstream.onmessage = (event) => {
        if (!closed) socket.send(String(event.data));
      };
      upstream.onclose = () => close(1000, "upstream closed");
      upstream.onerror = () => {};
    };
    socket.onmessage = ({ data }) => {
      if (closed) return;
      if (typeof data !== "string") return close(1003, "text frames only");
      if (state === "waiting") {
        state = "connecting";
        open(data).catch(() => close(1011, "relay failed"));
      } else if (state === "open") upstream.send(data);
      else if (queued.length < MAX_QUEUED_FRAMES) queued.push(data);
      else close(1013, "too many pending frames");
    };
    socket.onclose = () => close();
  };
  return {
    client,
    /** Accept `…/ws` upgrades and relay them to the cloud thread. */
    async upgrade(request) {
      const incoming = new URL(request.url);
      if (incoming.pathname.split("/").at(-1) !== "ws")
        return new Response("Not found", { status: 404 });
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((token) => token.trim());
      if (!protocols.includes(WS_SUBPROTOCOL))
        return new Response(`${WS_SUBPROTOCOL} is required`, { status: 400 });
      const target = new URL(`${threadUrl.pathname}/ws`, origin);
      target.protocol = origin.protocol === "http:" ? "ws:" : "wss:";
      target.search = incoming.search;
      const upgradeHeaders = Object.fromEntries(request.headers);
      return {
        protocol: WS_SUBPROTOCOL,
        attach: (socket) => relay(socket, target.href, upgradeHeaders),
      };
    },
    async fetch(request) {
      const incoming = new URL(request.url);
      const route = incoming.pathname.split("/").at(-1);
      if (!["stream", "frames"].includes(route))
        return new Response("Not found", { status: 404 });
      const target = new URL(`${threadUrl.pathname}/${route}`, origin);
      target.search = incoming.search;
      const headers = new Headers();
      for (const name of ["content-type", "accept", "last-event-id"])
        if (request.headers.has(name))
          headers.set(name, request.headers.get(name));
      for (const [name, value] of request.headers)
        if (name.startsWith("statewire-")) headers.set(name, value);
      for (const [name, value] of Object.entries(await cloudHeaders()))
        headers.set(name, value);
      const response = await fetcher(target, {
        method: request.method,
        headers,
        signal: request.signal,
        redirect: "error",
        ...(request.method === "POST" && {
          body: request.body,
          duplex: "half",
        }),
      });
      const outputHeaders = new Headers({ "cache-control": "no-store" });
      for (const name of ["content-type", "retry-after"])
        if (response.headers.has(name))
          outputHeaders.set(name, response.headers.get(name));
      for (const [name, value] of response.headers)
        if (name.startsWith("statewire-")) outputHeaders.set(name, value);
      return new Response(response.body, {
        status: response.status,
        headers: outputHeaders,
      });
    },
    async close() {
      client.dispose();
    },
  };
}
