# Tress CLI

Connect a terminal to the same conversation as your assistant-ui application.
The application owns the agent, model credentials, and thread.

## Install a released version

```sh
npm install -g @assistant-ui/tress
tress setup
```

Or run without a global installation:

```sh
npx @assistant-ui/tress@latest setup
npx @assistant-ui/tress@latest attach https://your-app.example -s <session-id> --root . --ui
```

Use the host and session from your application. `--root .` shares the current
folder read-only; add `--allow-write` to allow edits. Omit `--root` to share the
filesystem available to your user, or pass `--chat-only` for no file access.
Application authentication and pairing still apply.

Requires Node.js 20 or newer. macOS and Linux are supported on ARM64 and x64;
on Windows, use WSL with Linux Node.js. npm installs the matching native
binary as an optional dependency. There is no Rust compilation, install
script, or runtime download. Keep optional dependencies enabled; installation
with `--ignore-scripts` is supported. Linux binaries use musl and also run on
glibc systems.

Upgrade with `npm install -g @assistant-ui/tress@latest`. Use an explicit version
in either command to pin a release. `tress --version` reports the native binary
version. Installation alone does not configure a host or change credentials.

## Working from this repository

The source package is private to prevent accidentally publishing it without
its native dependencies. The release packager reads the version from the root
`Cargo.toml` and generates five publishable packages from the four tested
release binaries. See [the release guide](https://github.com/assistant-ui/tress/blob/main/docs/releasing.md).

```sh
npm --prefix packages/cli test
TRESS_TEST_BINARY="$PWD/target/debug/tress" npm --prefix packages/cli test
node scripts/package-npm.mjs --artifacts dist --out target/npm
```
