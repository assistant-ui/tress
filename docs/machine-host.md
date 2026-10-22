# Run Tress on your machine

**Source preview:** `tress serve` is implemented in this branch but is not in
the published v0.3.0 binary. Build this checkout first:

```sh
cargo install --locked --path crates/tress
tress setup --local
tress serve --root ./my-project --allow-write --allow-exec --open
```

The native process runs the agent and tools. Your browser sends requests and
shows the shared conversation, workspace files, text/image previews, and
downloads. Generated artifacts are ordinary files in `./my-project`. Model
credentials stay on the host. No Node server, database, or upload service is
needed for this mode.

`--allow-write` enables file creation and editing. `--allow-exec` separately
enables native shell commands, each requiring approval in the browser. Shell
commands run with the host user's permissions, including access outside the
project and the ability to write regardless of the file-tool setting. Omit
both flags for read-only file tools and no shell.

Use the private browser URL printed by the host. To join from a terminal built
from the same checkout, copy the browser's terminal command:

```sh
tress attach http://127.0.0.1:5311 -s <session-id> --chat-only
```

Both clients control the same agent and conversation. The terminal can send
prompts and read replies; file browsing and shell approvals use the browser.
One run is admitted at a time. Closing either client does not stop a run.
Keep the private URL and session ID private: either grants control of the
workspace with the permissions enabled by the operator.

## What survives restart

Files stay in the project directory. The host saves the submitted prompt
before acknowledging it and saves conversation/model history after each turn.
It keeps one conversation per project by default in
`$XDG_STATE_HOME/tress/hosts/<project-hash>`, or
`~/.local/state/tress/hosts/<project-hash>` when that variable is unset.
Use `--state-dir /private/path` to choose another location outside the project.
The state directory is private and locked against concurrent hosts.

Restart with the same project and state directory to restore the conversation
and session ID. Files can be edited on the machine and refreshed in the browser.
Clearing the conversation keeps files on disk. Back up the project and the
state directory together if you want to recover both artifacts and history.

If the process crashes during a turn, the next start reports the interrupted
request. Completed earlier turns and the submitted prompt remain saved; partial
model output may be lost. Files may already have changed, and an already-started shell subprocess may
continue after the host exits. The host does not
replay tools or automatically resume an interrupted turn. Reconnecting clients
read the current state and do not automatically resend unanswered commands.
If checkpoint storage fails, new runs are blocked until storage is repaired
and the host is restarted.

## Run on a VM or remote server

Install/build Tress on the machine that owns the files and model credentials,
then run the same command there, without `--open`:

```sh
tress serve --root /home/me/project --allow-write --allow-exec
```

From your laptop, forward its loopback port:

```sh
ssh -N -L 5311:127.0.0.1:5311 me@my-vm
```

Open the printed `http://127.0.0.1:5311/?session=...` URL on your laptop. The VM
executes work and stores the files; the laptop browser controls it. If port
5311 is occupied, choose another with `--listen 127.0.0.1:5312` and forward
that same port. The host accepts loopback listeners only and validates the
printed host/origin. Public URLs, multi-user authentication, background daemon
installation, and automatic VM provisioning are not included.

Use persistent disk for the project and state directory on a VM/container.
Ephemeral instance storage disappears with the instance. The browser can only
reach artifacts while the host and connection are available. Text previews
are limited to 1 MiB, downloads to 32 MiB, and directory listings to 1,000
entries. File browsing excludes symlinks and special files. Workspace HTML/SVG
is downloaded or shown as text, never executed on the authenticated host origin.

## Verification

```sh
cargo test
python3 scripts/test-machine-host.py target/debug/tress
```

The integration check starts the actual host with a scripted model. It covers
real artifact creation/download, a shared native terminal turn, checkpoint
restoration, approval/denial, client reconnection, process interruption,
read-only permissions, path boundaries, and storage failure.
