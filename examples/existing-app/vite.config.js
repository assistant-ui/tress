import { defineConfig } from "vite";

export default defineConfig({
  // Source-preview packages are linked; use the application's React instance.
  resolve: { dedupe: ["react", "react-dom"] },
});
