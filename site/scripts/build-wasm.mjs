import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// Farm loads bundler bindings; standalone Node consumers use CommonJS bindings.
const target = process.argv[2] ?? "bundler";
if (!["bundler", "nodejs"].includes(target))
  throw new Error(`Unsupported WASM target: ${target}`);
const output = target === "bundler" ? "src/wasm/pkg" : "src/server/pkg-node";
const cwd = new URL("../", import.meta.url);

for (const [command, args] of [
  [
    "cargo",
    [
      "build",
      "-p",
      "tress-wasm",
      "--target",
      "wasm32-unknown-unknown",
      "--release",
    ],
  ],
  [
    "wasm-bindgen",
    [
      "--target",
      target,
      "--out-dir",
      output,
      "../target/wasm32-unknown-unknown/release/tress_wasm.wasm",
    ],
  ],
]) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (target === "nodejs")
  writeFileSync(
    new URL(`${output}/package.json`, cwd),
    '{"type":"commonjs"}\n',
  );
