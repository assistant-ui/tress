"use client";

import { useEffect, useRef, useState } from "react";

export function CopyButton({
  text,
  label = "Copy command",
  disabled = false,
}: {
  text: string;
  label?: string;
  disabled?: boolean;
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
      className="copy-button"
      disabled={disabled}
      onClick={copy}
      aria-label={status === "copied" ? "Copied" : label}
      title={
        status === "error"
          ? "Clipboard unavailable. Select and copy the command."
          : label
      }
    >
      <span aria-live="polite">
        {status === "copied"
          ? "Copied ✓"
          : status === "error"
            ? "Select text"
            : "Copy"}
      </span>
    </button>
  );
}
