# Set up tress

Tress connects to a host by default. The host supplies the model, runs tools,
and owns the workspace. Browser and terminal clients share its thread.
Your terminal does not need an Anthropic key or a Harness key.

## Install

On macOS/Linux:

```sh
curl -fsSL https://tress-theta.vercel.app/tress.sh | sh
```

The installer downloads a binary, verifies its checksum, and installs to
`~/.local/bin`. Follow its PATH instructions if needed.

Hosted setup requires **v0.2.0 or newer**. Check `tress --version` after
installation. Until v0.2.0 is published, the installer still downloads v0.1.0;
build this checkout with Rust to use hosted setup now:

```sh
cargo install --locked --path crates/tress
```

## Upgrade from v0.1.0

Once v0.2.0 is published, rerun the install command to upgrade. The installer
replaces the executable and leaves your configuration and files untouched.

The default changes in v0.2.0: `tress` and `tress ask` connect to a host. Run
`tress setup` once to choose that host and session. Existing commands using
`tress attach <url> -s <id>` keep working without setup.

For the previous local behavior, use `tress --local` or
`tress --local ask "your task"` with your existing `ANTHROPIC_API_KEY`. Run
`tress setup --local` to save local mode as your default. The CLI never switches
to a personal model key when a host connection fails.

## Connect to a host

```sh
tress setup
tress
```

Setup asks for the host address, defaulting to the public demo at
`https://tress-theta.vercel.app`. Enter a session ID from the site to join an
existing conversation, or press Enter to create a fresh thread. Setup prints
a browser link to that same thread and saves the connection privately.
On repeat setup, Enter keeps the saved session; type `new` for a fresh one.

You can also supply the connection directly:

```sh
tress setup --host https://your-tress-host.example -s <session-id>
```

Then use:

```sh
tress                           # join the saved thread
tress --ui                      # opt into the full terminal interface
tress ask "explain these files"  # send a hosted prompt and exit
tress attach -s <session-id>     # another thread on the saved host
```

Explicit attachment still works without setup:

```sh
tress attach https://your-tress-host.example -s <session-id>
```

Files belong to the host's workspace, which may be a local directory on that
host, virtual files, or a sandbox. Connecting from a project directory does not
upload that directory. `/pwd` describes the host's workspace. Client disconnects
do not stop a host run.

`TRESS_HOST` overrides the saved host address. A saved session ID is reused only
when the normalized host matches; changing hosts never implicitly forwards a
session capability from another host. Use `-s` to choose the new host's session.

## Credentials and storage

For the managed demo, the server holds two separate credentials:

- `HARNESS_API_KEY` connects the host to managed Harness.
- The host's model credential pays for inference (currently `ANTHROPIC_API_KEY`).

Harness supplies the shared-thread infrastructure; the host operator configures
and pays for model access. Neither key is copied to the terminal or browser.
A host error never falls back to your personal model key.

Personal settings live in `$XDG_CONFIG_HOME/tress/`, or `~/.config/tress/` when
`XDG_CONFIG_HOME` is unset. `config.json` records the selected mode.
`connection.json` stores the host and session capability in a mode `0600` file
inside a `0700` directory on macOS/Linux. Treat session links and IDs as private.
Saved connections are private plaintext files, not an encrypted keychain.

## Inspect and diagnose

```sh
tress config                # selected mode and connection; session ID hidden
tress config --json         # machine-readable settings
tress doctor                # local configuration checks, no network call
tress doctor --check-api    # check host storage, model access, and Harness
```

Hosted diagnostics return separate storage, model, and Harness checks. The
host checks provider model metadata and opens then closes its managed thread
stream. Keys remain on the host and no completion is generated. Metadata
access does not guarantee a later generation will succeed; compatible proxies
without model metadata report `unknown`. Results are cached for 30 seconds.
The command exits unsuccessfully if any check fails or is unknown. Hosts from
before this endpoint was added report that diagnostics are unavailable.

In the browser, use `/doctor` for the same report. A 401/403 may indicate
deployment protection or rejected host credentials. An expired session returns
410; use `tress setup` and choose `new` to create another. Daily demo limits
return 429 and reset at midnight UTC. Clients always use the host's model
credential, including after an error.

## Explicit local execution

Use local mode when you want the native agent to work in the terminal's current
directory with your own Anthropic key:

```sh
tress setup --local
cd your-project
tress                       # uses the explicitly selected local mode
```

Or choose local mode for one invocation with an existing environment key:

```sh
tress --local
tress --local ask "fix the failing test"
```

Run `tress setup` again to select hosted mode. `tress attach` always connects to
a host, regardless of the saved mode. Local mode does not start a shareable
server or persist its conversation through a process restart.

Local setup hides key input and saves it separately in `credentials.json`
(mode `0600`). Enter preserves an existing saved or environment key; an
existing environment key is not copied to disk automatically. For automation,
pipe the key from your secret manager into `tress setup --local --key-stdin`.
There is no key argument in the process command line.

Optional local defaults in the project's `.tress.json`:

```json
{ "model": "claude-sonnet-5", "max_steps": 64 }
```

Only `model` and `max_steps` are accepted there. Project files cannot set the
mode, host, credentials, API destination, or shell approvals. Hosted execution
does not read project configuration.

Local settings resolve as flags > environment > current directory's
`.tress.json` > personal `config.json` > defaults. Personal config accepts
`mode`, `model`, `max_steps`, and `base_url`.

| Environment | Flag | Purpose in local mode |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Overrides the saved API key |
| `TRESS_MODEL` | `--model` | Model ID (default `claude-sonnet-5`) |
| `TRESS_MAX_STEPS` | `--max-steps` | Model requests per prompt, 1–1024 (default 64) |
| `ANTHROPIC_BASE_URL` | `--base-url` | Anthropic-compatible API base URL |

Put flags before the prompt; use `--` for a prompt beginning with a dash.
Reaching the step limit reports an error and preserves tool results in the
current conversation. Send another prompt to continue.

`tress config --local` shows local values and sources. `tress doctor --local
--check-api` checks the Anthropic Models API without generating a completion.
Compatible proxies may not support that metadata endpoint. Use HTTPS for
remote APIs; credential-bearing redirects are not followed.

See the [site host guide](../site/README.md) for server credentials, Harness,
storage, and workspace adapters. Setup connects to an existing host; it does
not deploy one.
