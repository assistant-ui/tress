import { defineConfig } from "@farm.js/core";
import { wasm } from "@farm.js/wasm";
import { withDocs } from "@farming-labs/farmjs/config";

export default withDocs(defineConfig({
  deploy:
    process.env.FARM_DEPLOY_TARGET === "vercel"
      ? { target: "vercel" }
      : undefined,
  plugins: [wasm()],
  images: { provider: "none" },
  // Browsers download text/markdown; source links should display as text.
  headers: () => [
    "/docs.md",
    "/docs/workspace.md",
    "/docs/embedding.md",
    "/docs/try.md",
    "/docs/existing-app.md",
    "/docs/authentication.md",
    "/docs/local.md",
    "/docs/production.md",
    "/docs/reference.md",
  ].map((source) => ({
    source,
    headers: [
      { key: "Content-Type", value: "text/plain; charset=utf-8" },
      { key: "Content-Disposition", value: "inline" },
      { key: "X-Content-Type-Options", value: "nosniff" },
    ],
  })),
  routeRules: {
    "/api/**": { runtime: "node", regions: ["iad1"], maxDuration: 300 },
  },
  vite: {
    plugins: [
      {
        name: "tress-docs-page-actions",
        enforce: "pre",
        // Add the shared control only to rendered MDX. The .md endpoint reads
        // the original source, keeping UI components out of copied Markdown.
        transform(source, id) {
          const path = id.split("?")[0].replaceAll("\\", "/");
          const docsRoot = `${process.cwd().replaceAll("\\", "/")}/docs/`;
          if (!path.startsWith(docsRoot) || !path.endsWith(".mdx")) return null;
          if (source.includes('import { DocsPageActions }')) return null;
          const slug = path.slice(docsRoot.length, -4).replace(/(^|\/)index$/, "");
          const href = `/docs${slug ? `/${slug}` : ""}.md`;
          const content = source.replace(
            /^(# .+)$/m,
            (_, title) => `${title}\n\n<DocsPageActions href=${JSON.stringify(href)} />`,
          );
          const code = content.replace(
            /^(---\r?\n[\s\S]*?\r?\n---\r?\n)/,
            '$1\nimport { DocsPageActions } from "/src/components/DocsPageActions.tsx";\n',
          );
          return { code, map: null };
        },
      },
      {
        name: "tress-wasm-initialization",
        // Farm's SSR build marks modules as side-effect-free. wasm-bindgen's
        // entry point must run to initialize the re-exported session classes.
        transform(code, id) {
          if (id.replaceAll("\\", "/").includes("/src/wasm/pkg/"))
            return { code, map: null, moduleSideEffects: true };
        },
      },
      {
        name: "tress-server-workspace-dependencies",
        config: () => ({
          ssr: {
            // Keep Harness, Statewire, and tap in Farm's React bundle. Leaving
            // them external creates runtime React imports outside that bundle.
            external: [
              "just-bash",
              "@vercel/sandbox",
              "pg",
            ],
          },
        }),
      },
    ],
  },
}), { codeBlockThemes: { light: "github-light-default", dark: "vesper" } });
