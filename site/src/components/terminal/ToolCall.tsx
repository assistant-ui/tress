// Browser adaptation of termcn's collapsible ToolCall. See README.md and LICENSE.
import type { ReactNode } from "react";
import { Spinner } from "./Spinner";
import { TerminalIcon } from "./TerminalIcon";

/** The host records tool requests, but does not expose individual results or timings. */
export function ToolCall({
  name,
  isRunning = false,
  children,
}: {
  name: string;
  isRunning?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="terminal-tool-call">
      <summary>
        <TerminalIcon name="chevron" className="tool-call-chevron" />
        <TerminalIcon name="terminal" />
        <span>{name}</span>
        {isRunning ? <Spinner label="working" /> : null}
      </summary>
      <div className="tool-call-content">{children}</div>
    </details>
  );
}
