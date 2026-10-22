import { build } from "esbuild";
import { cp, mkdir, writeFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/cli.mjs"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/host.mjs",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
await build({
  entryPoints: ["src/browser.mjs"],
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile: "dist/browser.js",
});
await cp("../../site/src/server/pkg-node", "dist/wasm", { recursive: true });
await writeFile("dist/wasm/package.json", '{"type":"commonjs"}\n');
