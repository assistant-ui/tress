import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { currentPlatform, platforms } from "../lib/platform.mjs";
import { packageRelease, releaseVersion } from "../../../scripts/package-npm.mjs";

const exec = promisify(execFile);
const fixture = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--exit') process.exit(17);
if (args[0] === '--wait') {
  console.log('READY ' + process.pid);
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({args, cwd: process.cwd(), marker: process.env.TRESS_NPM_TEST, stdin: fs.readFileSync(0, 'utf8')}));
}
`;

function run(command, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}

async function environment(t, nativeBinary) {
  const directory = await mkdtemp(join(tmpdir(), "tress-npm-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key) && !["NODE_AUTH_TOKEN", "NPM_TOKEN"].includes(key)));
  await writeFile(join(directory, "npmrc"), "");
  await writeFile(join(directory, "global-npmrc"), "");
  Object.assign(env, {
    npm_config_userconfig: join(directory, "npmrc"),
    npm_config_globalconfig: join(directory, "global-npmrc"),
    npm_config_cache: join(directory, "cache"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_ignore_scripts: "true",
  });
  const artifactsDir = join(directory, "artifacts");
  const outputDir = join(directory, "packages");
  await mkdir(artifactsDir);
  for (const platform of platforms) {
    const path = join(artifactsDir, `tress-${platform.target}`);
    if (nativeBinary && platform.name === currentPlatform().name) await copyFile(nativeBinary, path);
    else await writeFile(path, fixture);
  }
  const version = nativeBinary ? await releaseVersion() : "0.0.0-test";
  const packages = await packageRelease({ artifactsDir, outputDir, version, env });
  env.npm_config_cache = join(directory, "install-cache");
  const manifests = new Map();
  for (const pkg of packages) {
    const platform = platforms.find(({ name }) => name === pkg.name);
    const path = platform ? `${platform.os}-${platform.cpu}` : "cli";
    manifests.set(pkg.name, JSON.parse(await readFile(join(outputDir, path, "package.json"), "utf8")));
  }
  const downloaded = [];
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname).slice(1);
    const pkg = packages.find((entry) => path === entry.name || path === `tarballs/${entry.filename}`);
    if (!pkg) { res.writeHead(404); res.end(JSON.stringify({ error: "not_found" })); return; }
    if (path.startsWith("tarballs/")) {
      downloaded.push(pkg.name);
      res.end(await readFile(join(outputDir, pkg.filename)));
      return;
    }
    const manifest = manifests.get(pkg.name);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      name: pkg.name,
      "dist-tags": { latest: version },
      versions: { [version]: { ...manifest, dist: { integrity: pkg.integrity, tarball: `${registry}/tarballs/${pkg.filename}` } } },
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const registry = `http://127.0.0.1:${server.address().port}`;
  env.npm_config_registry = registry;
  const prefix = join(directory, "global");
  const cwd = join(directory, "project with spaces");
  await mkdir(cwd);
  await exec("npm", ["install", "--global", "--prefix", prefix, "--include=optional", `@assistant-ui/tress@${version}`], { env, cwd });
  const binary = join(prefix, "bin/tress");
  const modules = join(prefix, "lib/node_modules");
  return { directory, outputDir, artifactsDir, packages, manifests, version, env, cwd, prefix, binary, modules, downloaded, server };
}

test("rejects unsupported systems and maps Linux to static musl binaries", () => {
  assert.throws(() => currentPlatform("win32", "x64"), /WSL/);
  assert.throws(() => currentPlatform("linux", "ia32"), /Unsupported platform/);
  assert.match(currentPlatform("linux", "arm64").target, /linux-musl$/);
});

test("global npm installation selects one binary and preserves the process contract", { timeout: 120_000 }, async (t) => {
  const setup = await environment(t);
  const { binary, cwd, env, modules } = setup;
  const result = await run(binary, ["attach", "a host with spaces", "-s", "$(not-a-shell)", "--root", cwd], { cwd, env: { ...env, TRESS_NPM_TEST: "inherited" }, input: "terminal input\n" });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    args: ["attach", "a host with spaces", "-s", "$(not-a-shell)", "--root", cwd],
    cwd: await realpath(cwd),
    marker: "inherited", stdin: "terminal input\n",
  });
  assert.deepEqual(new Set(setup.downloaded), new Set(["@assistant-ui/tress", currentPlatform().name]));
  assert.equal((await run(binary, ["--exit"], { env, cwd })).code, 17);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const child = spawn(binary, ["--wait"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const closed = once(child, "close");
    const [output] = await once(child.stdout, "data");
    assert.match(output.toString(), /^READY \d+/);
    const nativePid = Number(output.toString().trim().split(" ")[1]);
    child.kill(signal);
    assert.deepEqual(await closed, [null, signal]);
    assert.throws(() => process.kill(nativePid, 0), { code: "ESRCH" });
  }

  // A mismatched optional dependency must never execute a different release.
  const nativeDir = dirname(createRequire(join(modules, "@assistant-ui/tress/bin/tress.mjs")).resolve(`${currentPlatform().name}/package.json`));
  const manifestPath = join(nativeDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version: "99.0.0" }));
  const mismatch = await run(binary, [], { cwd, env });
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /found 99\.0\.0/);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await rm(join(nativeDir, "bin/tress"));
  const absentBinary = await run(binary, [], { cwd, env });
  assert.equal(absentBinary.code, 1);
  assert.match(absentBinary.stderr, /Could not start the native client/);
  await rm(nativeDir, { recursive: true });
  const missing = await run(binary, [], { cwd, env });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /--include=optional/);

  await assert.rejects(packageRelease({ artifactsDir: setup.artifactsDir, outputDir: setup.outputDir, version: setup.version, env }), { code: "EEXIST" });
  await rm(join(setup.artifactsDir, `tress-${platforms[0].target}`));
  await assert.rejects(packageRelease({ artifactsDir: setup.artifactsDir, outputDir: join(setup.directory, "incomplete"), version: setup.version, env }), { code: "ENOENT" });
});

test("npx installs from scratch with scripts disabled and can rerun offline", { timeout: 120_000 }, async (t) => {
  const setup = await environment(t);
  const env = { ...setup.env, npm_config_cache: join(setup.directory, "npx-cache") };
  const args = ["--yes", `@assistant-ui/tress@${setup.version}`, "attach", "https://example.test", "--chat-only"];
  const first = await run("npx", args, { env, cwd: setup.cwd });
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout).args, args.slice(2));
  await new Promise((done) => { setup.server.closeAllConnections(); setup.server.close(done); });
  const offline = await run("npx", ["--offline", ...args], { env, cwd: setup.cwd });
  assert.equal(offline.code, 0, offline.stderr);
});

test("npm and npx run the actual compiled Tress client", { skip: !process.env.TRESS_TEST_BINARY, timeout: 120_000 }, async (t) => {
  const native = resolve(process.env.TRESS_TEST_BINARY);
  const setup = await environment(t, native);
  const expected = (await exec(native, ["--version"])).stdout;
  assert.equal(expected.trim(), `tress ${setup.version}`);
  const global = await run(setup.binary, ["--version"], { cwd: setup.cwd, env: setup.env });
  assert.equal(global.code, 0, global.stderr);
  assert.equal(global.stdout, expected);
  const npx = await run("npx", ["--yes", `@assistant-ui/tress@${setup.version}`, "--version"], { cwd: setup.cwd, env: setup.env });
  assert.equal(npx.code, 0, npx.stderr);
  assert.equal(npx.stdout, expected);
  const help = await run(setup.binary, ["--help"], { cwd: setup.cwd, env: setup.env });
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /--root/);
  assert.match(help.stdout, /--ui/);
  const ptyCheck = fileURLToPath(new URL("../../../scripts/test-setup-pty.py", import.meta.url));
  await exec("python3", [ptyCheck, setup.binary], { cwd: setup.cwd, env: setup.env, timeout: 60_000 });
});
