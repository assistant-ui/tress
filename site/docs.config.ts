import { defineDocs } from "@farming-labs/docs";
import { darksharp } from "@farming-labs/theme/darksharp";

export default {
  ...defineDocs({
    entry: "docs",
    contentDir: "docs",
    ordering: ["index", "workspace", "try", "existing-app", "authentication", "local", "production", "embedding", "reference"].map((slug) => ({ slug })),
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
        layout: { sidebarWidth: 256, contentWidth: 640 },
      },
    }),
    nav: { title: "tress", url: "/" },
    sidebar: { flat: true, collapsible: false },
    breadcrumb: { enabled: false },
    themeToggle: { enabled: false, default: "dark" },
    ai: { enabled: false },
    pageActions: { copyMarkdown: false, openDocs: false },
    metadata: {
      titleTemplate: "%s · tress",
      description: "A machine-backed agent workspace, shared by browser and terminal clients.",
    },
  }),
  navigation: {
    sidebar: [
      { label: "Get started", children: [
        { label: "Overview", href: "/docs" },
        { label: "Run on your machine", href: "/docs/workspace" },
        { label: "Try the hosted demo", href: "/docs/try" },
      ] },
      { label: "Build & deploy", children: [
        { label: "Connect an existing app", href: "/docs/existing-app" },
        { label: "Authentication", href: "/docs/authentication" },
        { label: "App development", href: "/docs/local" },
        { label: "Production", href: "/docs/production" },
      ] },
      { label: "Reference", children: [
        { label: "Embedding and runtimes", href: "/docs/embedding" },
        { label: "Versions & limits", href: "/docs/reference" },
      ] },
    ],
  },
};
