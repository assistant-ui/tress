# Existing-app integration design

This document covers the optional existing-app integration. The default
standalone product is the [machine-backed workspace](local-harness.md);
users do not need to build an assistant-ui application to use it.

Status: original design contract. The first implementation now has a
[runnable source preview](../examples/existing-app/README.md) and
[local-to-production docs](../site/docs/index.mdx). It supports known Harness
thread endpoints, application credentials, revocation, and automatic discovery
of authorized threads on app-origin attachment. See the current
[terminal integration contract](terminal-integration.md). Generic login,
terminal-created threads, and scaffolding below remain proposals.
This document is not an installation guide for Tress v0.3.0. Existing
Tress-host setup remains documented in [setup](setup.md). Implementation order
and deferred managed authentication are in the [roadmap](roadmap.md).

Access clarification: `createTressAccess` is optional. Reuse an application's
existing session checks and authorized Harness host. The helper adds request
checks and live grant expiry/revocation; no external identity service is
required. The Tress demo already offers a separate capability-token sharing
flow, where the copied command itself grants access. That flow is not
automatically installed into arbitrary Harness apps. See the current
[access guide](../site/docs/authentication.mdx) for shipped behavior and the
native server/browser authorization hooks.

## The product the consumer installs

An application owner adds a server integration to their existing assistant-ui
and Harness application. An end user installs the Tress terminal client. Both
clients connect to the same server-owned conversation and existing agent.

```text
Existing assistant-ui browser ──┐
                               ├── Authorized Harness thread ── Existing agent
Tress terminal ─────────────────┘                                and tools
```

The application keeps its UI components, model configuration, tool policy,
identity provider, and hosting. The integration may need to change the UI's
runtime/provider wiring. Keeping the UI does not imply every existing runtime
is compatible without changes.

A terminal connection grants no access to the terminal machine's files or
shell. Agent execution stays on the application's selected backend. Remote
device pairing is separate from terminal access to a conversation.

## 1. Application owner: connect an existing app

1. **Identify where the thread lives.** If Harness already owns it on a server,
   reuse that host. If a browser transport currently owns the conversation,
   mount that transport on a server before attaching multiple clients. An AI
   SDK `/api/chat` route alone is not a shared thread service.
2. **Install compatible integration packages.** Pin a tested combination of
   assistant-ui, Harness, Statewire, and the Tress adapter. Several packages in
   the inspected Harness source are private; packaging must be resolved before
   we offer public install commands. Consumers should not need sibling source
   checkouts in the finished product.
3. **Mount the thread endpoints.** Reuse the Harness host and expose its stream
   and command handlers. A Node deployment can use `statewireHost` around a
   server-side transport. Keep an existing agent endpoint such as `/api/chat`
   behind that transport.
4. **Connect application authorization.** Supply trusted user identity and
   checks for listing, reading, creating, and controlling threads. Validate
   access for streams and commands, including reconnects. A client-supplied
   user ID, workspace ID, or thread ID is not proof of access.
5. **Connect the browser runtime.** Use `HarnessThread`/`HarnessThreadList` as
   appropriate with existing assistant-ui components. Advertise only actions
   supported by the agent and host; attaching does not automatically add
   cancellation, approvals, editing, or branching to an agent.
6. **Publish connection metadata and a browser action.** The integration
   provides the endpoint, supported protocol versions/capabilities, and how to
   authenticate. An optional "Open in terminal" action selects the current
   thread and copies a non-secret connection command.
7. **Verify locally.** Join one thread from the browser and terminal, send from
   each, disconnect/reconnect, and check that there is one conversation and one
   execution of each accepted prompt.

The discovery route and credential options are now defined in the
[terminal integration contract](terminal-integration.md). The remaining
scaffolding and login UX in this design are proposals, not new SDK exports.

## 2. End user: start in the browser

1. Sign into the application through its existing login flow.
2. Open or create a conversation and use it normally.
3. Choose "Open in terminal" and install Tress if necessary.
4. Run the copied command. For a discoverable app with bearer authentication:

   ```sh
   tress attach https://chat.example.com --api-key-env MY_APP_API_KEY
   ```

5. Complete the application's supported terminal credential setup if not
   already authenticated. The initial adapter can use an application-issued,
   user-scoped credential; a generic browser login/device flow is separate
   work. Never ask for a project-wide Harness key, model key, or copied cookie.
6. The terminal loads the existing history and live run. A reply submitted in
   either client appears in both. The UI displays which app/thread is active
   and where the agent executes.

This source-preview command lists the app's permitted threads for selection.
The app must publish the discovery document and authorized Harness endpoints;
arbitrary websites do not become thread hosts automatically. Existing demo
`-s` commands still grant access to one session. Connection commands and URLs
must not contain bearer credentials.

Closing a terminal or browser detaches that client. The server owns the run
and decides how execution, explicit cancellation, and interruption work.

## 3. End user: start in the terminal

1. Install Tress and select the application's URL.
2. Establish an application-scoped credential using the app's supported flow.
   Store credentials by origin and account; never send one app's credentials
   to a different host after a URL override or redirect.
3. Choose an existing authorized thread, or create one if the application
   permits it. Thread creation uses the same owner/workspace rules as the
   browser. Connecting must not silently create a different conversation.
4. Chat in the terminal. Provide a browser link for that exact thread.
5. Open the link, sign into the application if necessary, and continue in its
   existing assistant-ui interface. A link selects a thread; it does not
   transfer ownership or bypass access checks.

The source preview now supports automatic discovery and thread selection with
app credentials. Thread creation, generic browser login, and automatic token
refresh remain proposals. A first attachment must reuse an existing
conversation rather than silently creating another one.

## 4. Application owner: promote to production

The minimum supported deployment should be the existing application plus one
long-running, authorized thread host with persistent storage. Where the app
already has a durable Harness service, reuse it. The static browser UI may be
hosted separately; its lifetime does not own the agent run.

| Area | Production behavior to configure and verify |
| --- | --- |
| Public address | Configure the app's canonical HTTPS origin and endpoint paths. Generated links must use that address, including behind a trusted reverse proxy. |
| Streaming | Forward SSE without buffering, keep long-lived streams healthy, and route command requests to the host that owns the thread. Validate proxy timeout/reconnect behavior. |
| Identity | Use the existing identity provider. Authorize user and tenant access separately from authenticating a token. Browser login and CLI access must resolve to the same principal. |
| Credentials | Keep provider/project keys server-side. Scope terminal credentials to the intended app and permissions; handle expiration without duplicating a submitted prompt. |
| Data | Configure durable thread snapshots/records and workspace storage separately. Restore completed conversations on restart; surface interrupted runs instead of silently replaying side effects. |
| Process lifecycle | Run the host under a service manager/container supervisor. Shut down and flush storage cleanly, and report storage failures. A closed browser must not terminate the worker. |
| Scaling | Begin with one host or use the existing Harness routing system. Multiple independent in-memory hosts behind round-robin routing will not share a thread merely because they share a database. |
| Serverless | Use a durable thread owner/worker when a request-limited deployment cannot keep the run alive. Deploying the UI or adding a streaming route does not provide this automatically. |
| Operations | Record connection/run failures, maintain backups, and document supported recovery. Keep credentials and unnecessary conversation content out of access logs. |
| Versions | Publish a tested client/server protocol matrix. Fail clearly when a client cannot support the host's protocol or required authentication. |

A domain and reverse proxy are configured by the owner or their hosting
platform; a public-URL setting only tells the application what links to emit.
For private development on a VM, SSH forwarding is an alternative to a public
domain. In a laptop browser, `localhost` means that laptop, not the remote VM.

### Production acceptance walkthrough

1. Alice opens a thread in the production browser app and joins it from a
   terminal on another machine. History and streaming converge.
2. Alice sends from the terminal and follows the reply in the browser. Close
   the terminal mid-run, then reconnect without replaying the prompt.
3. Alice creates a thread from the terminal once that capability ships. It
   appears in her browser list with the same ownership and workspace.
4. Bob attempts to read and control Alice's private thread; both paths fail.
   A token for a different application or tenant also fails.
5. Expire/revoke terminal access. Verify the defined behavior for new requests
   and existing streams; deny future commands. Do not promise immediate
   revocation if validation only occurs at connection time.
6. Restart the host after a completed turn, restore it, and continue. Separately
   interrupt a tool and confirm the app reports the actual recovery boundary.
7. Pass the same walkthrough through the production reverse proxy, with an
   older supported client and an unsupported client version.

## 5. Users without an existing app

Use the [machine workspace](local-harness.md) to start Tress's agent, saved
Harness thread, and browser interface in a project folder today from source.
A future optional application scaffold would generate an assistant-ui application, server-owned Harness
thread, example agent, storage configuration, and the same Tress integration.
The owner chooses model credentials, identity integration, and deployment.
It follows the same production walkthrough as an existing app. Scaffolding is
a convenience; it does not require an additional conversation implementation.

## Implementation sequence and upstream boundaries

1. **Statewire dependency update:** adopt 0.1.1's HTTP/SSE fixes in Tress. This
   does not add application authentication or generic Harness support.
2. **Authenticated Rust transport:** upstream an additive credential/header
   mechanism in `statewire-rs`. Its inspected 0.1.1 HTTP `connect(url, config)`
   has no caller-supplied authentication option. Define refresh behavior,
   protect protocol-managed headers, and apply credentials to both stream and
   command requests with safe redirect handling. Test this at the transport
   boundary rather than duplicating HTTP logic in Tress.
3. **Tress Harness adapter:** use the existing Harness protocol/types and add
   a shared browser/native-client fixture. Initially support history, text
   streaming, run status, and sending to a known authorized thread. Keep the
   current Tress-specific host adapter working.
4. **Application integration:** package discovery, thread selection/creation,
   and the optional browser action. Reuse the application's auth and owner
   checks. Validate the full production walkthrough.
5. **Scaffold and deployment example:** give new applications the same tested
   integration and document an initial self-hosting topology.
6. **Managed access service:** implement only as a later optional product;
   see the managed authentication backlog in the roadmap.

Source boundaries: [native attachment](../crates/tress/src/attach.rs),
[existing thread format](../site/src/lib/thread.ts),
[Tress agent endpoint](../site/src/app/api/chat/route.ts), and
[existing thread handlers](../site/src/server/thread-http.ts).
