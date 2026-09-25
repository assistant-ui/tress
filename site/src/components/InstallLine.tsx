"use client";

import { useState } from "react";

const COMMAND = "cargo install --git https://github.com/assistant-ui/tress tress";

export function InstallLine() {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="install">
      <span className="sigil">$</span>
      <code>{COMMAND}</code>
      <button type="button" onClick={copy}>
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}
