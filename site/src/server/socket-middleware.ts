// Nitro middleware (production and Vercel); see socket-plugin.ts.
//
// Nitro resolves an upgrade's crossws hooks from the request it fetched
// through the app. Farm hands its routes a copy of that request and rebuilds
// their responses, so hooks from a `…/ws` route can't travel back through
// Farm. The route parks them under the handshake's Sec-WebSocket-Key, and this
// middleware moves them onto the request Nitro reads.
const HOOKS = Symbol.for("crossws.hooks");
const PARKED = Symbol.for("tress.thread-socket.parked");

type Carrier = Request & { context?: Record<PropertyKey, unknown> };

export default async (
  event: { req: Carrier },
  next: () => Promise<unknown>,
) => {
  const key = event.req.headers.get("sec-websocket-key");
  if (!key || event.req.headers.get("upgrade")?.toLowerCase() !== "websocket")
    return next();
  const response = await next();
  const parked = (globalThis as Record<symbol, Map<string, unknown>>)[PARKED];
  const hooks = parked?.get(key);
  if (hooks) {
    parked!.delete(key);
    Object.assign(event.req, { [HOOKS]: hooks });
    if (event.req.context) event.req.context[HOOKS] = hooks;
  }
  return response;
};
