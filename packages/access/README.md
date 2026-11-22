# @tress/access (source preview)

An **optional** adapter for application-owned authorization and revocation
around a long-lived Statewire thread host. Tress can connect directly to an
already authorized host; this package is not a protocol requirement or an
external login service. Keep your existing session/access implementation when
it covers your needs.

Harness's `statewireHost({ authorize })` gates attachments. This adapter adds
checks on every WebSocket frame and closes expired or revoked connections. See the [access guide](../../site/docs/authentication.mdx)
for native host hooks and browser auth-recovery callbacks.

This private source package is not published on npm. Use Node 24
or a TypeScript-aware application build.

```ts
import { createTressAccess } from "@tress/access";

const access = createTressAccess({
  host: existingThreadHost,
  origin: "https://chat.example.com",
  authorize: async ({ request, action }) => {
    // Application functions: authenticate, check expiry/revocation, then
    // authorize this subject and action for this particular thread.
    const grant = await app.authorizeThread(request, threadId, action);
    if (!grant) throw new Response("Forbidden", { status: 403 });
    return { subject: grant.userId, connectionId: grant.id, expiresAt: grant.expiresAt };
  },
});

// Statewire clients attach over WebSockets at `…/ws`: hand each upgrade to
// the adapter, then let your WebSocket server (e.g. `ws`) accept it.
const accepted = await access.upgrade(request);
if (accepted instanceof Response) return refuse(accepted);
sockets.handleUpgrade(incoming, socket, head, (ws) => accepted.attach(ws));

// Older Tress CLI releases still use /stream and /frames over HTTP.
const response = await access.fetch(request);

// In an authenticated application action that checks grant ownership:
await app.grants.revoke(connectionId);
access.revoke(connectionId);
```

`app`, `threadId`, `request`, and `existingThreadHost` are application-owned.
The package does not supply a login provider, grant store, or discovery API.
`expiresAt` is milliseconds since Unix epoch. Use a distinct, trusted grant ID
for each independently revocable client; never accept a client-supplied ID as
proof of authorization. Throw a 401/403 `Response` to reject a request.

A socket is authorized once, before the host sees any frame: `authorize`
receives a `request` whose headers are the upgrade's headers over the headers
the client sent in its first frame (browsers put tokens there, since they
can't set headers on a WebSocket). Every later frame rechecks the grant's
expiry and revocation. Over HTTP, the adapter authenticates streams and
commands, binds frame requests to the grant that opened their stream, and
rechecks authorization after a bounded POST upload. The default maximum frame
is 1 MiB (`maxFrameBytes` overrides it). Cookie sessions require the canonical
same-origin `Origin`; non-browser header authentication can omit `Origin`.

Revocation and expiration close existing sockets and streams, including quiet
ones, and reject later commands. They do not undo admitted commands or cancel the
agent. Persist revocation before calling `revoke`, reject it in `authorize`
after restart, and broadcast to every owning worker. Streams and commands
must reach the same thread owner and adapter instance.

See the [runnable example](../../examples/existing-app/README.md) and
[authentication guide](../../site/docs/authentication.mdx).

```sh
npm --prefix packages/access test
```
