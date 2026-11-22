// Upgrade a WebSocket through the built Vercel function. Vercel hands the raw
// socket to the function through its request context's `upgradeWebSocket()`;
// this emulates that context, so it checks the bundle's wiring (crossws's
// Vercel adapter, the Nitro middleware, Farm's route), not Vercel itself.
// Usage: node verify-vercel-socket.mjs <function directory>
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const context = new AsyncLocalStorage();
globalThis[Symbol.for("@vercel/request-context")] = {
  get: () => context.getStore(),
};
const { default: app } = await import(
  pathToFileURL(`${process.argv[2]}/index.mjs`).href
);
const server = createServer((_request, response) =>
  response.writeHead(404).end(),
);
server.on("upgrade", (req, socket, head) => {
  const headers = new Headers();
  for (let index = 0; index < req.rawHeaders.length; index += 2)
    headers.append(req.rawHeaders[index], req.rawHeaders[index + 1]);
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    headers,
  });
  context.run({ upgradeWebSocket: () => ({ req, socket, head }) }, () =>
    app.fetch(request),
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const probe = (headers) =>
  new Promise((resolve) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.address().port}/api/thread/ws?client=deployment-probe`,
      { protocols: ["statewire.v1"], headers },
    );
    const timer = setTimeout(() => resolve({ timeout: true }), 10_000);
    socket.onmessage = (event) => {
      clearTimeout(timer);
      resolve({ protocol: socket.protocol, ...JSON.parse(String(event.data)) });
      socket.close();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      resolve({ refused: true });
    };
  });
try {
  const anonymous = await probe({});
  assert.equal(anonymous.protocol, "statewire.v1", JSON.stringify(anonymous));
  assert.equal(anonymous.fin?.reason, "unauthorized", JSON.stringify(anonymous));
  assert.deepEqual(await probe({ origin: "https://attacker.example" }), {
    refused: true,
  });
  console.log(
    "Vercel function upgrades Statewire sockets, answers missing sessions with fin, and refuses cross-site upgrades.",
  );
} finally {
  server.closeAllConnections();
  server.close();
}
process.exit(0);
