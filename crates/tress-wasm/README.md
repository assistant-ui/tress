# tress-wasm

Browser bindings for the tress agent core. The same `tress::Engine` the
terminal binary runs drives an in-memory workspace here and reaches the model
through the browser's own `fetch`.

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

The in-memory surface offers `read`, `write`, `edit`, and `ls` — no shell,
because a browser has none, and a surface advertises only what it can honor.

## Keys

Never ship an API key in a page. Point `url` at a proxy you control that adds
the auth header server-side; the dev server here is a minimal example.
