import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const env = { ...process.env, FARM_DEPLOY_TARGET: "vercel" };
const run = (command, args) => {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

// Vercel builds from GitHub, including the Rust/Wasm source, without checking
// generated bindings or a developer's local build output into the repository.
if (spawnSync("rustup", ["--version"], { stdio: "ignore" }).status !== 0) {
  const cache = resolve(".vercel/cache/rust");
  mkdirSync(cache, { recursive: true });
  env.CARGO_HOME = resolve(cache, "cargo");
  env.RUSTUP_HOME = resolve(cache, "rustup");
  env.PATH = `${env.CARGO_HOME}/bin:${env.PATH}`;
  if (!existsSync(`${env.CARGO_HOME}/bin/rustup`)) {
    const response = await fetch("https://sh.rustup.rs");
    if (!response.ok)
      throw new Error(`Rust installer download failed: ${response.status}`);
    const script = resolve(cache, "rustup-init.sh");
    writeFileSync(script, await response.text());
    run("sh", [
      script,
      "-y",
      "--profile",
      "minimal",
      "--default-toolchain",
      "stable",
      "--no-modify-path",
    ]);
  }
}
run("rustup", ["target", "add", "wasm32-unknown-unknown"]);
const entry = readFileSync("../Cargo.lock", "utf8")
  .split("[[package]]")
  .find((entry) => /^name = "wasm-bindgen"$/m.test(entry));
const version = entry?.match(/^version = "([^"]+)"$/m)?.[1];
if (!version) throw new Error("wasm-bindgen is missing from Cargo.lock");
const installed = spawnSync("wasm-bindgen", ["--version"], {
  env,
  encoding: "utf8",
});
if (
  installed.status !== 0 ||
  installed.stdout.trim() !== `wasm-bindgen ${version}`
)
  run("cargo", [
    "install",
    "wasm-bindgen-cli",
    "--locked",
    "--version",
    version,
  ]);
run("npm", ["--prefix", "../packages/workspaces", "run", "build"]);
run(process.execPath, ["scripts/build-wasm.mjs"]);
if (env.TRESS_DATABASE_URL) run(process.execPath, ["scripts/migrate.mjs"]);
run(process.execPath, ["node_modules/@farm.js/cli/bin/farm.js", "build"]);
