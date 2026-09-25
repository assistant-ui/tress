import { defineConfig } from "@farm.js/core";
import { wasm } from "@farm.js/wasm";

export default defineConfig({
  deploy:
    process.env.FARM_DEPLOY_TARGET === "vercel"
      ? { target: "vercel" }
      : undefined,
  plugins: [wasm()],
  images: { provider: "none" },
  routeRules: {
    "/api/**": { runtime: "node", regions: ["iad1"], maxDuration: 300 },
  },
  vite: {
    plugins: [
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
            external: [
              "just-bash",
              "@vercel/sandbox",
              "harness-sdk",
              "statewire",
              "@assistant-ui/tap",
              "pg",
            ],
          },
        }),
      },
    ],
  },
});
