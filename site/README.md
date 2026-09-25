# tress site

A [Farm.js](https://farmjs.dev) site with a live, shared coding-agent playground.
The Rust agent runs as WebAssembly **on the server**. Browsers and attached
terminals subscribe to the same statewire thread, so closing a client does not
stop the run.

## Run locally

```sh
npm --prefix ../packages/workspaces ci
npm --prefix ../packages/workspaces run build
npm install
```

Set `ANTHROPIC_API_KEY` in `site/.env.local`. Optionally set `TRESS_MODEL` to choose
a model; the default is `claude-sonnet-5`. Keys stay on the server. Without a key,
the playground explains the setup and disables sending; it does not simulate a
live agent.

Install the Rust `wasm32-unknown-unknown` target and `wasm-bindgen-cli` matching
the `wasm-bindgen` version in `Cargo.lock`. Starting the site automatically builds
the Rust engine and generates its bundler bindings:

```sh
npm run dev -- --port 5311
```

Open <http://localhost:5311>. The attach command on the page uses the current
origin, including its port.

## A two-window demo

To try **real local files** on the site, stop the existing dev server and run:

```sh
npm run demo:local
```

Open <http://localhost:5311>. The demo starts with `README.md` and `notes.md`
in `site/.tress/local-demo/`. Click **make a disk edit**, then open `notes.md`
in your editor to see the saved change. The page shows the exact folder and
live file previews. Your server's existing `ANTHROPIC_API_KEY` in `.env.local`
is used. The launcher preserves edits when run again; **clear chat** keeps files.
Use `npm run demo:local -- --port 5313` to choose another port.

This launcher overrides workspace settings for this process only. `npm run dev`
still uses your normal environment configuration. The sample folder is ignored
by Git. Use the workspace configuration below to point the host at your own
project instead.

1. Place the browser next to a terminal. From the repository root, run:

   ```sh
   cargo run -p tress -- attach http://localhost:5311
   ```

   With tress installed, use `tress attach http://localhost:5311` instead.

2. Click **make a disk edit** in the local demo (or **fix the retry bug** in
   memory mode). Both clients show the same prompt, tool calls, and streamed
   reply. The file preview shows the edited file.
3. Type a follow-up in the terminal, such as `Read notes.md and add a note that
the terminal is connected.` Watch it appear in the browser. Use `retry.js` for
the default memory demo instead.
4. During a run, click **disconnect** in the browser and press **Ctrl-D** in the
   terminal. Disconnect really disposes the browser's transport; its visible
   transcript is now a frozen snapshot.
5. Click **reconnect**, refresh, or attach another terminal. The latest
   transcript and files are restored from the host. **new tab** is
   another way to watch the same thread.
6. Use **reset** when idle to clear the shared conversation, restore the
   example files, and reset the run count. Reset is blocked while a run is active. In local, overlay, and remote modes,
reset clears the conversation and keeps workspace files.

## Slash commands

`tress attach http://localhost:5311` uses plain terminal output by default.
Add `--ui` to opt into the full interface:

```sh
tress attach http://localhost:5311 --ui
```

In the browser or the terminal UI, type `/` to open the command picker. Keep typing to filter,
use ↑/↓ to select, Enter to run, Tab to complete, and Escape to dismiss. You
can also click a command in the browser. The terminal keeps its `❯` input
visible after replies and preserves your draft while other clients stream.
Its black background, quiet borders, and file previews match the web demo.

In the terminal UI, use **Ctrl-F** or `/files` to toggle file previews,
**Tab / Shift-Tab** with an empty input to change files, **Alt-PgUp / Alt-PgDn**
to scroll the file, and **PgUp / PgDn** to scroll the conversation. Mouse drag
uses the terminal's native text selection, so transcript and file content can
be copied normally; the header and composer stay fixed. **Ctrl-End** returns
to the live tail. **↑ / ↓**
recalls your input history when the command picker is closed. **Ctrl-C** clears
a draft (or leaves when empty); **Ctrl-D** leaves when the input is empty. Leaving
the terminal does not cancel the host's run.

Omit `--ui` for line output (`--plain` is also accepted). Pipes and
non-interactive terminals always use this mode. In a standalone native
session or plain mode, enter `/` or `/help` to print the commands.

| Command | Browser and `tress attach` |
| --- | --- |
| `/help` | Show commands. |
| `/files` | Toggle workspace previews; list file names in plain terminal mode. |
| `/status` | Show connection, run count, workspace status, and live browser/terminal clients. |
| `/attach` | Show the command for attaching another terminal. |
| `/disconnect` | Disconnect this client while the host keeps working. |
| `/reconnect` | Rejoin and catch up with the thread. |
| `/clear` | Clear shared model context; only memory mode restores example files. |

The terminal also accepts `/exit` and `/quit` to leave. A standalone `tress`
session supports `/help`, `/files`, `/status`, `/clear`, and `/exit`; its
`/clear` resets model context and keeps files on disk. Slash commands are
handled by the client, including unknown commands, and never sent as model
prompts in these interactive sessions.

## Managed Harness and persistence

Set `HARNESS_API_KEY` in `site/.env.local` to connect this demo to managed Harness.
The key stays on the server. Both the website and `tress attach` connect through
`/api/thread` to the same managed conversation. `/status` shows its cloud thread ID.

```dotenv
HARNESS_API_KEY=your-project-key
HARNESS_ORIGIN=https://your-harness.harness.assistant-api.com
HARNESS_WORKSPACE=tress-demo
HARNESS_THREAD_ID=tress-local-demo
```

`HARNESS_ORIGIN` defaults to this demo's harness. Use your own origin and project
key when embedding it. The unpublished 0.3.0 SDK preview is pinned in
[`vendor`](vendor/README.md), so no sibling checkout is required.

For a localhost backend, enable **Allow localhost** on the harness. The SDK's
WebSocket tunnel runs in the Node host; browser tabs can close while the host
continues serving `/api/chat`. A deployed backend can set `PUBLIC_BACKEND_URL`
to its HTTPS `/api/chat` URL and add that URL to the harness's allowed endpoints.

Harness persists conversation history and tool activity. The backend restores
the Rust model checkpoint from the persisted turn before continuing. Local files
remain in the configured directory; sandbox files remain with their provider.
The active thread selection is stored in `.tress/harness` (override with
`HARNESS_STATE_DIR`). Keep that directory across restarts. `/clear` starts a new
shared cloud thread and preserves the previous conversation in Harness; local
and remote files remain intact.

The UI reports **cloud connected** only after the managed connection succeeds.
Cloud errors are shown and never silently fall back to an unpersisted session.
This persists completed turns; it does not resume a WASM tool call interrupted
by a host crash. Local runs need the host awake and running.

Without a harness key, or with `TRESS_THREAD_MODE=local`, the demo uses the
original in-memory host: client disconnects are supported, server restarts
start a fresh conversation. `TRESS_THREAD_MODE=cloud` requires a key explicitly.
Workspace selection is independent of thread storage. The just-bash shell
supports file/text commands, not native node, npm, or git.

## Local files and remote sandboxes

The server chooses the workspace. The browser and `tress attach` keep the same
protocol and UI in every mode. Set these in `site/.env.local` and restart the
host after changing modes. Native `tress` without `attach` still uses its own
current directory and native shell with approvals.

### Local directory

```dotenv
TRESS_WORKSPACE=local
TRESS_WORKSPACE_ROOT=/absolute/path/to/project
TRESS_ALLOW_WRITES=1
TRESS_VISIBLE_FILES=["src","README.md"]
```

Without `TRESS_ALLOW_WRITES=1`, local and remote modes expose only `read` and
`ls`. Writes enabled also exposes `write`, `edit`, and `bash`. Local mode uses
just-bash's simulated shell over the selected directory; it doesn't launch
native host binaries. `TRESS_WORKSPACE=overlay` reads that directory but keeps
edits in memory, which is useful for a preview. Overlay mode permits virtual
writes by default.

### Existing Vercel sandbox

```dotenv
TRESS_WORKSPACE=vercel
TRESS_SANDBOX_NAME=my-existing-sandbox
TRESS_WORKSPACE_ROOT=/vercel/sandbox
TRESS_ALLOW_WRITES=1
TRESS_VISIBLE_FILES=["src","README.md","package.json"]
```

Configure credentials for `@vercel/sandbox` 3.5+ on the server. The host calls
`Sandbox.get({ name })`; it does not provision a new sandbox or stop yours.
SDK file/command operations can resume it. Real `bash`, installed runtimes,
and test runners execute **inside the VM**. Your app owns sandbox lifecycle
and network policy. No live cloud provisioning is part of the test suite.

### Customize in your own application

`src/server/workspace.ts` is the site's workspace factory. Replace it with
another provider or configure just-bash. The reusable
[`@tress/workspaces` package](../packages/workspaces/README.md) exposes a small
`Workspace` interface, `createAgent`, custom tools, asynchronous approval policy,
events, and conversation checkpoints. The model endpoint can be changed using
`TRESS_API_URL` (Anthropic Messages streaming protocol).

`TRESS_VISIBLE_FILES` selects files/directories for bounded UI previews. Local
and remote modes share no previews unless explicitly configured. Hidden files,
common build folders, key files, and oversized files are omitted. This is a
preview filter, not a restriction on the agent's file tools. File updates are
published after each tool, including completed writes before a later run error.
External file edits aren't watched automatically.

This sample is one shared, unauthenticated thread. Use a trusted local host for
local directories. Before offering it to other users, supply authentication,
per-user thread/workspace ownership, and your tool authorization policy. Never
point a public shared demo at private project files. Managed turns store model
and tool history in Harness, including file content returned by tools. File
persistence alone does not resume a tool interrupted by a host crash.

## Checks and production build

```sh
npm run wasm
npx tsc --noEmit
npm run build
cargo build -p tress
npm run test:host
npm run test:host:dev
```

The host test uses a local mock model, temporary directories, two statewire
clients, and the native attach command. It verifies live file updates, runs
surviving disconnection, follow-up context, and clearing without deleting local
files. It starts isolated servers and does not touch your running demo.
The development variant checks the same flow through Farm's Vite loader.

The [Farm WASM plugin](https://farmjs.dev/docs/plugins/wasm) handles imports of
the generated `src/wasm/pkg/tress_wasm.js` entry point. Both `dev` and `build`
run Cargo and `wasm-bindgen --target bundler` first; the plugin then loads the
engine without a runtime public URL or a manual post-build copy. The shared
agent still executes on the server. The plugin's Node SSR path is exercised by
the host integration test; other server/edge runtimes are not verified.
The config preserves initialization in the generated bindings during SSR
tree-shaking, and the npm override keeps the plugin on the site's Farm core version.

Start the Node server with your environment set:

```sh
PORT=5311 node --env-file=.env.local .farm/.output/server/index.mjs
```

`npm run wasm` rebuilds the Farm bindings on demand. `npm run wasm:node`
generates separate CommonJS bindings for standalone Node consumers and the
workspace package's WASM tests; the site does not load those bindings.
