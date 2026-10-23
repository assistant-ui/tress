# Hosting tress

In tress, the **host** is the process that owns the agent. A **client** is a
view or controller connected to that process. The device where someone types
is not necessarily the host.

## Choose the host

The machine host and app discovery below are **source previews**, not in the
published v0.3.0 binary. Build the appropriate runtime before using them.

| Workflow | Host | What clients control |
| --- | --- | --- |
| `tress` after `tress setup --local` | Background Node/Harness process on this machine | One saved project thread and its files, from browser or terminal |
| `tress serve` | The same machine host with explicit startup permissions | Browser and terminal clients can attach |
| `tress attach <app-origin>` | Existing application's authorized Harness backend | All permitted threads through app discovery; the app retains its agent/tools |
| `tress` after hosted `tress setup` | The saved site host | Its shared conversation and workspace |
| `tress connect --site <url>` | The site still hosts the agent | A native connector supplies files; it does not become the agent host |
| `tress --ephemeral` | Unsaved native process | That terminal only; no browser endpoint |
| Embedded engine | Integrating application | Application-defined tools, persistence, and interfaces |

Start with the [machine workspace guide](local-harness.md) for your own project,
[terminal integration](terminal-integration.md) for an existing app, or
[released CLI setup](setup.md) for a hosted connection. The published v0.3.0
local mode retains the unsaved native behavior.

In the machine preview, `tress setup --local` selects the mode and saves the
model credential; running `tress` starts or rejoins the host. The host survives
terminal exit and restores completed conversations after restart. Files stay
on disk. Managed Harness can own conversation storage, while execution and
files remain on the machine. See [embedding](../site/docs/embedding.mdx) for
the distinction between the Rust/WASM engine and its interface clients.

Running `tress attach <url>` makes that terminal a client. It does not move the
agent to the terminal's machine. A demo session can separately offer native
files through [connected-folder access](connected-folder.md); this is distinct
from starting a machine host.

The sections below describe the **site/demo host**, which serves browser tabs
and terminal attachments. The standalone host instead uses a private loopback
listener; remote use needs an authenticated tunnel.

## Start a site host

Follow the [site setup](../site/README.md#run-locally), then place server-only
settings in `site/.env.local`:

```env
ANTHROPIC_API_KEY="your-key"
TRESS_HOST_LABEL="team dev server"
```

`TRESS_HOST_LABEL` is optional. It only changes the friendly text displayed for
the server. It does not change the URL, networking, permissions, or ownership.
Without it, the UI displays the server address, such as `localhost:5311`.

Restart the server after changing environment variables. For a deployment, set
the same variables in the hosting platform's server environment rather than in
a file committed to Git.

When someone opens the site, it creates a private session and attaches that
browser as a client. The page supplies the command for attaching a terminal to
the same thread:

```sh
tress attach https://your-tress-host.example -s <private-session-id>
```

To save that host and thread for future invocations:

```sh
tress setup --host https://your-tress-host.example -s <private-session-id>
tress
```

The session ID grants access to the thread. Treat the complete browser link and
attach command as private credentials.

## How communication works

```text
browser tab ───────┐
tress attach ──────┼─ Statewire HTTP commands + streamed state ── tress site host
API client ────────┘                                      │
                                                          ├─ model provider
                                                          └─ host workspace
```

Each client receives replicated thread state: transcript entries, run status,
file previews, workspace metadata, and live presence. A prompt or command goes
to the host. The host runs the agent and tools, mutates the shared state, and
streams those changes back to every attached client. Disconnecting a client
does not move the agent or its workspace and does not stop an in-flight run.

The model key remains on the host. An attached terminal operates on the host's
workspace, not the terminal client's current directory.

## Labels and identity

The host has one optional display label configured by the server operator:

```env
TRESS_HOST_LABEL="Alice's Mac"
```

Client labels require no setup and are currently generated from the connection:

- browsers: `Chrome on macOS`, `Firefox on Linux`, and similar;
- attached terminals: `tress terminal`;
- other HTTP integrations: `API client`.

Every client also has a generated connection ID so two clients with the same
automatic label can still be distinguished. Custom client labels are not yet
supported. Labels and IDs are descriptive presence information, not an
authentication or permission system.

## Public deployments

The demo uses private session IDs for access and includes configurable daily
run/session limits, session expiry, and idle managed-connection cleanup. See
the [host diagnostics and limits](../site/README.md#host-diagnostics-and-demo-limits)
for defaults and configuration. Add your own authentication and ownership rules
when integrating it with an application. PostgreSQL stores session metadata,
shared counters, and serverless relay state; Harness stores the managed
conversation. Local in-memory threads still require a long-lived host.
