# Release the CLI

The website installer downloads the latest GitHub release. Merging code into
`main` deploys the site but does not update the downloadable CLI. Publishing
the CLI requires a version tag and a successful **Release CLI** workflow.

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
   ```

   These checks use temporary homes, a loopback mock host, and fake keys. They
   verify the version, hosted defaults, setup, private storage, diagnostics,
   and terminal key entry without calling a model or changing your settings.
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
`Cargo.toml`. For this release:

```sh
git fetch origin main --tags
git switch --detach origin/main
git tag -a v0.3.0 -m "tress v0.3.0"
git push origin v0.3.0
```

The workflow builds macOS and Linux binaries for ARM64 and x86-64. Each target
must pass tests and the checks above before the publish job creates a GitHub
release with four binaries and `SHA256SUMS`. A failed build leaves the previous
release as the installer's default. Fix a failed release without moving an
already published tag.

After the workflow succeeds, verify `gh release view v0.3.0` lists all five
assets. Test the production installer into a temporary directory:

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
