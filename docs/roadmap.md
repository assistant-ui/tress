# Terminal access for existing assistant-ui applications

Status: proposed integration; not part of the v0.3.0 release.

Tress should let a user open an existing assistant-ui/Harness conversation in
a terminal and continue it from either client. Applications keep their agent,
tools, model configuration, identity, and hosting. For users without an app,
a later scaffold will create an assistant-ui/Harness app with the same
integration.

Self-hosted applications are the first target. Managed terminal authentication
is backlog work and is not a prerequisite for the first integration.

## Existing foundation and gaps

Tress already attaches native clients to its site's Statewire endpoints. The
site supplies a custom `ThreadState` with `entries`, `status`, `files`, and
`runs`, plus `send` and `reset` commands. A generic Harness thread uses a
different application protocol and message model. The shared transport alone
does not make `tress attach` compatible with arbitrary assistant-ui apps.

The sibling Harness SDK source includes `HarnessThread` and `HarnessThreadList`
for assistant-ui, `AISDKTransport` for an existing AI SDK endpoint, and
`statewireHost` for server ownership and storage hooks. Tress's existing
`site/src/app/api/chat/route.ts` already adapts its engine to an AI SDK UI
message stream. Reuse these boundaries rather than introducing a second chat
UI, wire protocol, or conversation database.

Some Harness packages inspected during planning are private source packages.
Confirm and pin compatible package/protocol versions before implementation;
do not assume they are installable from the public registry.

## Next upstream PR: attach to a Harness thread

Deliver one browser-and-terminal integration against a server-owned Harness
thread in an existing assistant-ui app.

- [ ] Establish the supported Harness protocol version and endpoint/auth
  contract against an existing fixture. Keep credentials separate from URLs.
- [ ] Add a terminal adapter for Harness messages, text streaming, run status,
  and sending a prompt. Retain existing Tress host support. Report unsupported
  capabilities explicitly rather than advertising nonfunctional controls.
- [ ] Support the application's existing user-scoped authentication at the
  transport boundary. Never require an end user to copy a project-wide Harness
  key, model-provider key, or browser session cookie into the terminal.
- [ ] Add a reproducible integration fixture using existing assistant-ui
  components, a Harness host, and a scripted model endpoint.
- [ ] Document how an existing app exposes the thread endpoint and how a user
  joins the same thread. Separate current commands from proposed syntax.

Acceptance checks:

1. A browser-created thread opens in the terminal with the same history.
2. A prompt sent from either client appears in both; only one agent run occurs.
3. Disconnecting one client leaves the host run and the other client intact.
   Reattachment catches up without resubmitting the prompt.
4. Expired credentials and forbidden thread access fail clearly. Rejected
   clients receive neither conversation data nor command access.
5. Existing Tress attachment and one-shot completion behavior still pass.

This PR proves the protocol and client adapter. It does not add a separate
native Tress server, machine provisioning, remote shell access, or a managed
authentication service.

## Follow-up PRs

1. **Application integration:** package discovery, connection metadata, and
   adapters for the app's identity and thread authorization. Add an optional
   browser "Open in terminal" action. Reuse existing Harness endpoints where
   possible. A thread ID identifies a thread; application policy authorizes it.
2. **Self-hosting example:** package the existing application/server pieces
   with storage, configured public URLs, and local/HTTPS deployment guidance.
   A browser-owned thread needs a server-owned host for shared-client use.
   Distinguish completed-turn recovery from interrupted tool recovery.
3. **Scaffolding:** generate a working assistant-ui/Harness application only
   for users without one. Existing apps install the integration without
   replacing their UI or backend.
4. **Capability parity:** map structured tool activity, approvals, cancellation,
   and thread selection as supported by the backend, with browser/CLI checks.

Connecting a terminal does not expose that terminal machine's filesystem or
shell. Execution stays with the application's configured backend. Remote
machine execution is a separate feature with explicit authorization.

## Backlog: optional managed terminal authentication

Purpose: simplify terminal authorization for existing applications while
retaining their login system and thread access rules. Keep a self-hosted
authentication path available.

- [ ] Application registration and domain verification.
- [ ] Integration with the app's authenticated user and thread permissions;
  identity must be established by the app, not supplied by the CLI.
- [ ] Browser authorization with PKCE for capable desktop clients and a
  device authorization flow for headless terminals.
- [ ] Explicit consent, short-lived audience-restricted credentials, scoped
  permissions, signing-key rotation, and protected CLI credential storage.
- [ ] Refresh-token lifecycle, connected-terminal management, revocation,
  and access audit events. Define how revocation terminates existing streams
  as well as preventing future connections.
- [ ] Direct terminal-to-application conversation traffic; managed auth does
  not need to proxy chat content or receive model-provider credentials.
- [ ] Multi-tenant isolation, rate limits, expiry/revocation tests, and an
  independent security review before a production release.

The existing Harness authorization hooks are a foundation, not an implemented
managed terminal sign-in product. Use standard OAuth flows and maintain a
clear separation between authentication and application authorization.

References: [native-app OAuth](https://www.rfc-editor.org/rfc/rfc8252.html),
[device authorization](https://www.rfc-editor.org/rfc/rfc8628.html), and
[OAuth security best practices](https://www.rfc-editor.org/rfc/rfc9700.html).

## Other existing follow-ups

[Issue #12](https://github.com/assistant-ui/tress/issues/12) tracks interrupted
run recovery, browser ownership of terminal-created threads, presence cleanup,
and plain-terminal prompt repainting. Those remain separate from the adapter
milestone. Older release notes in that issue are historical; use the releases
page for current release status.
