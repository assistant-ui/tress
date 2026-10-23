# Connect a computer or VM workspace

**Source preview:** combined `attach` file sharing below requires a CLI built
from this checkout. The installer currently provides v0.3.0, where `attach`
joins chat and `tress connect --site <url> --root .` shares a folder from a
separate terminal. See [installation and release compatibility](setup.md#install).

The site owns the model credentials and, in managed mode, the Harness credentials. `tress attach` does
not log into Harness, need an API key, or open an inbound port. It offers a filesystem
to the browser thread authorized by the session command. With the updated host
and CLI, no pairing code is needed by default. The host can opt into an extra
browser-owner approval with `TRESS_REQUIRE_PAIRING=1`.

This connection behavior is in the source preview; it requires an updated CLI
and host. Older clients and hosts retain their pairing-code flow.

## Visitor steps

1. Open the public site, create or select a thread, and choose **connect folder**.
2. Install the updated native `tress` binary. On the machine you want to access, run:

   ```sh
   tress attach https://your-tress-site.example -s YOUR_SESSION_ID --ui
   ```

   Copy the site and session from your browser chat. Without `--root`, this
   shares the filesystem root (`/` on macOS/Linux, the current drive root on
   Windows), subject to the process's OS permissions. Add `--root .` to share
   only the current folder, or `--root /path/to/project` for another folder.
   Access is read-only unless you add `--allow-write`. Use `--chat-only` to
   join the conversation without offering any filesystem. No native shell
   commands are exposed. Symlink paths and special files remain unavailable.

   Whole-filesystem access includes personal files readable by that process.
   The CLI prints the exact scope when connecting, and the browser labels it
   **Whole filesystem**. No file content is sent until a file is requested.
3. The session command connects the folder directly to that chat and opens the
   terminal UI. The default demo has one connection command and no pairing
   form, code to copy back, or browser approval step. The same process serves
   file requests. If your own host explicitly requires pairing, its connection
   panel instead shows a code form; those codes expire after five minutes.
   Omit `--ui` for plain terminal output. The browser shows the folder label,
   permissions, and actual online/offline state. The file browser opens with
   the real directory listing. Open subfolders and files, or use **Refresh**
   after an external change. **Ask about file** prepares a prompt; **Ask to edit**
   is available only when the connector permits writes. Send the prompt to run
   it through the agent's existing tools.
   On a VM, run the same command inside its project directory. The site address
   must be reachable from that VM; `localhost` refers to the VM itself.
4. Ask about or edit files in the same conversation from the browser or that
   terminal. `/exit`, `/disconnect`, or closing the process stops sharing;
   switching chats requires exiting first. The browser’s **disconnect** also stops local
   access. The managed conversation remains available when the device is
   offline, but local file operations will not silently switch to demo files.

The binary prints the exact canonical root when connecting. Whole-filesystem
connections accept absolute paths such as `/Users/mac/oss/riftri/README.md`;
folder-scoped connections require paths relative to that folder. It keeps a
revocable, thread-scoped device token in memory for that process only; it
does not save the token or the Harness project key. Restarting it currently
connects again using the session command; when the host requires pairing, it
requires a fresh code. Temporary network failures are retried while the
process stays open. Connected folders do not mirror the whole directory
to the site: the browser and agent request individual paths. Browser previews are loaded
on demand; selecting a file alone does not call the model. Agent tool output
may be sent to the model provider and stored in the conversation.

The thread owner cookie can approve a pairing code or disconnect a folder.
By default, a shared `-s` session command can also attach a machine or replace
the thread's connected machine, as well as join the conversation and use its
files. With `TRESS_REQUIRE_PAIRING=1`, attaching or replacing a machine additionally
requires the browser owner's approval. Session commands do not transfer browser
ownership or grant access to the owner's other threads. Treat the attach link as access to the
folder while the connector is online; do not share it with people you would
not trust with those files. Pairing a
second folder to the same thread revokes the first connection. Keep the
browser's owner cookie or use the site's existing private thread link to
retain conversation access; anonymous ownership cannot be recovered if the
owner cookie is lost.

## Operator setup

For the complete credential, database, and deployment flow, see the
[managed demo guide](public-demo.md).

Use managed Harness mode with an allowed public HTTPS `/api/chat` backend,
`HARNESS_API_KEY`, a model provider credential, and `TRESS_DATABASE_URL` on
the site server. Run the site's PostgreSQL migrations, including
`005_connected_devices.sql`, before enabling visitors. The project key must
never be sent to the browser or the native binary. The site routes scoped
read/list/write jobs through PostgreSQL; a long-running gateway service is
not required for this first version.

To require a short-lived pairing code for new session connections, set this on
the **host**, not on the user's terminal:

```dotenv
TRESS_REQUIRE_PAIRING=1
```

Unset it or use `0` for direct session attachment. The browser reflects the host
policy; the CLI cannot override a host that requires pairing. Existing connected
devices are not revoked by changing this setting; disconnect them separately.
Direct attachment still validates the session before creating a device, checks
that session on polling and results, and keeps file permissions and revocation.

Pairing also works with a long-running local thread host (`TRESS_THREAD_MODE=local`)
and a configured model; Harness Cloud is not needed for that setup.
New threads start without seeded example files. Folder attachment requires the
Tress site connection API and a session; application thread URLs without a Tress session (including
`--headers-file` connections) continue to use their application-owned workspace.
Plain `tress` and `tress ask` also use the saved host workspace; this default
filesystem sharing applies to the explicit `attach` command.

The older `tress connect --site <url> [--root <folder>] [--allow-write]` command
remains available for a folder-only process without terminal chat. It uses the
current directory by default. Because it has no session, it always uses a code
to select and authorize the destination browser thread. Its browser form is
available on hosts configured with `TRESS_REQUIRE_PAIRING=1`. The default demo
does not show this legacy flow. Use the updated session-scoped `attach` command
for its one-command connection. Published v0.3.0 still joins chat, but needs an
upgrade to the source-preview CLI for combined chat and file sharing.

For local development without PostgreSQL, the connector store is in memory.
It resets when the dev server restarts, so reconnect after a
restart. Public deployments should use PostgreSQL, HTTPS, request-rate
limits, and the site's existing session/run quotas. One connector currently
serves one thread; the binary polls approximately once per second. A file
operation times out after 60 seconds and a write is **never** automatically
retried, because it may have completed on the device before the connection
failed.
