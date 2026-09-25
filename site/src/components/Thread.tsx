"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { StatewireClient, StatewireHttp } from "statewire";

type Entry = {
  id: string;
  role: "user" | "agent";
  text: string;
  tools: string[];
};

type ThreadState = {
  entries: Entry[];
  status: "idle" | "running";
  files: Record<string, string>;
  runs: number;
};

type Commands = { send: (prompt: string) => Promise<unknown>; reset: () => Promise<unknown> };

const EMPTY: ThreadState = { entries: [], status: "idle", files: {}, runs: 0 };

const SUGGESTIONS = [
  "retry.js hammers the server on failure — fix it so the tests pass",
  "what is wrong with retry.js?",
];

export function Thread() {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState("retry.js");
  const log = useRef<HTMLDivElement>(null);

  const client = useMemo(
    () =>
      new StatewireClient<ThreadState | undefined, Commands>({
        transport: StatewireHttp({ url: "/api/thread" }),
      }),
    [],
  );

  useEffect(() => () => client.dispose(), [client]);

  const state =
    useSyncExternalStore(
      (listener) => client.subscribe(listener),
      () => client.state,
      () => undefined,
    ) ?? EMPTY;

  const connection = useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.connection.status,
    () => "connecting" as const,
  );

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [state.entries]);

  const files = state.files ?? {};
  const paths = Object.keys(files);
  const shown = files[open] ?? files[paths[0]] ?? "";

  const send = (prompt: string) => {
    if (!prompt.trim() || state.status === "running") return;
    setInput("");
    void client.commands.send(prompt);
  };

  return (
    <div className="pane">
      <div className="pane-bar">
        <span className="pane-title">thread · demo</span>
        <span className="pane-state">
          {connection !== "connected" ? (
            <span className="off">reconnecting…</span>
          ) : state.status === "running" ? (
            <span className="run">● agent working</span>
          ) : (
            <span className="idle">○ idle</span>
          )}
        </span>
      </div>

      <div className="pane-body">
        <div className="pane-log" ref={log}>
          {state.entries.length === 0 ? (
            <div className="pane-empty">
              This thread lives on the server, not in this tab. Start a run,
              then close the tab — the work continues, and reopening shows what
              happened while you were gone.
              <div className="pane-suggest">
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion} type="button" onClick={() => send(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {state.entries.map((entry) => (
            <div key={entry.id} className={`entry entry-${entry.role}`}>
              {entry.role === "user" ? (
                <div className="entry-user">
                  <span className="caret">❯ </span>
                  {entry.text}
                </div>
              ) : (
                <div>
                  {entry.tools.map((tool, index) => (
                    <div key={index} className="entry-tool">
                      · {tool}
                    </div>
                  ))}
                  <div className="entry-text">{entry.text}</div>
                </div>
              )}
            </div>
          ))}
        </div>

        <aside className="pane-files">
          <div className="pane-tabs">
            {paths.map((path) => (
              <button
                key={path}
                type="button"
                className={path === open ? "on" : ""}
                onClick={() => setOpen(path)}
              >
                {path}
              </button>
            ))}
          </div>
          <pre className="pane-source">{shown}</pre>
        </aside>
      </div>

      <form
        className="pane-input"
        onSubmit={(event) => {
          event.preventDefault();
          send(input);
        }}
      >
        <span className="caret">❯</span>
        <input
          value={input}
          disabled={state.status === "running"}
          placeholder={
            state.status === "running"
              ? "the agent is working — this is safe to close"
              : "ask it to change the code…"
          }
          onChange={(event) => setInput(event.target.value)}
          aria-label="Ask the agent"
        />
        <button type="submit" disabled={state.status === "running" || !input.trim()}>
          run
        </button>
        {state.entries.length > 0 ? (
          <button
            type="button"
            className="ghost"
            onClick={() => void client.commands.reset()}
          >
            reset
          </button>
        ) : null}
      </form>

      <div className="pane-foot">
        {state.runs > 0 ? `${state.runs} run${state.runs === 1 ? "" : "s"} on this thread · ` : ""}
        state replicated over statewire · open this page in a second tab to
        watch both follow the same run
      </div>
    </div>
  );
}
