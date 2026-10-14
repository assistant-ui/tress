# Existing assistant-ui app + Tress

A runnable source preview of one assistant-ui browser and a native Tress
terminal sharing a server-owned Harness thread. The included agent echoes
messages so the complete flow needs no model key. `AGENT_MODULE` can replace it
with your existing AI SDK agent, in process; no chat-backend URL is required.

## Run locally

Requires Node 24+, npm, and stable Rust. From the repository root:

```sh
cargo build --locked -p tress
npm --prefix examples/existing-app ci
npm --prefix examples/existing-app run build
cd examples/existing-app
APP_PASSWORD=local-example-password PUBLIC_ORIGIN=http://localhost:3000 npm start
```

Open <http://localhost:3000>, sign in with that example password, and send a
message. Select **Download terminal credential**. In a second terminal, use
the built binary and the downloaded file (adjust both paths to your checkout
and download directory):

```sh
chmod 600 ~/Downloads/app-headers.json
/path/to/tress/target/debug/tress attach http://localhost:3000/api/threads/main \
  --headers-file ~/Downloads/app-headers.json
```

Both clients show the same replies. `/exit` detaches the terminal while a run
continues. The app's **Revoke** button ends that terminal grant immediately;
the browser remains connected. Grants last one hour. Reattach with a new file
after expiry or revocation.

For frontend development, use `npm run dev` instead of `npm start` with the
same environment. For a terminal-first session, obtain a grant through the
app's supported flow, attach to the known endpoint, and open the browser later.
This preview does not create threads or launch a generic browser login from
the CLI. It provides one existing thread, `main`.

## Use your agent

Export your existing AI SDK agent as the default export of a server module:

```js
// agent.mjs — use your application's actual import and agent configuration.
import { agent } from "./your-application/agent.mjs";
export default agent;
```

```sh
APP_PASSWORD=local-example-password \
PUBLIC_ORIGIN=http://localhost:3000 \
AGENT_MODULE=./agent.mjs npm start
```

The server wraps that agent with `DirectChatTransport` and `AISDKTransport`.
Model credentials and tools stay in the application. Attaching Tress does not
give the agent access to the terminal machine's files or shell.

## Adapt to your application

- `server.mjs` composes the Harness host, persistent snapshots, and access
  adapter. Reuse an existing server-owned host when you have one.
- `src/main.jsx` uses assistant-ui components with `HarnessThread` and
  `StatewireHttp`, then adds credential download and revocation controls.
- `../../packages/access` authorizes streams and commands with your callback.
  It binds commands to their authorized stream and closes revoked or expired
  connections. Your app owns grant issuance, storage, and cross-worker fanout.

The password login is a **single-owner demonstration**, not a production
identity provider. Replace it with your app's authentication and per-thread
authorization, including its login rate limits. Keep separate IDs for browser
sessions and terminal grants. The JSON snapshot/grant store supports one
process; use your durable storage and owner routing for larger deployments.

## Production configuration

Build the frontend, run the Node host under your process supervisor, and route
your HTTPS domain to it with stream buffering disabled. Configure:

| Variable | Purpose |
| --- | --- |
| `PUBLIC_ORIGIN` | Canonical app origin, e.g. `https://chat.example.com`; used for links and same-origin checks. |
| `HOST`, `PORT` | Listening interface and port; defaults `127.0.0.1:3000`. |
| `DATA_DIR` | Durable, private data directory; defaults `.data` relative to this example. |
| `AGENT_MODULE` | Optional server module exporting the existing AI SDK agent. |
| `APP_PASSWORD` | Required only by the demonstration login; replace that login for real users. |

Use HTTPS externally and mount persistent storage. `PUBLIC_ORIGIN` does not
register DNS or expose a server automatically. The terminal connects to the
explicit endpoint copied from the app. See the [production guide](../../site/docs/production.mdx).

## Verify

```sh
# From the repository root, after building the CLI and example:
npm --prefix packages/access test
npm --prefix examples/existing-app test
```

The integration test uses a real native binary and Harness browser client
through an HTTP streaming proxy. It covers messages in both directions, a run
surviving terminal exit, one-shot prompts, live revocation, browser continuity,
and restart persistence. It uses the echo agent; repeat the production guide's
checks with your own agent and real HTTPS deployment before rollout.

The preview dependencies are pinned in the lockfile and vendored archives;
no sibling Harness checkout is required. See [provenance](../../site/vendor/README.md).
