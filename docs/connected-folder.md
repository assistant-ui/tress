# Connect a local folder to the public demo

The site owns the model and managed Harness credentials. `tress connect` does
not log into Harness, need an API key, or open an inbound port. It offers one
folder to one browser-owned demo thread through a short-lived pairing code.

## Visitor steps

1. Open the public site, create or select a thread, and choose **connect folder**.
2. Install the native `tress` binary. In the directory you want to share, run:

   ```sh
   tress connect --site https://your-tress-site.example
   ```

   The current directory is used by default. `--root <path>` is optional and
   selects another folder. This grants read/list access only. To allow the
   agent to edit files inside that folder, add `--allow-write`. No native
   shell commands are exposed in connected-folder mode.
3. Enter the code printed by the binary in the browser's pairing form. The
   code expires after five minutes. The browser shows the folder label,
   permissions, and actual online/offline state.
4. Ask about or edit files in the same conversation from the browser or an
   attached terminal. Close the binary or use **disconnect** to stop local
   access. The managed conversation remains available when the device is
   offline, but local file operations will not silently switch to demo files.

The binary prints the exact canonical root before pairing. It keeps a
revocable, thread-scoped device token in memory for that process only; it
does not save the token or the Harness project key. Restarting it currently
requires a new pairing. Temporary network failures are retried while the
process stays open. Connected folders do not mirror the whole directory
to the site: the agent requests individual paths, and tool output may be sent
to the model provider and stored in the Harness conversation.

The thread owner cookie can pair or disconnect a folder. A shared `-s` thread
attach ID can join a conversation and ask the agent to use the connected
folder, but cannot manage its device. Treat the attach link as access to the
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

For local development without PostgreSQL, the connector store is in memory.
It resets when the dev server restarts, so reconnect and pair again after a
restart. Public deployments should use PostgreSQL, HTTPS, request-rate
limits, and the site's existing session/run quotas. One connector currently
serves one thread; the binary polls approximately once per second. A file
operation times out after 60 seconds and a write is **never** automatically
retried, because it may have completed on the device before the connection
failed.
