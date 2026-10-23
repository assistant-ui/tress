# @tress/harness-host

Source-preview machine host for the Rust/WASM Tress agent. Harness SDK owns
the conversation; the machine owns the workspace and tools. Node 22+ required.
This private package is not published to npm.

See [setup, managed mode, storage, and limitations](../../docs/local-harness.md).

`createTressTransport` adapts `@tress/workspaces.createAgent` to an AI SDK
`ChatTransport`. `createLocalHarnessHost` mounts `AISDKTransport` with
`statewireHost` and application-supplied storage. Its `fetch`, `flush`, and
`close` methods are server-side. Mount only behind your application's
authorization and provide exclusive ownership of its storage.

The CLI wrapper adds disk storage, a project workspace, authenticated loopback
HTTP, and the existing Tress terminal-style browser UI via
[`@tress/client`](../client/README.md). Managed mode uses `HarnessCloud` and a
credential-preserving protocol proxy. Rust clients connect through the same
Harness protocol as browser clients.

```sh
npm ci
npm run build   # requires built client, workspaces, and site/src/server/pkg-node
npm test       # protocol, disk, credential, and workspace integration tests
```

Set `TRESS_TEST_BINARY` to an absolute native binary path to include CLI
restart tests. Set `TRESS_TEST_EMBEDDED=1` when that binary was built with
`TRESS_EMBED_RUNTIME=1` to verify its extracted runtime.
