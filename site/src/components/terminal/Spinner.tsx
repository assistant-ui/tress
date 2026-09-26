// Browser adaptation of termcn's braille Spinner. See README.md and LICENSE.
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="terminal-loading" role={label ? "status" : undefined}>
      <span className="terminal-spinner" aria-hidden="true">
        <span className="terminal-spinner-frames">
          {FRAMES.map((frame) => (
            <span key={frame}>{frame}</span>
          ))}
        </span>
      </span>
      {label ? <span>{label}</span> : null}
    </span>
  );
}
