// Browser adaptation of termcn's KeyboardShortcuts. See README.md and LICENSE.
export interface Shortcut {
  key: string;
  description: string;
}

export function KeyboardShortcuts({ shortcuts }: { shortcuts: Shortcut[] }) {
  return (
    <span className="terminal-shortcuts" aria-label="Keyboard shortcuts">
      {shortcuts.map((shortcut) => (
        <span key={shortcut.key}>
          <kbd>{shortcut.key}</kbd>
          <span>{shortcut.description}</span>
        </span>
      ))}
    </span>
  );
}
