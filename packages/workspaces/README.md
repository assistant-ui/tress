# @tress/workspaces

Embed tress over virtual files, a local directory, or a remote sandbox. This
package lives in the repository; it is **not published to npm yet**.

```text
browser ─┐
         ├── shared thread host ── Rust/WASM agent ── Workspace
terminal ┘                                           ├── just-bash (memory)
                                                     ├── local (disk / overlay)
                                                     └── remote sandbox
```

The workspace lives on the host. Attaching a terminal does not upload its current
directory, start a second agent, or copy the files into the browser. Both clients
send prompts to the same session and observe its events and shared file previews.

## Build and try

Requires Node 20.19+ and the Rust/WASM build tools described in `site/README.md`.
From the repository root:

```sh
npm --prefix packages/workspaces ci
npm --prefix packages/workspaces run build
npm --prefix site install
npm --prefix site run wasm:node
```

Use `"@tress/workspaces": "file:../packages/workspaces"` in an adjacent app, or
run `npm pack` in this directory to produce an installable tarball. Build the
package before importing it. Generated WASM bindings remain a separate artifact.

## The integration

```ts
import { createAgent, WORKSPACE_TOOLS } from "@tress/workspaces";
import { createLocalWorkspace } from "@tress/workspaces/local";
import { TressHostSession } from "./pkg-node/tress_wasm.js";

const workspace = await createLocalWorkspace({
  root: "/projects/my-app",
  mode: "read-write", // "overlay" keeps edits in memory
});

const agent = createAgent({
  Session: TressHostSession,
  workspace,
  url: "https://api.anthropic.com/v1/messages",
  model: process.env.TRESS_MODEL!,
  headers: {
    "x-api-key": process.env.ANTHROPIC_API_KEY!,
    "anthropic-version": "2023-06-01",
  },
  system: "Help with this project. Bash is simulated; native runtimes are unavailable.",
  tools: {
    include: WORKSPACE_TOOLS,
    authorize: async ({ name, input }) => {
      // Supply your app's policy or approval UI here.
      return name === "read" || name === "ls" || await requestApproval(name, input);
    },
    onToolResult: async (call, result) => {
      // Audit calls or publish updated file previews to your clients.
    },
  },
});

await agent.send("Explain the project", (event) => console.log(event));
await agent.send("Now improve its README", (event) => console.log(event));
const messages = agent.checkpoint(); // store securely in your database
agent.dispose();
```

`requestApproval` above is an application callback, not a provided function.
Without `tools.include`, only `read` and `ls` are exposed. Opting into a tool
allows it unless your `authorize` callback denies it. Authorization is awaited,
exceptions deny the call, and unknown/disabled tool calls never run. An observer
failure does not turn a completed write into a failed tool call; use
`onObserverError` to report observer errors.

`url` must implement the Anthropic Messages streaming protocol. This is not an
OpenAI Chat Completions adapter. Browser bindings can use a same-origin model
proxy; keep API keys on a trusted server. Rust applications can implement the
existing `Provider` and the now asynchronous `Tools::execute_async` directly.

## Choose a workspace

| Adapter | Files | Commands |
| --- | --- | --- |
| `createBashWorkspace` | Virtual, in memory | just-bash's simulated commands |
| `createLocalWorkspace` | Real directory; optional in-memory overlay | just-bash's simulated commands over those same files |
| `createVercelWorkspace` | Existing Vercel Sandbox | Real Bash and installed programs inside its VM |
| Your `Workspace` | Whatever your app provides | Optional; implement `exec` to expose a shell |

### Virtual

```ts
import { createBashWorkspace } from "@tress/workspaces/just-bash";

const workspace = createBashWorkspace({
  files: { "src/index.ts": "export const answer = 42;\n" },
  bash: {
    commands: ["cat", "ls", "grep", "sed", "echo", "mkdir"],
    // Also accepts just-bash network policies, limits, fs, and custom commands.
  },
});
```

Network access, Python, and JavaScript execution are off by default. The adapter
uses just-bash's hardened execution-limit profile unless overridden. `exec`
starts in the configured root each time; file changes persist between commands.
`cd` and shell environment changes do not persist between separate calls.

### Local

```ts
const workspace = await createLocalWorkspace({
  root: "/projects/my-app", // existing directory, selected by the host
  mode: "overlay",         // read disk; keep changes in memory
  maxFileReadSize: 1_048_576,
});
```

Use `read-write` for actual disk edits. File paths are relative and `..`/absolute
paths are rejected. just-bash blocks following host symlinks. An overlay can
shadow a link in memory without writing through it. A scoped local directory is
not a VM: commands still use just-bash, and trusted custom JS callbacks execute
in your host process. Do not mount unrelated credentials into the workspace.

For native local shell commands, the standalone Rust CLI already provides
`NativeTools` with approvals. This JS adapter intentionally does not spawn a
native local shell. Use a remote sandbox for npm, git, full test suites, and
untrusted generated programs.

### Remote

Install `@vercel/sandbox` 3.5+ in your application and configure its credentials.

```ts
import { Sandbox } from "@vercel/sandbox";
import { createVercelWorkspace } from "@tress/workspaces/vercel";

const sandbox = await Sandbox.get({ name: "my-project" });
const workspace = await createVercelWorkspace({
  sandbox,
  root: "/vercel/sandbox", // existing directory inside the VM
  timeoutMs: 60_000,
  env: { CI: "1" },
});
// Pass workspace to the same createAgent(...) call above.
```

Your app owns sandbox creation, credentials, networking, lifetime, and billing.
The adapter doesn't create or stop sandboxes. SDK operations can resume a stopped
sandbox. File tools check paths against the configured root; **shell commands
can access the whole sandbox**. The VM is the isolation boundary. Give each
untrusted tenant its own environment. See the [SDK reference](https://vercel.com/docs/sandbox/sdk-reference).

### Your own provider and tools

No Vercel dependency is required for a custom adapter. Implement this interface
over E2B, a container, your own RPC service, or an existing filesystem:

```ts
interface Workspace {
  readonly kind: string;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(path?: string): Promise<Array<{
    name: string; // one child name, not a full path
    type: "file" | "directory";
  }>>;
  exec?(command: string): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}
```

Enforce root scoping and resource limits in your adapter. If `exec` is absent,
do not include `bash`. Supply additional tools through `tools.custom`:

```ts
const tools = {
  include: ["read", "ls"] as const,
  custom: [{
    name: "project_status",
    description: "Read project status from our service.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    execute: async (input: Record<string, unknown>) => {
      // Validate custom input at runtime; schema is sent to the model.
      return { content: "healthy", is_error: false };
    },
  }],
};
```

Custom tools also pass through `authorize`. Use `createWorkspaceTools` on its
own if your application already owns an agent loop.

## Files, previews, and persistence

The workspace is the source of truth. `snapshotWorkspace(workspace, { paths:
["src", "README.md"] })` makes a bounded text preview for a UI; it does not copy
the entire workspace. It excludes hidden files, common build directories, key
files, binary text containing NUL, and oversized files. `paths: []` shares
nothing. This preview filter is **not a tool access policy**: tools can still
read permitted workspace files. Only expose previews to authorized clients.

File previews refresh after tool completion in the site. This is not a watcher
for external edits or a live PTY stream. Model text and tool lifecycle events
stream to browser and terminal through statewire.

`checkpoint()` returns model history; pass trusted saved history as `messages`
to `createAgent` to restore it. Persist it after turns in your own storage,
alongside the workspace/sandbox identity. Virtual files need separate storage.
The package does not replay half-finished tools or implement exactly-once
execution. A database, worker, and recovery policy are still needed to survive
host crashes. Never accept raw checkpoints from untrusted browser clients.

`clear()` only clears model context. `dispose()` frees WASM memory and leaves
workspace files and caller-owned sandbox resources alone. A session rejects
concurrent sends; use a separate session/workspace per independent thread.

## Verify

```sh
npm test
npm --prefix ../../site run wasm:node
npm run test:wasm
```

Tests cover real just-bash and temporary local directories, approval denial,
preview limits, SDK type compatibility, and the compiled Rust/WASM engine against
a local mock model. Remote adapter tests use an SDK-shaped mock; they do not
provision or claim to validate a live cloud sandbox. Runnable examples are in
`examples/local.ts` and `examples/remote.ts`.
