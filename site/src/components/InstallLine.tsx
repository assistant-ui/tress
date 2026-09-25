"use client";

import { useEffect, useState } from "react";
import { CopyButton } from "./CopyButton";

export function InstallLine() {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const command = origin ? `curl -fsSL ${origin}/tress.sh | sh` : "";

  return (
    <div className="install">
      <span className="sigil" aria-hidden="true">
        $
      </span>
      <code>{command || "curl -fsSL …/tress.sh | sh"}</code>
      <CopyButton
        text={command}
        label="Copy install command"
        disabled={!command}
      />
    </div>
  );
}
