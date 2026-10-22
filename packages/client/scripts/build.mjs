import { build } from "esbuild";
import { mkdir, rm, copyFile, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";

await rm("dist", { recursive: true, force: true });

// Keep the established site UI as the source of truth, not a second design.
await mkdir("src/generated/terminal", { recursive: true });
for (const path of [
  "Markdown.tsx",
  "CopyButton.tsx",
  "SourcePane.tsx",
  "TressWordmark.tsx",
  "terminal/Badge.tsx",
  "terminal/Spinner.tsx",
  "terminal/ToolCall.tsx",
  "terminal/TerminalIcon.tsx",
  "terminal/KeyboardShortcuts.tsx",
])
  await copyFile(`../../site/src/components/${path}`, `src/generated/${path}`);
await copyFile("../../site/src/components/terminal/LICENSE", "LICENSE.termcn");
await copyFile("../../LICENSE", "LICENSE");
const types = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"],
  { stdio: "inherit" },
);
if (types.status !== 0) process.exit(types.status ?? 1);
await build({
  entryPoints: ["src/index.ts", "src/react.tsx"],
  outdir: "dist",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  jsx: "automatic",
  external: ["react", "react/jsx-runtime"],
  // Harness runs in a standalone Tap root; its headless entry needs no React.
  alias: {
    "@assistant-ui/tap/react-shim": "@assistant-ui/tap/standalone-shim",
  },
  banner: { js: '"use client";' },
});
const css = postcss.parse(
  await readFile("../../site/src/app/globals.css", "utf8"),
);
css.walkAtRules("import", (rule) => rule.remove());
// Animation names are global even when their selectors are scoped.
const animations = new Map();
css.walkAtRules(/keyframes$/, (rule) => {
  const name = rule.params;
  const scoped = `tress-client-${name}`;
  animations.set(name, scoped);
  rule.params = scoped;
});
css.walkDecls(/^animation(?:-name)?$/, (decl) => {
  decl.value = decl.value
    .split(/(\s+|,)/)
    .map((part) => animations.get(part) ?? part)
    .join("");
});
css.walkRules((rule) => {
  if (rule.parent.type === "atrule" && /keyframes$/.test(rule.parent.name))
    return;
  rule.selector = selectorParser((selectors) => {
    selectors.each((selector) => {
      const first = selector.nodes[0];
      if (
        (first.type === "pseudo" && first.value === ":root") ||
        (first.type === "tag" && ["body", "html"].includes(first.value))
      )
        first.replaceWith(selectorParser.className({ value: "tress-ui" }));
      else {
        selector.prepend(selectorParser.combinator({ value: " " }));
        selector.prepend(selectorParser.className({ value: "tress-ui" }));
      }
    });
  }).processSync(rule.selector);
});
await writeFile(
  "dist/styles.css",
  css.toString() + "\n" + (await readFile("src/embedded.css", "utf8")),
);
