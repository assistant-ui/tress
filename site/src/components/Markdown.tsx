import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];
const components: Components = {
  a: ({ children, href, title }) => (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="markdown-table" role="region" aria-label="Table" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
  // Model-provided images stay text until the reader chooses to open them.
  img: ({ alt, src }) => (
    <a href={src} target="_blank" rel="noopener noreferrer">
      {alt || "Image"} ↗
    </a>
  ),
};

/** Reparse the streaming reply; completed replies skip unrelated thread updates. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="entry-text markdown">
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
