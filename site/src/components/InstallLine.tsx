"use client";

import { CopyButton } from "./CopyButton";

const COMMAND =
  "cargo install --git https://github.com/assistant-ui/tress tress";

export function InstallLine() {
  return (
    <div className="install">
      <span className="sigil" aria-hidden="true">
        $
      </span>
      <code>{COMMAND}</code>
      <CopyButton text={COMMAND} label="Copy install command" />
    </div>
  );
}
