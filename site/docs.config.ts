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
          h1: { size: "1.5rem", weight: 500 },
          h2: { size: "1rem", weight: 500 },
          body: { size: "0.8125rem", lineHeight: "1.8" },
        },
      },
      layout: { sidebarWidth: 240, contentWidth: 640 },
    },
  }),
  nav: { title: "tress / docs", url: "/" },
  sidebar: { flat: true },
  breadcrumb: { enabled: false },
  themeToggle: { enabled: false, default: "dark" },
  ai: { enabled: false },
  pageActions: {
    position: "below-title",
    alignment: "right",
    copyMarkdown: { enabled: true },
    openDocs: { enabled: false },
  },
  metadata: {
    titleTemplate: "%s · tress",
    description: "Connect your terminal to the conversation in your application.",
  },
});
