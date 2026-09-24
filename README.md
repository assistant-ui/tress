# tress

[![CI](https://github.com/assistant-ui/tress/actions/workflows/ci.yaml/badge.svg)](https://github.com/assistant-ui/tress/actions/workflows/ci.yaml)

A tiny coding agent that works in your project directory. One native binary, no background service, shell-style output.

```sh
export ANTHROPIC_API_KEY=...
tress                    # start a session here
tress ask "fix the failing test in parser.rs"
```

```
tress 0.1.0 · ~/oss/tress · claude-sonnet-5
/help for commands, ctrl-d to exit

❯ add a greet function in greet.py and check it runs
I'll add the greeting function.
  · write greet.py
  ● bash python3 -c 'import greet; print(greet.greet("tress"))' [y]es / [a]lways / [n]o y
Done — greet.py works, it printed "hello, tress".
```

## What it does

- **Five tools**: `read`, `write`, `edit`, `ls`, `bash`. File tools are scoped to the directory you started in and refuse paths that escape it.
- **You approve shell commands.** Every `bash` call asks before it runs; answer `a` to stop being asked for the rest of the session. With no terminal attached (a pipe, CI), gated calls are denied rather than silently run.
- **Streaming**: replies appear as they are generated; tool activity stays inline in the transcript.

## Status

Early. The engine is a library (`tress::Engine`) driving a `Provider` over a `Tools` surface, with terminal I/O kept out of the core — so the same engine is meant to back a browser (wasm) build and embedded hosts, and to attach its session to a [statewire](https://github.com/assistant-ui/statewire-rs) thread so a session can be watched and steered from anywhere. Neither of those has landed yet.

## Configuration

| Variable | Meaning |
| --- | --- |
| `ANTHROPIC_API_KEY` | Required. |
| `TRESS_MODEL` | Model id; defaults to `claude-sonnet-5`. |
| `ANTHROPIC_BASE_URL` | Override the API endpoint (used by the tests' mock server). |

## Develop

```sh
cargo test
cargo clippy --all-targets
cargo fmt --check
```

The end-to-end tests run the real binary against a scripted mock of the Messages API, so the HTTP path, SSE parsing, tool loop, and approval gate are all covered without a key.
