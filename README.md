# tress

[![CI](https://github.com/assistant-ui/tress/actions/workflows/ci.yaml/badge.svg)](https://github.com/assistant-ui/tress/actions/workflows/ci.yaml)

A tiny coding agent that works in your project directory. One native binary, no background service, shell-style output.

```sh
export ANTHROPIC_API_KEY=...
tress                    # start a session here
tress ask "fix the failing test in parser.rs"
```

```
tress 0.1.0 · ~/oss/tress · claude-sonnet-5
/help for commands, ctrl-d to exit

❯ add a greet function in greet.py and check it runs
I'll add the greeting function.
  · write greet.py
  ● bash python3 -c 'import greet; print(greet.greet("tress"))' [y]es / [a]lways / [n]o y
Done — greet.py works, it printed "hello, tress".
```

## Slash commands

Enter `/` or `/help` in an interactive session to see commands. `/files` lists
workspace files, `/pwd` shows the local workspace path, `/status` shows the
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
See [demo setup and PostgreSQL metadata storage](site/README.md).

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
Completed conversations survive host restarts. `/clear` selects a new cloud
thread and keeps the previous one in Harness. With no harness key, the original
in-memory host is used. `/status` reports the live browser and terminal clients
attached to that host. See [managed setup](site/README.md#managed-harness-and-persistence).

## What it does

- **Five tools**: `read`, `write`, `edit`, `ls`, `bash`. File tools are scoped to the directory you started in and refuse paths that escape it.
- **You approve shell commands.** Every `bash` call asks before it runs; answer `a` to stop being asked for the rest of the session. With no terminal attached (a pipe, CI), gated calls are denied rather than silently run.
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

Early. The engine is a library (`tress::Engine`) driving a `Provider` over a
`Tools` surface, with no I/O of its own — which is what lets the terminal
binary, the browser build, and embedded hosts share it. The site hosts a
[statewire](https://github.com/assistant-ui/statewire-rs) thread that browsers and
`tress attach` can watch and steer for each visitor. Managed Harness persists
completed conversation turns across host restarts. Without Harness, conversation
state stays in memory. Client disconnects do not stop a run, but resuming a tool
interrupted by a host crash still requires application work.

## Configuration

| Variable | Meaning |
| --- | --- |
| `ANTHROPIC_API_KEY` | Required. |
| `TRESS_MODEL` | Model id; defaults to `claude-sonnet-5`. |
| `ANTHROPIC_BASE_URL` | Override the API endpoint (used by the tests' mock server). |

## Develop

```sh
cargo test
cargo clippy --all-targets
cargo fmt --check
```

The end-to-end tests run the real binary against a scripted mock of the Messages API, so the HTTP path, SSE parsing, tool loop, and approval gate are all covered without a key.
