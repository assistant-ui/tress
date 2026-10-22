# Add Tress to your application

Use Tress's existing terminal-style UI, or keep your own interface. Both connect
to a **server-owned Harness thread**. The host keeps the agent, model keys,
tools, durable conversation, and workspace files. Adding a client does not
create another agent or move files into the browser.

This package is a **source preview, not yet published to npm**. It includes
built JavaScript and TypeScript declarations. React is optional for the headless
client and required for the UI component.

## Install the preview

From a checkout of this branch, with Node 22+:

```sh
npm --prefix packages/client ci
npm --prefix packages/client run build
npm --prefix packages/client test
cd packages/client
npm pack
```

In your application, install the resulting tarball. It contains the compiled
client, UI, styles, and pinned Harness/Statewire runtime; consumers do not need
sibling checkouts or the vendored SDK archives:

```sh
npm install /path/to/tress/packages/client/tress-client-0.1.0.tgz
# React UI only, if your app does not already have React:
npm install react react-dom
```

## Use Tress's UI

If your application already exposes an authenticated Harness Statewire endpoint,
this is the complete browser integration:

```tsx
"use client";
import { TressThread } from "@tress/client/react";
import "@tress/client/styles.css";

export function Chat() {
  return <TressThread url="/api/threads/main" />;
}
```

Same-origin session cookies work automatically. Route the endpoint through your
application's existing login and per-thread authorization. In frameworks that
restrict global CSS imports, import the stylesheet in the root layout instead.
The stylesheet is scoped to `.tress-ui`, uses the original Tress design tokens,
and fetches no fonts or external theme files.

Already have a Harness instance? Reuse it directly:

```tsx
<TressThread client={existingHarness} />
```

The component subscribes to that instance and does **not** dispose it when
unmounted. With `url`, the component creates/disposes its own connection. Use a
stable `headers` object or callback when passing credentials. Refreshable user
credentials can be supplied on every request:

```tsx
// Define this outside your component, or memoize it.
const userHeaders = async () => ({ Authorization: `Bearer ${await getUserToken()}` });
<TressThread url="/api/threads/main" headers={userHeaders} />
```

Do not pass a model-provider key or Harness administrator key to the browser.
For managed Harness, keep those credentials on the application host/proxy and
point the client at the app's authorized endpoint. The same component works
with the machine host in [local/managed setup](../../docs/local-harness.md).

Optional props: `title`, `model`, `attachCommand`, `toolbar`, `className`, and
`workspace`. Provide `attachCommand` only after your application has an authorized
terminal connection flow; put credentials in a private headers file, not the
command. The component never invents a login, agent, or thread ID.

## Keep your existing UI

No React dependency or Tress stylesheet is needed:

```js
import { createTressClient } from "@tress/client";

const thread = createTressClient({ url: "/api/threads/main" });
const render = () => updateYourUI({
  messages: thread.messages,
  busy: thread.isBusy,
  loading: thread.isLoading,
  error: thread.error?.message ?? thread.transport.error?.message,
});
const unsubscribe = thread.subscribe(render);
render();

// From your send handler, after the connection is ready:
await thread.sendMessage("Continue the project");

// When your view closes:
unsubscribe();
thread.dispose();
```

`updateYourUI` is your application's render function. Disable sending while
`thread.isLoading`, `thread.isBusy`, or `thread.transport.status !== "connected"`.
In Node or another JavaScript runtime without `location`, use an absolute HTTP(S)
URL and your user authorization headers. The runtime must provide Fetch,
ReadableStream, and the Web APIs used by Harness. This is a JavaScript client;
it does not embed a JavaScript engine into the Rust CLI.

An existing assistant-ui/Harness integration can stay as it is. **Adding native
terminal access requires no browser UI replacement**: expose the authorized
thread endpoint and give the user its `tress attach` command and credentials.
The [existing-app example](../../examples/existing-app/README.md) demonstrates
both UIs and a terminal sharing that thread, including grant revocation.

## Optional host files

File controls appear only when you supply the host operations:

```tsx
import type { TressWorkspace } from "@tress/client/react";

const workspace: TressWorkspace = {
  label: "project",
  description: "Workspace on the application host",
  writable: true,
  shell: false,
  async list(path, signal) {
    const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`, { signal });
    if (!response.ok) throw new Error("Could not list host files");
    return response.json(); // [{ name: "README.md", type: "file" }]
  },
  async read(path, signal) {
    const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`, { signal });
    if (!response.ok) throw new Error("Could not read host file");
    return response.blob();
  },
};
<TressThread url="/api/threads/main" workspace={workspace} />
```

Keep this object stable. Your server must authorize and scope these operations
and enforce size limits. `writable` and `shell` describe server capabilities;
they grant no permissions. “Ask to edit” prepares a prompt for the existing
agent. Text previews are limited to 1 MiB; other files can be downloaded.

## If your app does not use Harness yet

A transient `/api/chat` response is not a durable thread endpoint. On the server,
wrap your **existing** AI SDK agent with `DirectChatTransport` and
`AISDKTransport`, mount a Harness Statewire host, configure durable storage,
and authorize its stream and command routes. You can reuse your existing
identity system. See the runnable [server integration](../../examples/existing-app/server.mjs)
and [setup guide](../../docs/setup.md); no new model or tool configuration is
needed just to add a client. An arbitrary chat backend cannot be made durable
by installing this frontend package alone.

## Maintenance

The build copies the shared visual components and scopes the stylesheet from
`site/src`, so the Tress UI remains the source of truth. Generated sources and
bundles are ignored by Git. React is an external peer to avoid shipping a second
React runtime. Bundlers following local file symlinks may need React deduplication
(the example's Vite config demonstrates it). Build before packing or consuming
from the checkout. The package intentionally has no publish command or registry
installation claim until release verification is complete.
