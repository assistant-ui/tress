// Test helpers: serve Statewire WebSocket upgrades from a node:http test
// server, and dial them from Node with the headers a browser would send.
import { STATUS_CODES } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

/** `route(request)` returns a refusal Response or statewire-node's upgrade accept. */
export function serveUpgrades(server, origin, route) {
  const sockets = new WebSocketServer({
    noServer: true,
    handleProtocols: (offered) => offered.has("statewire.v1") && "statewire.v1",
  });
  server.on("upgrade", async (incoming, socket, head) => {
    socket.on("error", () => socket.destroy());
    const request = new Request(new URL(incoming.url, origin()), { headers: incoming.headers });
    const accepted = await route(request).catch(() => new Response(null, { status: 500 }));
    if (accepted instanceof Response)
      return socket.end(`HTTP/1.1 ${accepted.status} ${STATUS_CODES[accepted.status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    sockets.handleUpgrade(incoming, socket, head, (ws) => accepted.attach(ws));
  });
  return () => { for (const ws of sockets.clients) ws.terminate(); sockets.close(); };
}

/** A WebSocket constructor that sends `headers` (e.g. a cookie) on the upgrade. */
export const socketWith = (headers) =>
  class extends WebSocket {
    constructor(url, protocols) { super(url, protocols, { headers }); }
  };
