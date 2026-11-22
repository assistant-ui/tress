import { STATUS_CODES } from "node:http";
import { WebSocketServer } from "ws";

export const WS_SUBPROTOCOL = "statewire.v1";

/**
 * Serve WebSocket upgrades on a node:http server. `upgrade(request)` returns a
 * refusal `Response`, or `{ protocol, attach(socket) }` as statewire-node's
 * `host.upgrade` does. Credentials arrive in the first frame, so the upgrade
 * itself only passes the server's Host and Origin checks.
 */
export function serveWebSockets(server, { origin, upgrade }) {
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
    handleProtocols: (offered) =>
      offered.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false,
  });
  server.on("upgrade", async (incoming, socket, head) => {
    socket.on("error", () => socket.destroy());
    try {
      const base = typeof origin === "function" ? origin() : origin;
      const request = new Request(new URL(incoming.url, base), {
        headers: incoming.headers,
      });
      const accepted = await upgrade(request);
      if (accepted instanceof Response) return refuse(socket, accepted);
      sockets.handleUpgrade(incoming, socket, head, (ws) => accepted.attach(ws));
    } catch {
      refuse(socket, new Response("Upgrade failed", { status: 500 }));
    }
  });
  return {
    close() {
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
    },
  };
}

async function refuse(socket, response) {
  const body = Buffer.from(await response.text().catch(() => ""));
  const type = response.headers.get("content-type") ?? "text/plain";
  socket.end(
    `HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? ""}\r\n` +
      `Connection: close\r\nContent-Type: ${type}\r\n` +
      `Content-Length: ${body.length}\r\n\r\n${body}`,
  );
}
