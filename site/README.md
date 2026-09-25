# tress site

A [Farm.js](https://farmjs.dev) site with a live coding-agent playground. Each
visitor gets their own session; its browser and terminal clients share one thread.
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

## Install command on the site

The hero uses the current site's origin automatically, for example
`curl -fsSL https://your-domain.com/tress.sh | sh`. The installer is served from
[`public/tress.sh`](public/tress.sh), so deploying the site publishes it at
`/tress.sh`; no separate installer host or domain setting is needed.

The script installs a checksummed GitHub release binary for macOS or Linux,
on ARM64 or x86-64, into `~/.local/bin`. It prints PATH instructions if needed
and never edits shell profiles or uses sudo. Set `TRESS_INSTALL_DIR` to change
the destination or `TRESS_VERSION` to pin a release tag.

Before the first binary release exists, it builds merged `main` with an
existing Cargo toolchain. Without Cargo it explains that Rust is needed until
a binary release is published. A failed download or checksum never replaces
an existing installation. It also verifies the CLI can run and supports `--session`
before replacing anything, so an older build cannot break the site's attach command.

The repository's **Release CLI** workflow runs when a `v*` tag is pushed. The
tag must match the workspace version in `Cargo.toml` (for example `v0.1.0`).
It tests and builds all four targets, then publishes their binaries and
`SHA256SUMS` together. Push a version tag after the installer and release workflow
and the current CLI's `-s` support are merged to enable installation without Rust.
Test the installer locally with
`npm run test:install`; the tests use fake downloads and never install real software.

## A two-window demo

To try **real local files** on the site, stop the existing dev server and run:

```sh
npm run demo:local
```

Open <http://localhost:5311>. The demo starts with `README.md` and `notes.md`
in `site/.tress/local-demo/threads/<workspace-id>/`. Each visitor gets a separate
folder. Click **make a disk edit**, then open `notes.md`
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
   cargo run -p tress -- attach http://localhost:5311 -s <id>
   ```

   With tress installed, copy `tress attach http://localhost:5311 -s <id>`
   from **attach your terminal** on the page. The ID joins that exact session.
   Add `--ui` for the full terminal interface.

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

`tress attach http://localhost:5311 -s <id>` uses plain terminal output by default.
Add `--ui` to opt into the full interface:

```sh
tress attach http://localhost:5311 -s <id> --ui
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
the session selected by `-s <id>`. `/status` shows its cloud thread ID.

```dotenv
HARNESS_API_KEY=your-project-key
HARNESS_ORIGIN=https://your-harness.harness.assistant-api.com
HARNESS_WORKSPACE=tress-demo
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
Each session’s active cloud thread ID is stored in the session registry described
below. `/clear` starts a new cloud thread for that session and preserves its previous
conversation in Harness; local and remote files remain intact. Its session ID stays
the same, so attached clients follow the new conversation together.

The UI reports **cloud connected** only after the managed connection succeeds.
Cloud errors are shown and never silently fall back to an unpersisted session.
This persists completed turns; it does not resume a WASM tool call interrupted
by a host crash. Local runs need the host awake and running.

Without a harness key, or with `TRESS_THREAD_MODE=local`, the demo uses the
original in-memory host: client disconnects are supported, server restarts
start a fresh conversation. `TRESS_THREAD_MODE=cloud` requires a key explicitly.
Workspace selection is independent of thread storage. The just-bash shell
supports file/text commands, not native node, npm, or git.

## Visitor sessions and PostgreSQL

On the first visit, `/api/mode` creates a random 12-character session ID and saves it in an
HTTP-only browser cookie. Refreshing the page resumes it. A new visitor gets a
fresh conversation and workspace. **new tab** opens the current session.

```sh
tress attach http://localhost:5311 -s <id>
tress attach http://localhost:5311 -s <id> --ui
```

`--session <id>` is also accepted. The page shows the full short ID. Existing
32-character IDs still work; opening an existing session creates a short alias
for the same conversation and workspace. This is anonymous access: anyone with the session ID can join. It
is not account sign-in. An internal UUID identifies the workspace and a separate
random owner ID identifies the anonymous visitor. The registry stores a hash of
the access ID, never the raw credential. Public workspace/cloud IDs alone cannot
attach to another session.

By default, the registry is saved in `.tress/sessions` (override with
`TRESS_SESSION_DIR`). Keep this folder and local workspace files across restarts.
To use PostgreSQL, set a server-only connection string in `.env.local`:

```dotenv
TRESS_DATABASE_URL=postgresql://user:password@host/database
```

Then run the migration and restart the site:

```sh
npm run db:migrate
npm run db:import
npm run demo:local
```

The `tress_demo_access` table maps hashed IDs and aliases to sessions.
The `tress_demo_threads` table stores the anonymous owner ID, workspace ID,
access hash, active Harness thread ID, and timestamps. Harness stores conversation
history; PostgreSQL tracks which session owns it. Stop the host before running
`db:import` to copy existing file-backed session records without changing their
IDs. The import is transactional, keeps local records intact, and leaves existing
database records unchanged. For a fresh installation with no local sessions,
skip the import step.

`src/server/thread-store.ts` exposes `ThreadStore` and file/PostgreSQL adapters.
Replace session resolution in `src/server/demo-session.ts` to use your own login
and ownership checks. A public hosted demo should add request/run quotas, session
expiry, and idle host cleanup. The sample keeps live hosts in one Node process;
PostgreSQL alone does not coordinate multiple execution hosts.

For a trusted single shared demo, set `TRESS_DEMO_SHARED=1`. That compatibility
mode uses `tress attach <host>` without an ID, honors `HARNESS_THREAD_ID`, stores
its cloud selection in `.tress/harness`, and uses the configured local root
directly. Existing shared demo history and files are not moved or deleted.

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

In the default isolated demo, the local root above is a parent directory: each
session uses `threads/<workspace-id>` underneath it. Use `TRESS_DEMO_SHARED=1`
to operate directly on one existing trusted project. Overlay mode reads a common
base but gives each session separate virtual edits.

Without `TRESS_ALLOW_WRITES=1`, local and remote modes expose only `read` and
`ls`. Writes enabled also exposes `write`, `edit`, and `bash`. Local mode uses
just-bash's simulated shell over the selected directory; it doesn't launch
native host binaries. `TRESS_WORKSPACE=overlay` reads that directory but keeps
edits in memory, which is useful for a preview. Overlay mode permits virtual
writes by default.

### Existing Vercel sandbox

```dotenv
TRESS_WORKSPACE=vercel
TRESS_SANDBOX_NAME=demo-{threadId}
TRESS_WORKSPACE_ROOT=/vercel/sandbox
TRESS_ALLOW_WRITES=1
TRESS_VISIBLE_FILES=["src","README.md","package.json"]
```

Configure credentials for `@vercel/sandbox` 3.5+ on the server. The host calls
`Sandbox.get({ name })`; it does not provision a new sandbox or stop yours.
For isolated sessions, `{threadId}` is replaced with the internal workspace UUID.
Your workspace factory must provision the matching sandbox before opening it;
a single fixed sandbox name is rejected in isolated mode. For a trusted shared
sandbox, set `TRESS_DEMO_SHARED=1` and use its existing name.
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

This sample uses anonymous session access. For account-based ownership, add
your authentication and tool authorization policy. Use disposable demo roots
for public visitors, and keep private project files out of those roots. Managed turns store model
and tool history in Harness, including file content returned by tools. File
persistence alone does not resume a tool interrupted by a host crash.

## Checks and production build

### Vercel

Import `assistant-ui/tress` with root directory **site**, enable files outside the
root directory, and use the checked-in `vercel.json`. The build installs the
matching Rust/Wasm toolchain, builds the workspace package, applies additive
PostgreSQL migrations, and emits Farm's Vercel output from the GitHub source.

Set `ANTHROPIC_API_KEY`, `HARNESS_API_KEY`, and `TRESS_DATABASE_URL` as server-only
environment variables. Set `TRESS_SERVERLESS=1`, `TRESS_THREAD_MODE=cloud`, and
`TRESS_WORKSPACE=memory`. Set `PUBLIC_BACKEND_URL` to the production `/api/chat`
URL and allow that endpoint in your managed Harness settings.

The serverless adapter keeps each SSE stream inside one invocation. PostgreSQL
routes posted frames to that exact stream, persists command sequence records,
and tracks live clients across instances. Streams renew after 210 seconds to
stay below the 300-second function limit. A browser disconnect does not cancel
the managed cloud run; `/api/chat` continues serving Harness independently.
Each individual model run still has the function's 300-second execution limit.

Hosted virtual text files are saved to PostgreSQL after tools complete and
restored by subsequent invocations. Storage includes hidden files and is separate
from filtered UI previews. The demo limits each workspace to 1,000 entries,
32 directory levels, and 10 MB of text. `/clear` resets hosted virtual files;
the local disk demo keeps its existing behavior when `TRESS_SERVERLESS` is unset.

`npm run test:relay` exercises two independent workers against PostgreSQL,
including reconnects, session isolation, live files, clearing, and disconnecting
during a run. Set `TRESS_RELAY_TEST_DATABASE_URL` for this test (CI supplies its
own disposable PostgreSQL service). Test rows are created under random IDs and
removed afterward.

### Node

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
files. Session checks also verify separate visitors, exact native attachment via
`-s`, cross-session access rejection, and registry/files surviving a restart.
It starts isolated servers and does not touch your running demo.
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

### Thread sidebar

The **threads** button opens a compact sidebar (a drawer on smaller screens).
Create a thread, switch between workspaces, rename a conversation, or archive and
restore it. New threads receive separate files and attach IDs. Switching leaves
runs on the host and keeps unsent drafts in the current tab; archiving only changes
the list and never deletes history or files. `/clear` keeps its existing behavior.

A separate HttpOnly browser-owner cookie controls the list. Shareable `-s` IDs
continue granting access to one thread, without exposing the owner's other threads.
On a normal visit without a session link, an existing session cookie can adopt
its unclaimed legacy thread. Shared links never grant ownership of the list.
The database stores hashed owner/attach credentials, titles, and archive timestamps; Harness
continues storing conversations. Cookie loss means losing access to the browser's
list, though saved attach IDs still open their individual threads.

Run `npm run db:migrate` for PostgreSQL before starting an updated local server.
The Vercel build applies the migration automatically. File-backed development uses
the same API. Titles use the first prompt without another model call. The sidebar
loads metadata on selection, opening, and window focus; it does not subscribe to
all threads or poll in the background. The working indicator reflects the open
thread's live state.
