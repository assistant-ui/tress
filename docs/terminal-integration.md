# Add Tress terminal access to an existing assistant-ui app

The application keeps its browser UI, agent, tools, identity, and hosting.
The user installs the **native Tress CLI** and joins the same conversation.
There is no Tress React component, browser SDK, or stylesheet to install.

```text
Existing assistant-ui browser ──┐
                               ├── App-authorized Harness thread ── Existing agent/tools
Native Tress terminal ──────────┘
```

Harness owns conversation persistence. Files and execution stay on the
application's configured machine, VM, or backend. Attaching from a terminal
does not move execution or files to that terminal's machine.

This is a source preview; build Tress from this checkout. Published v0.3.0 does
not include generic Harness attachment. Supported versions are listed in the
[protocol reference](../site/docs/reference.mdx).

## Already using server-owned Harness threads

Expose the existing authorized thread list and thread endpoints, then publish
one small discovery document. No Tress server or browser package is required.

The user connects to the **application origin**:

```sh
# An app that accepts an API key / bearer token:
tress attach https://chat.example.com --api-key-env MY_APP_API_KEY

# An app that explicitly permits anonymous access:
tress attach https://chat.example.com
```

`MY_APP_API_KEY` is the name of an environment variable containing the user's
app-issued credential. Tress sends it as `Authorization: Bearer …`. It is not a
model-provider key or a project-wide Harness service key. The application
chooses whether to accept API keys, anonymous access, or custom authentication.

Connecting automatically lists **every thread that credential may access**,
including archived threads and threads never visited in this terminal. Choose
a number to load its history and continue it. Add `--ui` for the full terminal
interface. `/threads` or Ctrl-T refreshes the list; plain terminals can switch
with `/thread ID`. The list comes from the app, not the terminal's recents file.

### The discovery contract

Serve `GET /.well-known/tress.json` as `application/json`:

```json
{
  "version": 1,
  "threads": "/api/thread-list",
  "thread": "/api/threads/{id}"
}
```

- `threads` identifies the app's existing Harness thread-list endpoint using
  `harness-sdk-threads` protocol `2026-09-13`. Its main document contains
  `threads: [{ id, title, status, updatedAt }]`. Status is `regular` or
  `archived`; `updatedAt` is an ISO timestamp. Return the complete authorized
  index, aggregating your storage's pagination on the backend if necessary.
- `thread` maps each listed ID to its existing Harness thread endpoint using
  protocol `harness-sdk` version `2026-09-13`. IDs must use letters, digits,
  `.`, `_`, `~`, or `-`, excluding `.` and `..` alone.
- Both endpoints remain on the same application origin, without query strings,
  fragments, or credentials in URLs. Each serves Statewire `/stream` and
  `/frames` requests. The manifest contains no secrets or conversation data.
- Authenticate the list request, derive the user from the credential, and
  filter the index before returning it. Independently authorize every thread
  connection and command. A listed ID does not grant access by itself.

Reuse your existing Harness thread-list transport. If you currently have only
a database index, project its authorized entries into that transport; do not
create a second conversation store. The [example server](../examples/existing-app/server.mjs)
shows a one-thread list, and its [integration test](../examples/existing-app/catalog.test.mjs)
checks multiple users and more than 20 threads. The current CLI takes a fresh
snapshot on connection and when the picker opens; it does not keep a live list
subscription open between those actions.

For managed Harness, expose the list and selected threads through your app's
existing authorized backend/proxy. Keep managed service credentials there.
The browser and terminal must resolve to the same underlying thread IDs.

### Custom auth and direct thread access

For an app using custom headers, its credential flow can supply a private JSON
object of header names and values:

```sh
chmod 600 app-headers.json
tress attach https://chat.example.com --headers-file app-headers.json
```

For example, `{ "X-App-Token": "APP_ISSUED_TOKEN" }`. The optional
[access adapter](../packages/access/README.md) adds per-request checks, expiry,
and live revocation when your app does not already provide them.

Existing complete thread endpoints still work, including one-shot prompts:

```sh
tress attach https://chat.example.com/api/threads/THREAD_ID \
  --headers-file app-headers.json
tress ask --host https://chat.example.com/api/threads/THREAD_ID \
  --headers-file app-headers.json "Continue this task"
```

Those direct connections address only the chosen thread. For scripting the
application list, use `tress threads <app-origin> --json`, or
`tress threads <app-origin> --open THREAD_ID`, with the same authentication
flags. Normal `tress attach <app-origin>` already discovers the list; users do
not need to run a separate listing command first.

Browser and terminal see the same replies. `/exit` detaches the terminal;
the host's run continues. Obtain a new credential after expiry or revocation.
Generic browser login, automatic token refresh, and thread creation from the
CLI remain future work. Older Tress hosts and session commands keep their
existing connection path.

## If the current browser owns the conversation

assistant-ui components alone do not provide a shared durable host. Keep the
components and existing agent, but move conversation ownership to a server:

- Wrap the existing AI SDK agent with `DirectChatTransport` and `AISDKTransport`.
- Mount a long-lived Harness `statewireHost` with your durable storage and
  per-thread authorization.
- Point the existing assistant-ui runtime at that endpoint. This changes the
  transport wiring, not the visual components.
- Attach Tress to that same endpoint with app-issued user credentials.

The [server integration guide](../site/docs/existing-app.mdx) shows the wiring.
A transient `/api/chat` stream alone cannot restore shared history or keep a
run alive independently of the browser. Do not create a separate Tress agent
or conversation store for an existing application's thread.

## Try the complete flow

The [existing-app example](../examples/existing-app/README.md) uses ordinary
assistant-ui components, a server-owned Harness thread, and the native CLI.
Its build needs no Tress browser package. It demonstrates app-issued terminal
grants, revocation, shared messages, and restart persistence. Export your
existing AI SDK agent through `AGENT_MODULE` to use the same integration with
your own tools and model configuration.

Managed terminal sign-in remains separate work. The standalone `tress serve` machine
host is for a different onboarding path; it is not a prerequisite for connecting
to an existing application's agent.
