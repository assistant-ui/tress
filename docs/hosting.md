# Hosting tress

In tress, the **host** is the process that owns the agent. A **client** is a
view or controller connected to that process. The device where someone types
is not necessarily the host.

## Supported modes

| Command or app | Host | Clients | Shareable? |
| --- | --- | --- | --- |
| `tress` after `tress setup` | The saved site host | Terminal and other attached clients | Yes |
| `tress ask <prompt>` in hosted mode | The saved site host | Sends one prompt, then exits; other clients stay attached | Yes |
| `tress --local` | The native terminal process | That terminal only | No |
| `tress --local ask <prompt>` | The native process for one run | None | No |
| tress site | The Node/Farm server | Browser tabs, `tress attach`, and API connections | Yes |
| Embedded engine | The integrating application | Defined by that application | Application-specific |

By default, `tress` connects to the saved host and session. Run `tress setup`
once to choose them; the terminal does not need a personal model or Harness
key. See the [setup guide](setup.md) for installation and release availability.

Explicit `tress --local` makes the terminal process responsible for the model
credential, agent loop, and current directory. It does not start a network
endpoint. A browser or another terminal cannot attach to it. You can save
local mode as your default with `tress setup --local`.

Running `tress attach <url>` always makes that terminal a client. The current
CLI does not have a `tress serve` command for turning a terminal session into a
shareable host.

The included site is the supported shareable host. Its server runs the Rust
agent through WebAssembly, stores the model credential, selects the workspace,
and owns the shared thread. Opening the site does not make the browser the
host; the browser connects to the already-running server.

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

The sample uses private session IDs for access. A public production deployment
should also add authentication, authorization, TLS, request and run quotas,
session expiration, and idle-host cleanup. PostgreSQL can persist session
metadata, but it does not by itself coordinate multiple execution hosts.
