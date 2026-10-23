import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
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
  entryPoints: ["src/browser.tsx"],
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile: "dist/browser.js",
  jsx: "automatic",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  alias: {
    react: "./node_modules/react",
    "react-dom": "./node_modules/react-dom",
  },
});
await cp("../../site/src/server/pkg-node", "dist/wasm", { recursive: true });
await writeFile("dist/wasm/package.json", '{"type":"commonjs"}\n');
await writeFile(
  "dist/browser.css",
  (await readFile("../client/dist/styles.css", "utf8")) +
    `
body { margin: 0; background: #090909; }
.host-page { max-width: 1000px; margin: 0 auto; padding: 56px 24px; }
@media (max-width: 600px) { .host-page { padding: 16px 12px; } }
`,
);
