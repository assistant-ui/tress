import { defineDocs } from "@farming-labs/docs";
import { darksharp } from "@farming-labs/theme/darksharp";

export default {
  ...defineDocs({
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
      description: "Connect your terminal to the conversation in your application.",
    },
  }),
  navigation: {
    sidebar: [
      { label: "Get started", children: [
        { label: "Overview", href: "/docs" },
        { label: "Try the browser demo", href: "/docs/try" },
      ] },
      { label: "Build & deploy", children: [
        { label: "Connect an existing app", href: "/docs/existing-app" },
        { label: "Authentication", href: "/docs/authentication" },
        { label: "Local development", href: "/docs/local" },
        { label: "Production", href: "/docs/production" },
      ] },
      { label: "Reference", children: [
        { label: "Versions & limits", href: "/docs/reference" },
      ] },
    ],
  },
};
