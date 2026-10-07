# Run a managed Tress demo

There are two different setup paths. The **operator** deploys the Tress site and
provides its credentials once. A **visitor** opens that site and gets a private
thread ID automatically; they do not create a Harness account, install the SDK,
or supply a model or database key. The browser, an attached terminal, and an
optionally paired local folder are clients of the same site host.

```text
browser / tress attach / tress connect
                 │ private thread ID / pairing code
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
   keeps an HTTP-only owner cookie so it can select threads and manage paired
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

3. To let the site work on files on your own computer, install Tress and run
   this **separate** command from a folder you choose:

   ```sh
   tress connect --site https://your-tress-site.example
   ```

   The current directory is used by default; optionally add `--root <path>`
   to choose another folder. Enter its short-lived pairing code in the
   browser thread's **connect folder** control. This is read-only unless you
   explicitly add `--allow-write`. The connector does not expose a shell or receive the
   Harness key. Keep its process running while you want that folder online;
   if it stops, the conversation survives but file access goes offline until
   you pair again. See [connected-folder permissions](connected-folder.md).

   `tress connect` is in the current source and PR, but not in the v0.2.1
   release. Until a release containing it is published, build this checkout
   with `cargo install --locked --path crates/tress`.

The session ID is an **access capability**, not a login or a database
password. Anyone with the complete ID or browser link can join and steer that
thread, including using its paired folder while it is online. Do not post it
publicly. Pairing and disconnecting a folder require the original browser's
owner cookie; sharing the ID does not transfer ownership. For a non-demo
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
