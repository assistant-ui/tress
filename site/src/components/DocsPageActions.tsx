"use client";

import { useEffect, useRef, useState } from "react";
import { TerminalIcon } from "./terminal/TerminalIcon";

export function DocsPageActions({ href }: { href: string }) {
  const [status, setStatus] = useState<"idle" | "pending" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const request = useRef<AbortController | undefined>(undefined);

  useEffect(() => () => {
    clearTimeout(timer.current);
    request.current?.abort();
  }, []);

  const copy = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    clearTimeout(timer.current);
    setStatus("pending");
    try {
      const response = await fetch(href, {
        headers: { Accept: "text/markdown" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Markdown unavailable");
      await navigator.clipboard.writeText(await response.text());
      if (!controller.signal.aborted) setStatus("copied");
    } catch {
      if (!controller.signal.aborted) setStatus("error");
    } finally {
      request.current = undefined;
      if (!controller.signal.aborted)
        timer.current = setTimeout(() => setStatus("idle"), 2400);
    }
  };

  return (
    <div className="docs-page-actions" aria-label="Page actions">
      <a className="fd-page-action-btn" href={href} title="View this page as Markdown">
        <TerminalIcon name="files" />
        <span>View .md</span>
      </a>
      <span className="docs-action-divider" aria-hidden="true">/</span>
      <button
        className="fd-page-action-btn"
        type="button"
        onClick={copy}
        disabled={status === "pending"}
        data-copied={status === "copied"}
        title="Copy this page as Markdown"
      >
        <TerminalIcon name={status === "copied" ? "check" : "copy"} />
        <span>{status === "copied" ? "Copied .md" : status === "pending" ? "Copying…" : "Copy .md"}</span>
      </button>
      <span className={status === "error" ? "docs-copy-error" : "visually-hidden"} role="status">
        {status === "error" ? "Couldn’t copy. Open View .md to copy the text." : status === "copied" ? "Markdown copied." : ""}
      </span>
    </div>
  );
}
