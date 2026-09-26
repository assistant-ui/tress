"use client";

import { useEffect, useRef, useState } from "react";
import { TerminalIcon } from "./terminal/TerminalIcon";

export function CopyButton({
  text,
  label = "Copy command",
  disabled = false,
  compact = false,
}: {
  text: string;
  label?: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
    timer.current = setTimeout(() => setStatus("idle"), 2200);
  };

  return (
    <button
      type="button"
      className={`copy-button${compact ? " copy-button-compact" : ""}`}
      disabled={disabled}
      onClick={copy}
      aria-label={status === "copied" ? "Copied" : label}
      title={
        status === "error"
          ? "Clipboard unavailable. Select and copy the command."
          : label
      }
    >
      <TerminalIcon name={status === "copied" ? "check" : "copy"} />
      <span
        className={compact ? "visually-hidden" : undefined}
        aria-live="polite"
      >
        {status === "copied"
          ? "Copied ✓"
          : status === "error"
            ? "Select text"
            : "Copy"}
      </span>
    </button>
  );
}
