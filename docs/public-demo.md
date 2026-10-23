# Run a managed Tress demo

There are two different setup paths. The **operator** deploys the Tress site and
provides its credentials once. A **visitor** opens that site and gets a private
thread ID automatically; they do not create a Harness account, install the SDK,
or supply a model or database key. The browser, an attached terminal, and an
optionally connected local folder are clients of the same site host.

```text
browser / tress attach
                 │ private session command
                 ▼
         Tress site (agent host) ── model provider
             │             │
             │             └── PostgreSQL: session, owner, file, and device metadata
             └── managed Harness: durable conversation
```

## Operator: create credentials

1. In the managed Harness admin dashboard, create a harness for this Tress
   deployment. Copy its origin (`https://<harness-id>.harness.assistant-api.com`)
   and mint a project API key. See the Harness SDK's
   [Harness Cloud setup](https://harness-sdk-docs-virid.vercel.app/docs/harness-cloud).
   Tress uses this key **on the server**, not in browser code or the CLI.
2. Create an Anthropic API key in the [Anthropic Console](https://console.anthropic.com/)
   for the model calls. This is separate from the
   Harness key: Harness stores and shares the thread; the Tress host runs the
   agent and pays for inference. The current host expects `ANTHROPIC_API_KEY`.
   If the key is not scoped to a workspace, also configure
   `ANTHROPIC_WORKSPACE_ID` with the `wrkspc_...` ID from Anthropic's Workspaces
   settings. This is separate from `HARNESS_WORKSPACE`.
3. Provision a PostgreSQL database that the site can reach. The site uses it
   for visitor/session ownership, access-token hashes, usage limits, hosted
   virtual files, and connected-device jobs. Harness—not PostgreSQL—stores the
   managed conversation.

Keep all three secrets in the server environment. Never put them in a public
`VITE_` variable, browser bundle, repository, shared session URL, or visitor
instructions.

## Operator: run locally or deploy

For local development, follow the site's [build prerequisites](../site/README.md#run-locally),
then set these values in the ignored `site/.env.local` file:

```dotenv
ANTHROPIC_API_KEY=your-model-provider-key
HARNESS_API_KEY=your-harness-project-key
HARNESS_ORIGIN=https://your-harness-id.harness.assistant-api.com
HARNESS_WORKSPACE=tress-demo
TRESS_DATABASE_URL=postgresql://user:password@host/database
TRESS_THREAD_MODE=cloud
```

`HARNESS_WORKSPACE` is a stable workspace identifier for this deployment, not
the visitor's session ID. Set `HARNESS_ORIGIN` to **your** harness: the code's
fallback origin is only for the original demo. In the Harness dashboard, allow
localhost for local development. Then run from `site/`:

```sh
npm run db:migrate
npm run dev -- --port 5311
```

The migration creates the session and connected-device tables; it does not
create a visitor ID ahead of time. Each first visit creates its own ID. Open
`http://localhost:5311`, then use `/doctor` in the page to check storage,
model, and Harness connectivity.

For a public Vercel deployment, import this repository with **site** as the
root directory and enable files outside that root. Configure the same six
variables above as server-only environment variables, plus:

```dotenv
TRESS_SERVERLESS=1
TRESS_WORKSPACE=memory
PUBLIC_BACKEND_URL=https://your-tress-site.example/api/chat
```

Add that exact public HTTPS backend URL to the harness's allowed endpoints.
The checked-in Vercel build applies the PostgreSQL migrations when
`TRESS_DATABASE_URL` is set; both build and runtime must be able to reach the
database. See the [Vercel details](../site/README.md#vercel) for the serverless
limits.

## Visitor: use one thread from anywhere

1. Open the deployed Tress site without a shared session link. The first visit
   creates a new private thread and shows its 12-character **session ID** in
   the demo header. The browser
   keeps an HTTP-only owner cookie so it can select threads and manage connected
   devices. A new visitor gets a different thread and workspace.
2. [Install Tress](setup.md#install) to join that same conversation in a
   terminal, then copy the site's attach command. For example:

   ```sh
   tress attach https://your-tress-site.example -s <session-id> --ui
   ```

   Or save it for future terminal sessions:

   ```sh
   tress setup --host https://your-tress-site.example -s <session-id>
   tress
   ```

3. To let the site work on files on your computer or VM, build the
   [source-preview CLI](setup.md#install), open **connect folder**, and run its
   session command on that machine. To share only your current project:

   ```sh
   tress attach https://your-tress-site.example -s <session-id> --root . --ui
   ```

   The connection appears in the browser automatically and the same terminal
   opens the chat. There is no pairing form or code-entry step in the default
   demo. Use `--root <path>` for another folder; omitting it exposes the
   filesystem accessible to the terminal. Access is read-only unless you add
   `--allow-write`; `--chat-only` joins without sharing files. The connector
   exposes no shell and receives no Harness key. Keep the process running;
   exiting takes files offline while the conversation remains saved. Run the
   same command to reconnect. See [connected-folder permissions](connected-folder.md).

   The installer currently supplies v0.3.0, which joins chat but does not
   support this combined connection. Use the source build for file sharing.

The session ID is an **access capability**, not a login or a database
password. Anyone with the complete ID or browser link can join and steer that
thread, including using its connected folder while it is online. Do not post it
publicly. Updated `tress attach <site> -s <id>` commands can attach or replace a
machine directly using that capability. Leave `TRESS_SHOW_PAIRING` and
`TRESS_REQUIRE_PAIRING` unset or `0` for the demo's direct connection flow.
Set `TRESS_SHOW_PAIRING=1` to also offer the legacy pairing UI while keeping
modern session commands automatic. Set `TRESS_REQUIRE_PAIRING=1` to require a
browser-owner code for new connections; this always shows the form, regardless
of `TRESS_SHOW_PAIRING`. Restart or redeploy after changing these host settings.
See the [pairing configuration table](connected-folder.md#operator-setup).
Approving codes and disconnecting from the browser require
the owner cookie; sharing the ID does not transfer ownership. For a non-demo
product, add your own user authentication and authorization before treating
these anonymous sessions as private accounts.

For an automated terminal client, the operator can provide `TRESS_HOST` and a
private `TRESS_SESSION` in the environment, then run `tress` without interactive
setup. Do not put `HARNESS_API_KEY` on visitor devices: the site host holds it.
If a person instead exports only `ANTHROPIC_API_KEY` and runs `tress` with no
saved host, the native agent works in their current directory but that
conversation is standalone, not a managed Harness thread.

Internally, Tress also creates a UUID for each workspace and a distinct
managed Harness thread ID. PostgreSQL stores those IDs and only a **hash** of
the short attach ID. Neither the UUID nor the Harness thread ID is a substitute
for the private attach ID. Closing a browser or terminal does not delete the
thread; managed history stays in Harness, and the session mapping stays in
PostgreSQL. Demo access expires after seven days by default
(`TRESS_SESSION_TTL_HOURS=168`), even though the managed history is still
stored. Operators can change that limit; see the
[demo policy](../site/README.md#host-diagnostics-and-demo-limits).
