"use client";

import { memo } from "react";

// A lightweight JavaScript token display; all content remains escaped React text.
const TOKENS =
  /(\/\/.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b(?:export|async|function|let|const|for|if|return|await|try|catch|throw|new|import|from)\b|\b\d+\b)/g;
const KEYWORD =
  /^(export|async|function|let|const|for|if|return|await|try|catch|throw|new|import|from)$/;

export const SourcePane = memo(function SourcePane({
  files,
  open,
  onOpen,
}: {
  files: Record<string, string>;
  open: string;
  onOpen: (path: string) => void;
}) {
  const paths = Object.keys(files);
  const selected = paths.includes(open) ? open : paths[0];
  const source = files[selected] ?? "";
  const javascript = /\.[cm]?[jt]sx?$/.test(selected ?? "");
  const lines = source.trimEnd().split("\n");

  return (
    <aside className="source-pane" aria-label="Shared workspace files">
      <div className="workspace-heading">
        <span>Shared file previews</span>
        <span>{paths.length} files</span>
      </div>
      <div className="file-tabs" aria-label="Select a file">
        {paths.map((path) => (
          <button
            key={path}
            type="button"
            aria-pressed={path === selected}
            onClick={() => onOpen(path)}
          >
            <span className="file-icon" aria-hidden="true">
              {path.split(".").at(-1)?.slice(0, 3).toUpperCase() ?? "TXT"}
            </span>
            {path}
          </button>
        ))}
      </div>
      <div
        className="source-scroll"
        tabIndex={0}
        role="region"
        aria-label={selected ? `Contents of ${selected}` : "No shared files"}
      >
        {selected ? (
          <pre className="source-code">
            <code>
              {lines.map((line, index) => (
                <span className="source-line" key={index}>
                  <span className="line-number" aria-hidden="true">
                    {index + 1}
                  </span>
                  <span>
                    {(javascript ? line.split(TOKENS) : [line]).map(
                      (token, i) => (
                        <span
                          key={i}
                          className={
                            !javascript
                              ? undefined
                              : token.startsWith("//")
                                ? "token-comment"
                                : /^["'`]/.test(token)
                                  ? "token-string"
                                  : KEYWORD.test(token)
                                    ? "token-keyword"
                                    : /^\d+$/.test(token)
                                      ? "token-number"
                                      : undefined
                          }
                        >
                          {token}
                        </span>
                      ),
                    )}
                    {"\n"}
                  </span>
                </span>
              ))}
            </code>
          </pre>
        ) : (
          <div className="source-loading">
            No file previews shared by the host.
          </div>
        )}
      </div>
      <div className="source-footer">
        <span>{selected ? `${lines.length} lines` : "Read only preview"}</span>
        <span>{selected ? "UTF-8" : ""}</span>
      </div>
    </aside>
  );
});
