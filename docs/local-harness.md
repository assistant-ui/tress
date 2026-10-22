# A machine-owned Harness workspace

**Source preview; not included in the published v0.3.0 binary.** This replaces
the source checkout's unsaved local session with an actual Harness SDK host.
It does not replace existing hosted sessions or application integrations.

```text
Browser UI ──────────┐
                     ├── authenticated Harness connection ── machine host
Terminal client ─────┘                                       │
                                             Harness SDK thread + Rust/WASM agent
                                                             │
                                                    project files and tools
```

The machine can be your laptop, a server, or a VM. The browser is an interface:
it does not need filesystem or process primitives. The Rust engine compiles to
WASM and is loaded by the host's Node/V8 runtime. Harness SDK owns messages,
run state, and conversation persistence. Engine context is stored in the
Harness assistant message as `data-tress-context`; there is no parallel chat
database. Workspace files live separately on the machine's disk.

Local mode saves Harness snapshots on the machine. Managed mode uses
`HarnessCloud` for the thread and its backend tunnel; execution and files still
belong to the machine. Cloud thread persistence does **not** upload or back up
project files. A VM needs a persistent disk if its files must survive VM deletion.

## Build and start

Prerequisites: Rust, the `wasm32-unknown-unknown` target, Node.js 22+, npm,
Python 3.11+, and the `wasm-bindgen` CLI version pinned in `Cargo.lock`.

From the repository root:

```sh
rustup target add wasm32-unknown-unknown
tress_bindgen_version=$(python3 -c 'import tomllib; print(next(p["version"] for p in tomllib.load(open("Cargo.lock", "rb"))["package"] if p["name"] == "wasm-bindgen"))')
cargo install wasm-bindgen-cli --version "$tress_bindgen_version" --locked
npm --prefix packages/workspaces ci
npm --prefix packages/workspaces run build
npm --prefix site run wasm:node
npm --prefix packages/harness-host ci
npm --prefix packages/harness-host run build
TRESS_EMBED_RUNTIME=1 cargo build --release -p tress
```

Install `target/release/tress` somewhere on your PATH. The build embeds the
host runtime, browser client, and WASM module, so the binary can leave the
checkout. Node 22+ is still required on the machine. This is not an embedded
V8 executable. Release CI uses the same bundling flow; no new release has
been published by this change. The SDK packages are pinned vendored archives.

```sh
tress setup --local        # securely enter/save the provider key
cd your-project
tress                     # start/rejoin this project's Harness thread
tress ask "summarize this project"
```

An exported `ANTHROPIC_API_KEY` also selects local mode when no host or mode
is configured. `tress --local` overrides a saved hosted choice. Each canonical
project path has one saved thread. Reopening the CLI resumes that thread.
The CLI prints a private browser URL: open it to control the same thread and
browse/download files. The host stays running after the terminal exits.

```sh
tress serve --stop         # stop this project's host; keep thread and files
tress                     # restart and restore the saved conversation
```

The default local CLI host allows project file reads/edits and disables native
shell execution. To choose host permissions explicitly, stop it first, then:

```sh
tress serve --open                         # read-only project tools
tress serve --allow-write --allow-exec      # edits and native shell commands
```

`--allow-exec` grants commands the host process's permissions; the working
directory is the project, but shell commands are not sandboxed to that folder.
This preview has no per-command approval dialog. Stop and restart to change
the running host's permissions, model, key, or step limit. Attaching a client
does not replace those settings. The printed `tress attach ... --headers-file
...` command joins the same thread; add `--ui` for the existing terminal UI.

## Managed Harness

Configure these values on the **host machine**, using the origin and workspace
from your Harness environment:

```sh
export HARNESS_ORIGIN=https://your-harness.your-domain
export HARNESS_WORKSPACE=your-workspace
export HARNESS_THREAD_ID=your-thread
# Set HARNESS_API_KEY and ANTHROPIC_API_KEY through your secret manager.
export TRESS_THREAD_MODE=cloud
cd your-project
tress --local
```

Alternatively, use `tress serve --managed --allow-write`. Stop it with
`tress serve --managed --stop`. Local and managed thread namespaces are
separate; selecting managed mode does not migrate an existing local history.

Use a thread intended for this machine's Tress agent. To continue an existing
assistant-ui application's conversation with its original agent, use that
application's authenticated `tress attach` integration instead of selecting
this machine as a new backend.

The machine mounts `HarnessCloud`, maintains the SDK tunnel to its local agent
endpoint, and forwards client requests to the managed thread with host-held
credentials. Browser and terminal clients receive only a private machine
access token. They do not receive the model key or Harness key. Keep this host
running for tool execution even though the cloud owns conversation storage.

Automated tests cover the SDK/proxy protocol, shared messages, credential
forwarding, and a managed backend tunnel fixture. A live managed account is
still required to validate deployment-specific authentication and tunnel
behavior before release. This is not a new end-user managed sign-in flow.

## Storage, networking, and recovery

State lives outside the project under
`$XDG_STATE_HOME/tress/harness/<workspace-hash>` (default
`~/.local/state/tress/harness/<workspace-hash>`). It contains `thread.json` in
local mode, private connection metadata/headers, and `host.log`. Embedded
runtime files are extracted into a content-addressed subdirectory there.
Changing machines does not automatically copy this state or project files.

Snapshots use atomic replacement and filesystem sync. A workspace lock
prevents two host processes from writing the same snapshot. Accepted prompts
are persisted before starting the model; a failed storage write blocks further
prompt execution. Completed turns retain model and tool context across restart.
Checkpoints currently include full model context; context compaction and
bounded history storage remain follow-up work.

An interrupted run is reported as interrupted by Harness. Automatic continuation
of half-completed tools, exactly-once execution, and recovery of every in-flight
model/tool checkpoint are **not implemented**. Inspect file effects after a
crash before continuing. No interrupted tool is automatically replayed by Tress.

The listener binds to `127.0.0.1`. On a VM/server, use an authenticated tunnel
such as SSH local forwarding to the printed port, then open the forwarded URL
with the same private fragment. Preserve the port and `127.0.0.1` host because
the server validates Host and Origin. Public HTTPS hosting and multi-user
authorization remain application integration work.

The browser URL and `headers.json` grant access to the workspace. Model-facing
file tools reject path traversal and symlinks; file downloads are limited to
32 MiB and text reads to 1 MiB. Shell permission remains a separate native
execution grant. Tool permissions do not make this a sandbox for hostile users
who can concurrently change the filesystem.

For an explicitly unsaved native session, `tress --ephemeral` retains the old
agent loop and terminal shell approvals. It does not use Harness or start a
browser host. `TRESS_HOST_RUNTIME` can select a development `dist/host.mjs`;
`TRESS_NODE` selects the Node executable.

See the [fx.sh comparison](fx-parity.md) for the remaining release work and
[application integration](../examples/existing-app/README.md) for connecting to
an existing assistant-ui application's own agent and identity.
