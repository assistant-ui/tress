# Machine-backed workspaces and clients

Tress provides an agent workspace on a laptop, VM, or server. Browser and
terminal interfaces act on the same host-owned work. Harness owns conversation
state; the machine owns filesystem artifacts and tool execution. An existing
assistant-ui application can expose its own Harness threads as an optional
integration without replacing its UI, agent, tools, or identity.

## Available in source

These capabilities are implemented in the source preview, not the published
v0.3.0 CLI. The [machine setup guide](local-harness.md),
[terminal integration guide](terminal-integration.md), and
[website overview](../site/docs/index.mdx) describe their separate onboarding.

- Local CLI startup starts or rejoins a background Harness host with one thread
  per project. Completed conversation and engine context survive host restart.
- The browser reuses Tress's existing UI and can browse, preview, and download
  machine files. Browser and terminal share the same conversation.
- The host bundles the Rust/WASM engine and browser assets. It requires Node
  22+; the executable does not embed V8 or compile the terminal UI to WASM.
- Managed mode uses HarnessCloud and its backend tunnel. Protocol fixtures pass;
  live managed deployment validation is still required before release.
- Existing applications expose an authorized Harness list and thread endpoints
  through discovery. Attachment lists every permitted thread, including
  archived threads. API-key, anonymous, and custom-header policies are supported.
- Existing Tress hosted sessions and explicit unsaved `--ephemeral` execution
  remain available. No client failure silently falls back to a personal agent.

## Release requirements

- Validate managed account configuration, tunnel reconnect, expiry, and outage
  behavior against a live deployment.
- Publish and verify the runtime-bearing native artifacts on the supported
  platform matrix. Do not advertise source-preview commands as released.
- Complete npm trusted-publisher/bootstrap work separately before offering an
  npm installation path. The npm packaging PR is independent of the runtime.
- Verify consumer onboarding: start a project, prompt in both interfaces,
  inspect a real artifact, exit a client, restart the host, and restore history.

## Further capabilities

- Multiple local threads per project, creation, fork/export, and full history
  pagination. App lists currently refresh on connection and picker opening.
- Interrupted-tool recovery, durable step records, and explicit replay policy.
  Completed-turn persistence does not provide exactly-once tool execution.
- Shared tool approvals and cancellation. The machine host currently grants
  permissions at startup; its native shell is opt-in and has no approval dialog.
- Stable public embedding packages and optional self-contained runtime packaging.
  Browser-compatible WASM still needs supplied tool and storage capabilities.
- Artifact metadata, versioning, and backup policy. Managed conversation storage
  does not sync project files; a VM requires a persistent disk for those files.
- Public multi-user machine hosting and provisioning. The standalone preview
  is single-owner and loopback-only; use SSH forwarding for a remote machine.

The [capability comparison](fx-parity.md) tracks the broader backlog. Full
fx.sh parity is not claimed. [Issue #12](https://github.com/assistant-ui/tress/issues/12)
records related recovery and client follow-ups.

## Optional application authentication

Existing apps retain their identity and per-thread authorization. The optional
access helper is not a required auth provider. Managed terminal sign-in,
generic browser/device login, automatic token refresh, connected-device
management, and application scaffolding remain future work. They are not
prerequisites for starting a local Tress workspace.

The [existing-app design](consumer-setup.md) records that integration's design
and proposed login flows. Any future authentication service should issue
user-scoped, audience-restricted credentials, preserve app authorization, and
keep model/provider and Harness service keys on the backend.
