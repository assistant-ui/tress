// Serves in-process Statewire socket hosts over real WebSockets for tests.
// (statewire/testing's in-process socket needs statewire 0.29+.)
import { createServer } from "node:http";
import { once } from "node:events";
import nodeAdapter from "crossws/adapters/node";
import {
  clientIdFromUrl,
  textFrameOrClose,
  WS_SUBPROTOCOL,
} from "statewire/host-internal";

const hostRoute = (host) => async (request) => (socket) => {
  const connection = host.connect(clientIdFromUrl(request.url), socket, {
    headers: Object.fromEntries(request.headers),
  });
  if (!connection) return;
  socket.onmessage = ({ data }) => {
    const text = textFrameOrClose(socket, data);
    if (text !== null) connection.message(text);
  };
  socket.onclose = () => connection.close();
};
const refusalRoute = (fin) => async () => (socket) => {
  socket.send(JSON.stringify({ fin }));
  socket.close(1008, fin.reason);
};

/** A Node `upgrade` listener: `accept(request)` returns a refusal Response,
 * `attach(socket)`, or nothing (404). */
export const socketUpgrades = (accept) => {
  const adapter = nodeAdapter({
    resolve: async (request) => {
      const attach = await accept(request);
      if (typeof attach !== "function")
        return { upgrade: () => attach ?? new Response(null, { status: 404 }) };
      let socket;
      return {
        upgrade: () => ({ protocol: WS_SUBPROTOCOL }),
        open(peer) {
          socket = {
            send: (data) => void peer.send(data),
            close: (code, reason) => peer.close(code, reason),
            onmessage: null,
            onclose: null,
          };
          attach(socket);
        },
        message: (_peer, message) => socket?.onmessage?.({ data: message.rawData }),
        close: () => socket?.onclose?.(),
      };
    },
  });
  const listener = (request, socket, head) =>
    adapter.handleUpgrade(request, socket, head);
  listener.closeAll = () => adapter.closeAll(1001, "shutdown", true);
  return listener;
};

/** Serves `host` to every upgrade an existing server receives. */
export const hostUpgrades = (host) => socketUpgrades(hostRoute(host));

export const serveSocketHosts = async () => {
  const routes = new Map();
  let next = 0;
  const upgrades = socketUpgrades((request) =>
    routes.get(new URL(request.url).pathname.split("/")[2])?.(request),
  );
  const server = createServer((_request, response) =>
    response.writeHead(404).end(),
  );
  server.on("upgrade", upgrades);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const add = (route) => {
    const id = String(next++);
    routes.set(id, route);
    return `http://127.0.0.1:${server.address().port}/hosts/${id}`;
  };
  return {
    /** The base URL a `StatewireWebsocket` client dials for this host. */
    url: (host) => add(hostRoute(host)),
    /** A URL whose host answers every attach with this `fin`. */
    refusal: (fin) => add(refusalRoute(fin)),
    /** A URL served by `accept(request)`: a refusal Response or `attach(socket)`. */
    accept: (accept) => add(accept),
    close: async () => {
      upgrades.closeAll();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
};
