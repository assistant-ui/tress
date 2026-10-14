# @tress/access (source preview)

Application-owned authorization and revocation around a long-lived Statewire
thread host. This private source package is not published on npm. Use Node 24
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

// Reuse the same adapter for both /stream and /frames requests.
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

The adapter authenticates streams and commands, binds frame requests to the
grant that opened their stream, and rechecks authorization after a bounded
POST upload. The default maximum frame body is 1 MiB (`maxFrameBytes` overrides
it). Cookie-authenticated writes require the canonical same-origin `Origin`;
non-browser header authentication can omit `Origin`.

Revocation and expiration close existing streams, including quiet streams,
and reject later commands. They do not undo admitted commands or cancel the
agent. Persist revocation before calling `revoke`, reject it in `authorize`
after restart, and broadcast to every owning worker. Streams and commands
must reach the same thread owner and adapter instance.

See the [runnable example](../../examples/existing-app/README.md) and
[authentication guide](../../site/docs/authentication.mdx).

```sh
npm --prefix packages/access test
```
