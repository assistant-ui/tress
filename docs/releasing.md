# Release the CLI

The website installer downloads the latest GitHub release. Merging code into
`main` deploys the site but does not update the downloadable CLI. Publishing
the CLI requires a version tag and a successful **Release CLI** workflow.
The same workflow prepares npm packages from those exact binaries. npm
publication is separately enabled after the one-time setup below.

## Prepare

1. Update `workspace.package.version` in `Cargo.toml`, then run `cargo check`
   to update the workspace package entries in `Cargo.lock`. Update the setup
   guide with any migration instructions.
2. Run `node --test site/scripts/install.test.mjs`, `cargo test --locked`,
   and `cargo build --locked --release -p tress`.
3. Check the executable that will be shipped with Python 3.11 or newer
   (CI uses 3.12; on older macOS setups, use `python3.11` below):

   ```sh
   python3 scripts/verify-cli-release.py target/release/tress
   python3 scripts/test-setup-pty.py target/release/tress
   TRESS_TEST_BINARY="$PWD/target/release/tress" npm --prefix packages/cli test
   ```

   These checks use temporary homes, a loopback mock host, and fake keys. They
   verify the version, hosted defaults, setup, private storage, diagnostics,
   and terminal key entry without calling a model or changing your settings.
   The npm tests use a temporary loopback registry and isolated install/cache
   directories. They cover global installation, fresh npx execution, offline
   reuse, argument/stdin forwarding, exit codes, signals, missing dependencies,
   and execution of the compiled binary. No npm account is needed for testing.
4. Build the site and verify the actual release binary against the host:

   ```sh
   npm --prefix site run build
   TRESS_TEST_BINARY="$PWD/target/release/tress" npm --prefix site run test:host
   ```

   The connected-folder check pairs from the process's current directory,
   verifies read-only tools, then reconnects with writes enabled and verifies
   read/edit/read-back on disk. Its model responses are scripted.
5. With credentials for the intended Vercel project, run the opt-in live
   sandbox check (this creates a short-lived, billable sandbox):

   ```sh
   TRESS_TEST_BINARY="$PWD/target/release/tress" npm --prefix site run test:sandbox:live
   ```

   This requires sandbox authentication, such as `VERCEL_OIDC_TOKEN`. It
   checks real sandbox file I/O and Node execution through the built host,
   plus shared turns and file previews between a browser-protocol client and
   the native terminal. Model responses are scripted. The sandbox is stopped
   in cleanup and has a five-minute timeout.
6. In the production browser, create a disposable thread, attach the release
   candidate from a terminal, and pair a temporary folder with
   `tress connect --site https://tress-theta.vercel.app --allow-write`.
   Ask the agent to edit a test file from the browser, verify its contents on
   disk, then send a terminal follow-up and verify it in the browser. Reload
   the browser to check conversation persistence. Disconnect the folder and
   terminal when finished. This exercises the real model and managed host.
7. Merge the release preparation PR once CI passes.

## Publish

From a clean checkout of the merged `main`, create and push a tag matching
`Cargo.toml`. Choose an unused version in the preparation step; do not reuse
the already published `v0.3.0` tag. From the approved release checkout:

```sh
git fetch origin main --tags
git switch --detach origin/main
tress_release_version=$(python3 -c 'import tomllib; print(tomllib.load(open("Cargo.toml", "rb"))["workspace"]["package"]["version"])')
git tag -a "v$tress_release_version" -m "tress v$tress_release_version"
git push origin "v$tress_release_version"
```

The workflow builds macOS and Linux binaries for ARM64 and x86-64. Each target
must pass tests and the checks above before the publish job creates a GitHub
release with four binaries and `SHA256SUMS`. A failed build leaves the previous
release as the installer's default. Fix a failed release without moving an
already published tag.

It also attaches five npm tarballs and `release.json`. Their versions and exact
optional-dependency pins come from `Cargo.toml`; there is no separate npm version
to bump. Each native build runner tests npm installation with its own binary.

After the workflow succeeds, verify `gh release view <new-tag>` lists the four
binaries, checksums, five npm tarballs, and manifest. Test the production
installer into a temporary directory:

```sh
tress_check_dir=$(mktemp -d)
curl -fsSL https://tress-theta.vercel.app/tress.sh | TRESS_INSTALL_DIR="$tress_check_dir" sh
"$tress_check_dir/tress" --version
python3 scripts/verify-cli-release.py "$tress_check_dir/tress"
```

Confirm that the version matches the release, then remove the temporary
directory. Confirm that the README, setup guide, and website identify the
released version. Installing the CLI alone does not create a
session or change credentials; `tress setup` is a separate user action.

## npm publication

The npm packages have not been published yet. Do not advertise npm commands as
available until the first registry installation has been verified. The source
`packages/cli/package.json` is deliberately private: publish the generated
tarballs, never the source directory. The release packager removes `private`
and development scripts and adds the release version and pinned dependencies.

The package names are:

- `@assistant-ui/tress`
- `@assistant-ui/tress-darwin-arm64`
- `@assistant-ui/tress-darwin-x64`
- `@assistant-ui/tress-linux-arm64`
- `@assistant-ui/tress-linux-x64`

For the first publication, an npm maintainer with permission to publish in the
`@assistant-ui` scope must download the five tarballs and `release.json` from
the approved release into an empty directory and run:

```sh
# Requires an authenticated npm maintainer; this publishes publicly.
node scripts/publish-npm.mjs /absolute/path/to/npm-release
```

The script verifies tarball integrity, publishes the four native packages
first, then publishes the wrapper. Re-running it skips identical versions
already in the registry; a version with different contents fails. Prereleases
use the `next` dist-tag, and stable releases use `latest`.

Configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
for **each** of the five packages: GitHub owner `assistant-ui`, repository
`tress`, workflow filename `release.yaml`, and permission to use `npm publish`.
The job uses Node 24/npm 11 and `id-token: write`; no long-lived publishing token
is stored in GitHub. Then set the repository Actions variable
`TRESS_NPM_PUBLISH=true`. Subsequent version tags publish to both channels.
Until enabled, GitHub releases continue normally and npm publication is skipped.
An npm failure does not undo a successful GitHub release; rerun the failed npm
job using the saved artifacts after resolving the error.

Verify the newly published version using an empty npm cache and temporary
prefix, then check it against the actual host using the steps above:

```sh
tress_npm_check=$(mktemp -d)
# Replace <version> with the approved release version.
npm install --global --prefix "$tress_npm_check/install" --cache "$tress_npm_check/cache" @assistant-ui/tress@<version>
"$tress_npm_check/install/bin/tress" --version
npm exec --yes --cache "$tress_npm_check/npx-cache" --package=@assistant-ui/tress@<version> -- tress --version
```

After the first successful public installation, remove the pending-publication
notes in the README and setup guide and enable npm in the website's install UI.
The shell installer remains available for users without Node.js.
