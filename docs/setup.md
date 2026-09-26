# Set up tress

Start a local coding session in three steps: install, configure your model,
then run `tress` inside a project. The native CLI uses Anthropic's Messages API.
It does not require a database, a web server, or a Harness account.

## Install

The macOS/Linux installer downloads a prebuilt binary and verifies its checksum:

```sh
curl -fsSL https://tress-theta.vercel.app/tress.sh | sh
```

Follow the installer's PATH instructions if `~/.local/bin` is not already on your
PATH. The installer does not modify your shell profile or require sudo.

**Release availability:** `setup`, `config`, and `doctor` are new source features;
the published v0.1.0 binary does not include them. Until a new release is
published, build this checkout with Rust:

```sh
cargo install --locked --path crates/tress
```

## First run

```sh
tress setup
cd your-project
tress doctor --check-api
tress
```

Setup asks for a model ID (Enter accepts the displayed default) and an Anthropic
API key. Key input is hidden. Get a key from the
[Anthropic console](https://platform.claude.com/settings/keys).
The default model is `claude-sonnet-5`; choose a model available to your account.

`tress` works in the directory where you start it. File tools read and write
there, and shell commands ask for approval. A native CLI conversation lasts for
the current process. Setup does **not** turn it into a shared, durable host.

You can also run a single task:

```sh
tress ask "explain the tests in this project"
tress ask --model claude-sonnet-5 --max-steps 16 "fix the failing test"
```

Flags go before the prompt; once prompt text begins, later words remain part of
it. Use `--` for a prompt that begins with a dash. Run `tress --help` for usage.

## Small, predictable configuration

Settings resolve in this order:

1. Command-line flags
2. Environment variables
3. `.tress.json` in the directory where you start tress
4. Personal configuration
5. Built-in defaults

`tress config` shows the effective values and where each came from. Use
`tress config --json` for machine-readable output. Neither prints API keys.
Configuration and help commands work before you have configured a key.

Personal settings live in `$XDG_CONFIG_HOME/tress/config.json`, or
`~/.config/tress/config.json` if `XDG_CONFIG_HOME` is unset:

```json
{
  "model": "claude-sonnet-5",
  "max_steps": 64,
  "base_url": "https://api.anthropic.com"
}
```

All fields are optional. `max_steps` is the maximum number of model requests
per prompt, including the final answer (1–1024, default 64). A request may
contain several tool calls. If the limit is reached, tress reports it and
keeps the tool results in the current conversation. You can send another
prompt to continue.

For shared project defaults, create `.tress.json`:

```json
{
  "model": "claude-sonnet-5",
  "max_steps": 16
}
```

Only `model` and `max_steps` are accepted in project files. They cannot set an
API destination, credentials, workspace root, or automatic shell approvals.
Tress reads only the current directory's file, not parent directories.
Unknown fields and malformed settings report an error with the file location.

| Environment | Equivalent flag | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Overrides the saved API key |
| `TRESS_MODEL` | `--model` | Model ID |
| `TRESS_MAX_STEPS` | `--max-steps` | Model requests per prompt |
| `ANTHROPIC_BASE_URL` | `--base-url` | Anthropic-compatible API base URL |

Existing environment-only setups still work. An explicitly empty API key is
an error, rather than silently falling back to a different credential.
Custom API destinations belong in personal config, environment variables,
or explicit flags. HTTP is supported for local development; use HTTPS for a
remote API. Redirects are not followed with API credentials.

## Credentials and automation

Setup stores the key separately in `credentials.json` beside your personal
config. On macOS/Linux, this file is mode `0600` inside a `0700` directory.
It is a private **plaintext file**, not an encrypted keychain. Do not commit it.
Credential symlinks and files readable by other users are rejected. Environment
credentials are supported on other platforms; saving keys is currently limited
to macOS/Linux.

Run `tress setup` again to change your model or replace the saved key. Enter
keeps an existing key. An existing `ANTHROPIC_API_KEY` is never copied to disk
unless you explicitly supply a key, and it continues to override saved keys.
To remove a saved credential, delete that personal `credentials.json` file.

For automation, prefer an environment variable from your secret manager.
To save a key without a terminal, pipe your secret manager's output into:

```sh
# Feed only the key on stdin, optionally followed by a newline.
tress setup --key-stdin --model claude-sonnet-5
```

There is no API-key command-line argument, so keys do not appear in process
arguments. Setup validates input before saving and atomically replaces each
file. Ctrl-C or Escape during hidden key entry cancels without saving.

## Diagnose setup

```sh
tress doctor                # local checks only; no network call
tress doctor --check-api    # also check access to the configured model
```

The optional network check calls the
[Anthropic Models API](https://platform.claude.com/docs/en/api/http/models/retrieve).
It does not generate a completion or run tools. A successful check confirms
model metadata access, not that every generation request will succeed.

- **No key:** run `tress setup` or set `ANTHROPIC_API_KEY`.
- **401/403:** check the key and your account's model access. An environment key
  takes priority even after replacing the saved key.
- **404/405:** check the model ID. A compatible proxy may support Messages but
  not the Models API; this check cannot confirm that proxy's model access.
- **Unexpected response / redirect:** check the configured API base URL.
- **Invalid configuration:** fix the reported file; `--help` remains available.
- **Wrong effective model:** `tress config` identifies the overriding source.

## Join the web demo

The web demo supplies its own model configuration. Joining it does not require
local setup or a personal API key:

```sh
tress attach https://tress-theta.vercel.app -s <session-id>
tress attach https://tress-theta.vercel.app -s <session-id> --ui
```

Copy the session ID from the site to use the same thread and workspace.
The attached terminal operates on the **host's** files, not its local directory.
Native CLI settings do not reconfigure that host. See the
[demo host guide](../site/README.md) for Harness, storage, and workspace adapters.
