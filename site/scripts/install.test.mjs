import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const installer = fileURLToPath(new URL("../public/tress.sh", import.meta.url));
const binary = "#!/bin/sh\nprintf 'tress fixture --session <id>\\n'\n";
const checksum = createHash("sha256").update(binary).digest("hex");
const repository = "https://github.com/assistant-ui/tress";

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "tress installer "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "tools");
  const destination = join(root, "install destination");
  await mkdir(bin);
  await mkdir(destination);
  await writeFile(join(destination, "tress"), "previous installation");
  // Deliberately exclude the real curl and cargo: these tests cannot download
  // software or modify the developer's actual installation.
  for (const tool of ["awk", "chmod", "cp", "mkdir", "mktemp", "mv", "rm", "sha256sum", "shasum"]) {
    const found = spawnSync("which", [tool], { encoding: "utf8" });
    if (found.status === 0) await symlink(found.stdout.trim(), join(bin, tool));
  }
  const mock = async (name, script) => {
    const path = join(bin, name);
    await writeFile(path, `#!${process.execPath}\n${script}\n`);
    await chmod(path, 0o755);
  };
  await mock("uname", `console.log(process.argv[2] === '-s' ? process.env.TEST_OS : process.env.TEST_ARCH);`);
  await mock("curl", `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const url = args.find(arg => arg.startsWith('https://'));
    fs.appendFileSync(process.env.TEST_REQUESTS, url + '\\n');
    if (process.env.TEST_MODE === 'offline') process.exit(7);
    if (url === '${repository}/releases/latest') {
      process.stdout.write(process.env.TEST_MODE === 'unreleased'
        ? '404 ' + url : '200 ${repository}/releases/tag/v0.1.0');
    } else if (url === '${repository}/releases/download/v0.1.0/SHA256SUMS') {
      const hash = process.env.TEST_MODE === 'corrupt' ? '0'.repeat(64) : '${checksum}';
      fs.writeFileSync(args[args.indexOf('--output') + 1], hash + '  ' + process.env.TEST_ASSET + '\\n');
    } else if (url === '${repository}/releases/download/v0.1.0/' + process.env.TEST_ASSET) {
      if (process.env.TEST_MODE === 'missing') process.exit(22);
      fs.writeFileSync(args[args.indexOf('--output') + 1], ${JSON.stringify(binary)});
    } else throw new Error('Unexpected URL: ' + url);
  `);
  if (options.cargo) {
    await mock("cargo", `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.writeFileSync(process.env.TEST_CARGO_ARGS, JSON.stringify(args));
      const root = args[args.indexOf('--root') + 1];
      fs.mkdirSync(root + '/bin', {recursive:true});
      fs.writeFileSync(root + '/bin/tress', process.env.TEST_OLD_CLI === '1'
        ? "#!/bin/sh\\nprintf 'old tress without sessions\\\\n'\\n"
        : ${JSON.stringify(binary)});
    `);
  }
  const env = {
    PATH: bin,
    HOME: root,
    TMPDIR: root,
    TRESS_INSTALL_DIR: destination,
    TEST_OS: options.os ?? "Darwin",
    TEST_ARCH: options.arch ?? "arm64",
    TEST_ASSET: options.asset ?? "tress-aarch64-apple-darwin",
    TEST_MODE: options.mode ?? "released",
    TEST_OLD_CLI: options.oldCli ? "1" : "0",
    TEST_REQUESTS: join(root, "requests"),
    TEST_CARGO_ARGS: join(root, "cargo-args"),
    ...(options.version ? { TRESS_VERSION: options.version } : {}),
  };
  return {
    run: () => spawnSync("/bin/sh", [installer], { env, encoding: "utf8" }),
    installed: () => readFile(join(destination, "tress"), "utf8"),
    requests: () => readFile(env.TEST_REQUESTS, "utf8"),
    cargoArgs: async () => JSON.parse(await readFile(env.TEST_CARGO_ARGS, "utf8")),
  };
}

for (const [os, arch, target] of [
  ["Darwin", "arm64", "aarch64-apple-darwin"],
  ["Darwin", "x86_64", "x86_64-apple-darwin"],
  ["Linux", "aarch64", "aarch64-unknown-linux-musl"],
  ["Linux", "x86_64", "x86_64-unknown-linux-musl"],
]) {
  test(`installs the verified ${target} release without Cargo`, async (t) => {
    const f = await fixture(t, { os, arch, asset: `tress-${target}` });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await f.installed(), binary);
    assert.match(result.stdout, /Installed tress/);
    assert.match(await f.requests(), new RegExp(`/v0.1.0/tress-${target}`));
  });
}

test("a pinned release does not resolve latest", async (t) => {
  const f = await fixture(t, { version: "v0.1.0" });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(await f.requests(), /releases\/latest/);
});

test("before the first release, builds merged main in a temporary Cargo root", async (t) => {
  const f = await fixture(t, { mode: "unreleased", cargo: true });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await f.installed(), binary);
  const args = await f.cargoArgs();
  assert.deepEqual(args.slice(0, 6), ["install", "--locked", "--git", repository, "--branch", "main"]);
  assert.equal(args[6], "--root");
  assert.match(args[7], /tress-install\.[^/]+\/source$/);
  assert.equal(args[8], "tress");
});

test("an older source build cannot replace a CLI that supports demo sessions", async (t) => {
  const f = await fixture(t, { mode: "unreleased", cargo: true, oldCli: true });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not support demo sessions yet/);
  assert.equal(await f.installed(), "previous installation");
});

for (const [mode, message] of [
  ["unreleased", /No binary release is published yet/],
  ["corrupt", /Checksum mismatch/],
  ["missing", /Binary download failed/],
  ["offline", /Could not reach GitHub/],
]) {
  test(`${mode} fails clearly and preserves the previous installation`, async (t) => {
    const f = await fixture(t, { mode });
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.equal(await f.installed(), "previous installation");
  });
}

test("the script is valid POSIX shell and documents its options", () => {
  execFileSync("/bin/sh", ["-n", installer]);
  assert.match(execFileSync("/bin/sh", [installer, "--help"], { encoding: "utf8" }), /TRESS_INSTALL_DIR/);
});
