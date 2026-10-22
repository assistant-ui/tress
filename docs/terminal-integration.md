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

## Already using a server-owned Harness thread

1. **Reuse its endpoint and authorization.** Route the thread's `/stream` and
   `/frames` requests to the same long-lived host. Your existing browser
   continues using its existing components and authenticated connection.
2. **Use an app-issued terminal credential.** If you already support scoped
   user tokens, use that mechanism. Otherwise, add credential issuance through
   your existing login and authorize access to the selected thread. Do not
   export a browser cookie, model key, or project-wide Harness key.
3. **Give the user the complete thread endpoint and a private headers file.**
   An “Open in terminal” or credential-download action is optional; an existing
   account/API-token flow is sufficient. This is connection setup, not a new
   chat interface.

No new Tress server package is required when these boundaries already exist.
The [optional access adapter](../packages/access/README.md) can add per-request
checks, expiry, and live revocation if your app does not already provide them.

The application's authorized credential flow supplies a file like:

```json
{ "Authorization": "Bearer APP_ISSUED_TERMINAL_TOKEN" }
```

The user runs:

```sh
chmod 600 app-headers.json
tress attach https://chat.example.com/api/threads/THREAD_ID \
  --headers-file app-headers.json
```

Use the actual endpoint for the existing conversation. Add `--ui` for the full
**terminal** interface. One-shot use is also supported:

```sh
tress ask --host https://chat.example.com/api/threads/THREAD_ID \
  --headers-file app-headers.json "Continue this task"
```

The terminal loads history and submits prompts to the same host. Browser and
terminal see the same replies. `/exit` detaches the terminal; the host's run
continues. Obtain a new credential after expiry or revocation. Generic browser
login, discovery, automatic token refresh, and thread creation from the CLI
are not implemented by this preview.

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

For managed Harness, reuse your app's existing authorized thread endpoint or
backend proxy. Keep managed service credentials on that backend. Managed
terminal sign-in remains separate work. The standalone `tress serve` machine
host is for a different onboarding path; it is not a prerequisite for connecting
to an existing application's agent.
