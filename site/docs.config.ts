import { defineDocs } from "@farming-labs/docs";
import { darksharp } from "@farming-labs/theme/darksharp";

export default defineDocs({
  entry: "docs",
  contentDir: "docs",
  ordering: ["index", "try", "existing-app", "authentication", "local", "production", "reference"].map((slug) => ({ slug })),
  theme: darksharp({
    ui: {
      colors: { background: "#090909", primary: "#ce957c", border: "#292929" },
      typography: {
        font: {
          style: { sans: '"Geist Mono", monospace', mono: '"Geist Mono", monospace' },
          h1: { size: "1.65rem", weight: 500 },
          h2: { size: "1.15rem", weight: 500 },
          body: { size: "0.875rem", lineHeight: "1.8" },
        },
      },
    },
  }),
  nav: { title: "tress / docs", url: "/" },
  sidebar: { flat: true },
  breadcrumb: { enabled: false },
  themeToggle: { enabled: false, default: "dark" },
  ai: { enabled: false },
  pageActions: { copyMarkdown: { enabled: true }, openDocs: { enabled: false } },
  metadata: {
    titleTemplate: "%s · tress",
    description: "Connect your terminal to the conversation in your application.",
  },
});
