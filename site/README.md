# tress site

The marketing site, built with [Farm.js](https://farmjs.dev). The demo on the
page is the real agent: `crates/tress-wasm` compiled to WebAssembly, running
in the visitor's tab against an in-memory workspace.

## Run it

```sh
npm install
npm run dev
```

Open <http://localhost:5311>.

## The demo's two modes

The page posts to `/api/messages`, a server route that decides what happens:

| `ANTHROPIC_API_KEY` | Behavior |
| --- | --- |
| set | Forwards to Anthropic. The agent is live and the header reads **live model**. |
| unset | Replays a recorded session so a static deploy still works. The header reads **recorded session**. |

The key stays on the server either way, so nothing ships to the client.

## Rebuilding the wasm

`public/pkg` is generated. After changing the Rust:

```sh
npm run wasm
```

That runs the release build and `wasm-bindgen`, writing the glue and the
`.wasm` into `public/pkg`. It needs the `wasm32-unknown-unknown` target and
`wasm-bindgen-cli`.
