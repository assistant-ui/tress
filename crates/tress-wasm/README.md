# tress-wasm

Browser and Node bindings for the tress agent core. The same `tress::Engine`
the terminal binary runs reaches the model through the host's `fetch`.
`TressSession` supplies an in-memory workspace; `TressHostSession` delegates
asynchronous tools to your application.

## Build

```sh
cargo build -p tress-wasm --target wasm32-unknown-unknown --release
wasm-bindgen --target web --out-dir crates/tress-wasm/demo/pkg \
  target/wasm32-unknown-unknown/release/tress_wasm.wasm
```

That writes `demo/pkg/` (~312 KB of wasm, roughly 120 KB gzipped).

## Demo

```sh
node crates/tress-wasm/demo/serve.mjs 8080
```

Open <http://127.0.0.1:8080>. With `ANTHROPIC_API_KEY` exported the dev
server proxies to Anthropic; without one it replays a scripted stream, so the
demo runs offline.

## Using it

```js
import init, { TressSession } from "./pkg/tress_wasm.js";

await init();
const session = new TressSession(
  "/v1/messages",            // your proxy; the page never holds a key
  "claude-sonnet-5",
  {},                        // extra headers
  { "README.md": "# hello" } // seed files
);

await session.send("add a greet function in greet.py", (raw) => {
  const event = JSON.parse(raw);        // text | tool | tool_done | idle
  if (event.type === "text") process(event.text);
});

console.log(session.files());           // { path: contents }
```

The original in-memory surface offers `read`, `write`, `edit`, and `ls`.

## Host tools, local files, and sandboxes

`TressHostSession` takes `(url, model, headers, schemasJson, execute)`.
`execute(name, inputJson)` returns a promise of JSON text with
`{ content: string, is_error: boolean }`. The host enforces authorization before
executing tools. The engine waits for the result before its next model request.

Use [`@tress/workspaces`](../../packages/workspaces/README.md) for typed agent
bindings, just-bash, local disk/overlay adapters, remote sandbox adapters,
custom tools, and asynchronous approval policy. The site uses Farm's
`@farm.js/wasm` plugin with `wasm-bindgen --target bundler` bindings, generated
automatically before development and production builds. Import the generated
JS entry point; its WASM import initializes through the plugin. The site's
shared agent still runs on the Node host.

For standalone Node consumers, `npm --prefix site run wasm:node` generates
CommonJS bindings. The separate `--target web` demo above still uses `await init()`.

Host sessions expose `messages()`, `restoreMessages(json)`, and `setSystem(text)`.
Store trusted model checkpoints separately from workspace files. These methods
do not persist anything automatically or recover a half-completed tool call.

## Keys

Never ship an API key in a page. Point `url` at a proxy you control that adds
the auth header server-side; the dev server here is a minimal example.
