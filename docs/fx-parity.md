# fx.sh comparison and release gates

Status: implementation checklist, checked against fx.sh documentation on
2026-10-22. Tress does **not** have complete fx.sh parity. Source-preview items
below are not capabilities of the published v0.3.0 CLI.

The target ownership model is browser/terminal interfaces controlling a
Harness-owned thread, with files and execution on a machine. It does not
require replacing an existing assistant-ui application's agent or identity.

| Capability | Tress status | Remaining work |
| --- | --- | --- |
| Interactive terminal and one-shot prompts | Existing CLI; Harness adapter implemented | Broaden terminal controls for generic Harness backends |
| Terminal access to an existing assistant-ui app | Native CLI attaches to the app's authorized Harness endpoint; no Tress browser dependency | CLI release and production onboarding validation |
| Same conversation from browser and terminal | Harness protocol integration tests pass | Verify complete production onboarding |
| Save and reopen local conversations | Machine Harness host source preview | Interrupted-step recovery and session management |
| Managed conversation storage | `HarnessCloud` host/proxy/tunnel fixtures pass | Live account, expiry, outage, and deployment validation |
| Machine-owned files and artifacts | Disk tools and authenticated browser downloads | Artifact metadata/versioning and remote storage policy |
| Rust engine usable from native and WASM hosts | Existing engine and tested JS workspace bridge | Stable public embedding package and compatibility policy |
| Install without a repository checkout | Release runtime embedding implemented | Publish and verify release artifacts; npm PR #24 remains separate |
| Single executable with no JS runtime dependency | Not implemented for durable mode | Embed a JS runtime or provide a native Harness host; Node 22+ currently required |
| Provider and subscription selection | Anthropic-compatible API only | Provider adapters, provider auth, model listing, usage |
| Session create/list/picker/continue/fork/export | One saved thread per canonical project in machine preview | Explicit session lifecycle and CLI commands |
| Safe recovery of interrupted tools | Harness reports interruption; no automatic tool replay | Durable step records, idempotency, recovery controls |
| File and command tools | `read`, `write`, `edit`, `ls`; opt-in native `bash` | Glob/grep, background/interactive process management |
| Per-tool approvals and permissions | Standalone native approvals exist; machine host has startup grants | Shared browser/terminal approvals and cancellation |
| MCP servers and OAuth | Not integrated | Server lifecycle, discovery, auth, approvals, CLI configuration |
| Skills and subagents | Not integrated | Runtime loading, policy, context, delegation, persistence |
| Web search/fetch and image understanding | No dedicated tools | Provider-backed tools, image input/output and UI |
| Context compaction and token budgeting | Not integrated | Durable summarization and usage limits |
| ACP/editor integration | Not integrated | Protocol adapter and editor validation |
| Complete terminal application compiled to WASM | Engine bridge exists; full Rust terminal UI is not browser WASM | Terminal platform abstraction and browser frontend |

The reference scope comes from the [fx CLI reference](https://fx.sh/docs/using-fx/cli),
[tool capabilities](https://fx.sh/docs/capabilities/tools),
[embedding library](https://fx.sh/docs/lib),
[durability contract](https://fx.sh/docs/lib/durability), and
[WebAssembly embedding](https://fx.sh/docs/lib/webassembly).

## Acceptance for the machine Harness milestone

- [x] Local `tress` starts a Harness SDK host and acts as its client.
- [x] Browser and terminal protocol clients see the same messages.
- [x] Completed conversation and tool context restore after host restart.
- [x] Files remain on the machine and can be downloaded from its interface.
- [x] Storage failure prevents starting a new model run.
- [x] Managed SDK/proxy credentials remain on the host.
- [x] Managed tunnel fixture exercises a real machine tool and remote thread storage.
- [x] Release configuration embeds the host bundle, WASM, and browser assets.
- [x] Verify browser prompt, native terminal follow-up, shared messages, and file listing together.
- [x] Keep the existing assistant-ui browser and attach the native Tress client to its server-owned thread.
- [x] Use Tress's original browser UI for the standalone machine host.
- [ ] Validate a live managed account, including reconnect and authorization errors.
- [ ] Publish a release and verify installation on all supported platforms.

The other draft host PR (#31) uses a custom conversation store. Its browser
host work must be reconciled with this SDK-owned thread implementation before
merging; retaining two authoritative conversation stores is not the target.

See [machine setup](local-harness.md) for commands that are implemented in this
checkout and their current limits. Broader parity should be delivered as
separate, tested capabilities; the table is a backlog, not shipped behavior.
