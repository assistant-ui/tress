# tress

[![CI](https://github.com/assistant-ui/tress/actions/workflows/ci.yaml/badge.svg)](https://github.com/assistant-ui/tress/actions/workflows/ci.yaml)

A coding agent workspace that lives on a machine and can be controlled from a
browser or terminal. Harness owns the conversation; the host machine owns the
files, artifacts, and tool execution. You can start with Tress's own agent and
UI, or connect the terminal to an existing assistant-ui application.

## Start on your own machine

The durable machine host is a **source preview**. First follow the
[build and install steps](docs/local-harness.md#build-and-start); it requires
Node 22+ on the host as well as the bundled Rust/WASM engine and browser assets.
Then:

```sh
tress setup --local      # save your model credential and select local mode
cd your-project
tress                    # start/rejoin this project's saved Harness thread
```

Open the private browser URL printed by Tress to control the same thread and
preview project files using Tress's existing UI. The host stays running after
the terminal exits. `tress serve --stop` stops it without deleting its saved
conversation or files. The preview has one thread per project; interrupted
tools are not automatically recovered. Managed Harness is optional, and live
managed deployment verification remains a release requirement.

## Other ways to connect

| Starting point | What to do |
| --- | --- |
| Try the hosted demo | Open [the website](https://tress-theta.vercel.app) and use its connection command. The site supplies the host and agent. See [demo setup](docs/public-demo.md). |
| Existing assistant-ui app | Keep its UI, agent, tools, and identity. Expose its authorized Harness list and threads, then use `tress attach <app-origin>`. See [terminal integration](docs/terminal-integration.md). |
| Embed in your own application | Choose the Rust/WASM engine, workspace adapters, or host/client boundary. See [embedding and runtimes](site/docs/embedding.mdx). |

Existing-app discovery automatically lists every conversation the app permits
that credential to access. Use `--api-key-env MY_APP_API_KEY` for bearer access,
no flag for an explicitly anonymous app, or a private header file for custom
auth. This path adds terminal access without installing Tress UI components.

**Release status:** the installer currently downloads v0.3.0. Durable local
hosts, existing-app discovery, and combined `attach` file sharing are source
previews, not capabilities of that binary. See [installation](docs/setup.md)
and [current limits](site/docs/reference.mdx). The JavaScript packages are
repository-local; no npm installation or new release is implied.

The published v0.3.0 standalone mode (retained as `--ephemeral` in this
checkout) uses the native terminal loop and does not persist its conversation:

```
tress 0.3.0 · ~/oss/tress · claude-sonnet-5
/help for commands, ctrl-d to exit

❯ add a greet function in greet.py and check it runs
I'll add the greeting function.
  · write greet.py
  ● bash python3 -c 'import greet; print(greet.greet("tress"))' [y]es / [a]lways / [n]o y
Done — greet.py works, it printed "hello, tress".
```

## Hosted demo commands

Enter `/` or `/help` in an interactive session to see commands. `/files` lists
workspace files, `/pwd` describes the workspace path, `/status` shows the
session status, `/clear` starts a fresh conversation without changing files
on disk, and `/exit` (or `/quit`) leaves.

With `tress attach <url>`, `/disconnect` and `/reconnect` leave and rejoin the
shared host, and `/attach` shows its connection command. In this mode, `/clear`
clears the **shared conversation** when idle. Memory mode also restores the
example files; local and remote workspaces keep their files. The browser has
the same commands. Plain terminal output is the default. Run
`tress attach <url> --ui` to opt into the full terminal interface. In the browser
and terminal UI, typing `/` opens a command picker:
↑/↓ selects, Tab completes, Enter runs, and Escape closes it.

The browser labels the workspace as local, sandbox, memory, or overlay instead
of showing a full host path. Use `/pwd` (or click that label) to reveal and copy
a local workspace path. In an attached terminal, `/pwd` reports the host's
workspace, not the terminal's current directory. Remote and virtual workspaces
explain their storage mode without suggesting a local disk folder.

The site gives each visitor a separate session. Copy its attach command:

```sh
tress attach http://localhost:5311 -s <id>
tress attach http://localhost:5311 -s <id> --ui
```

Use the full session ID shown on the page to join the same conversation and
workspace from another client. The ID grants access to that anonymous session.
See [managed demo setup, credentials, and visitor steps](docs/public-demo.md)
or the [site reference](site/README.md) for storage details.

The managed public demo can also use a visitor's local folder without giving
the visitor a Harness key. Run
`tress attach <site-url> -s <session-id> --root . --ui` in that folder. With the
updated host and CLI, the session command connects directly and opens the terminal
UI. Hosts can require a browser pairing code with `TRESS_REQUIRE_PAIRING=1`.
Folder access stays active until you exit. Use `--root <path>` to
choose another folder. Omit `--root` to share the whole filesystem accessible
to your process, or use `--chat-only` for no file sharing. Access is read-only by default; add `--allow-write` to
permit file edits. This native process serves scoped file requests and does
**not** become the agent host or
expose a shell. See [connected-folder setup and access rules](docs/connected-folder.md).

### Host and clients

The **host** is the machine workspace or application server at the attach URL. It runs the agent and owns
the model credentials, thread state, and workspace access. Browser tabs,
terminals connected through `tress setup` or `tress attach`, and API connections
are **clients** attached to it. A `tress connect` process is another client
that can supply a local folder to one thread. Browser and terminal use the host's model
configuration; neither needs a personal model key. The thread sidebar and
`/status` show these roles separately.

The server operator supplies the host address. Anyone holding a private thread
link or session ID can join that thread. Hosted `tress setup` saves a connection to an existing host. In the source
preview, `tress setup --local` selects machine mode; the next `tress` invocation
starts or rejoins its background host.

The host label defaults to the server address. `TRESS_HOST_LABEL` can replace
that text with a friendly display label such as `Alice's Mac`; it does not
change networking, permissions, or host ownership. The person running or
deploying tress currently assigns the host. Clients cannot promote themselves
or transfer the host role. See [hosting and client communication](docs/hosting.md)
for the supported modes and complete setup flow.

The optional terminal UI has a persistent `❯` composer, live ready/working status,
and a file preview toggled with `/files` or Ctrl-F. Your draft stays intact
while the host streams. With an empty input, Tab/Shift-Tab changes files;
mouse drag uses the terminal's normal text selection so transcript and file
content can be copied. PgUp/PgDn scrolls the transcript and
Alt-PgUp/Alt-PgDn scrolls file contents without moving the header or input.
Ctrl-End returns to the latest reply. Pipes always use plain output, even with
`--ui`; the earlier `--plain` flag remains an alias for the default.
See the [site demo](site/README.md) for the two-client walkthrough.

The demo connects to managed Harness when `HARNESS_API_KEY` is configured.
The server holds the credential and localhost tunnel, so browser and terminal
clients share cloud history while tools work on the host's configured files.
Visitors can optionally pair a native folder for that thread instead.
Completed conversations survive host restarts. `/clear` selects a new cloud
thread and keeps the previous one in Harness. With no harness key, the original
in-memory host is used. `/status` reports the live browser and terminal clients
attached to that host. See [managed setup](site/README.md#managed-harness-and-persistence).

## What it does

- **Five tools**: `read`, `write`, `edit`, `ls`, `bash`. Files belong to the host workspace; explicit local mode scopes them to the directory you started in.
- **Native shell permissions depend on the host.** The standalone `--ephemeral` loop asks before each `bash` call. The machine Harness preview disables shell by default; `tress serve --allow-exec` grants native execution for that host without per-command prompts.
- **Streaming**: replies appear as they are generated; tool activity stays inline in the transcript.
- **Portable core**: the engine, tools, and message assembly build for `wasm32` — the HTTP transport and terminal are the only native-only parts.

## In the browser

The core compiles to wasm: `crates/tress-wasm` binds it for JS, and the same
engine runs in a tab against an in-memory workspace with no install. Build
instructions and a working demo are in [crates/tress-wasm](crates/tress-wasm).

```js
const session = new TressSession("/v1/messages", "claude-sonnet-5", {}, files);
await session.send("add a greet function in greet.py", onEvent);
```

## Embed it with your own files

[`@tress/workspaces`](packages/workspaces/README.md) connects the Rust/WASM
engine to asynchronous host tools. Choose just-bash in memory, a scoped local
directory (with optional overlay), or an existing Vercel sandbox. Supply your
own `Workspace` for other sandbox providers; configure tools, approval policy,
model endpoint, event handlers, and saved conversation history.

```ts
const workspace = await createLocalWorkspace({ root: "/projects/my-app" });
// Or: await createVercelWorkspace({ sandbox });
const agent = createAgent({
  Session: TressHostSession,
  workspace,
  url: modelEndpoint,
  model,
  headers,
  tools: { include: ["read", "ls"] },
});
await agent.send("Explain this project", onEvent);
```

See the [complete integration and runnable examples](packages/workspaces/README.md).
The package is local to this repository and has not been published to npm.
Local JS adapters use simulated just-bash commands; a remote sandbox supplies
real runtimes and test runners. Both browser and attached terminal use the
host's workspace, not the attached terminal's current directory.

## Status

The [roadmap](docs/roadmap.md) tracks the machine-backed workspace, optional
existing-app integration, and release requirements. The source preview has a
durable local Harness host, shared browser/terminal conversation, and app thread
discovery. Published v0.3.0 does not include those additions.

Local machine hosts save Harness snapshots; managed hosts use cloud conversation
storage. Files remain in the configured workspace. Client disconnects do not
stop a host run, but a host crash can interrupt tools and requires inspection
before continuing. [The capability checklist](docs/fx-parity.md) records the
remaining runtime, embedding, and agent features without claiming full parity.

## Configuration

Run `tress setup` to save a host connection. The host holds model and Harness
credentials; the terminal does not need either key. `tress config` shows the
selected mode and connection, and `tress doctor --check-api` checks the host.
`tress ask <prompt>` sends a task to that host and exits when it finishes.

Use `tress setup --local` to select a machine workspace with your own Anthropic
key, or `tress --local` for one invocation. Only local mode reads model settings
from environment variables and an optional project `.tress.json`. Flags override
environment, project defaults, and personal settings.

See [setup, configuration, credential storage, and troubleshooting](docs/setup.md).

## Develop

```sh
cargo test
python3 scripts/test-setup-pty.py
cargo clippy --all-targets
cargo fmt --check
```

The end-to-end tests run the real binary against a scripted mock of the Messages API, so the HTTP path, SSE parsing, tool loop, and approval gate are all covered without a key.
