import type { FarmPlugin } from "@farm.js/core";
import { isIP } from "node:net";
import { join } from "node:path";

const MODULE = "/src/server/thread-socket.ts";
const SOCKET_PATH = /^\/api\/(?:thread|sessions\/[^/]+)\/ws$/;

/**
 * Farm has no WebSocket routes. In production (the Node server and Vercel),
 * Nitro's WebSocket feature resolves each upgrade through the app's own
 * routes: `…/ws/route.ts` builds crossws hooks, and socket-middleware.ts hands
 * them to Nitro. `farm dev` is a Vite
 * server, so its upgrades are wired here to the same hooks, loaded through
 * Vite's SSR module graph to share the routes' thread hosts.
 */
export const statewireSockets = (): FarmPlugin => ({
  name: "tress-statewire-sockets",
  build: {
    configure: (nitro) => ({
      ...nitro,
      features: { ...nitro.features, websocket: true },
      handlers: [
        {
          middleware: true,
          handler: join(nitro.rootDir, "src/server/socket-middleware.ts"),
        },
        ...nitro.handlers,
      ],
    }),
  },
  dev: {
    async server(vite) {
      const { default: nodeAdapter } = await import("crossws/adapters/node");
      const sockets = nodeAdapter({
        resolve: async (request) =>
          (await vite.ssrLoadModule(MODULE)).threadSocketHooks(request),
      });
      const allowed = vite.config.server.allowedHosts;
      // Vite checks Host on HTTP requests only; keep DNS rebinding out here too.
      const hostAllowed = (host = "") => {
        const name = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
        return (
          allowed === true ||
          name === "localhost" ||
          name.endsWith(".localhost") ||
          isIP(name) !== 0 ||
          allowed.some((entry) =>
            entry.startsWith(".")
              ? name === entry.slice(1) || name.endsWith(entry)
              : name === entry,
          )
        );
      };
      vite.httpServer?.on("upgrade", (req, socket, head) => {
        // Other upgrades (Vite's HMR socket) are left to their own listeners.
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        if (!SOCKET_PATH.test(url.pathname)) return;
        if (!hostAllowed(req.headers.host)) {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          return;
        }
        const headers = new Headers();
        for (let index = 0; index < req.rawHeaders.length; index += 2)
          headers.append(req.rawHeaders[index], req.rawHeaders[index + 1]);
        void sockets.handleUpgrade(
          req,
          socket,
          head,
          new Request(url, { headers }),
        );
      });
    },
  },
});
