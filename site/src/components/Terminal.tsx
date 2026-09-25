"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Line =
  | { kind: "prompt"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; text: string }
  | { kind: "note"; text: string }
  | { kind: "error"; text: string };

type TressSession = {
  send: (prompt: string, onEvent: (raw: string) => void) => Promise<void>;
  files: () => Record<string, string>;
};

const CART = `export function cartTotal(items, discountPercent = 0) {
  return items.reduce((sum, item) => {
    const price = item.price * (1 - discountPercent / 100);
    return sum + Math.round(price * 100) / 100 * item.quantity;
  }, 0);
}
`;

const CART_TEST = `import { cartTotal } from "./cart.js";

test("applies a discount to the whole cart", () => {
  const items = [{ price: 9.99, quantity: 7 }];
  expect(cartTotal(items, 15)).toBe(59.44);
});
`;

const SEED: Record<string, string> = {
  "cart.js": CART,
  "cart.test.js": CART_TEST,
};

const SUGGESTIONS = [
  "find the bug in cart.js and fix it",
  "explain what cart.js does",
];

const BANNER = String.raw`  _
 | |_ _ __ ___  ___ ___
 | __| '__/ _ \/ __/ __|
 | |_| | |  __/\__ \__ \
  \__|_|  \___||___/___/`;

export function Terminal() {
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<"live" | "replay" | null>(null);
  const [files, setFiles] = useState<Record<string, string>>(SEED);
  const [open, setOpen] = useState("cart.js");

  const session = useRef<TressSession | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  const push = useCallback((line: Line) => {
    setLines((current) => {
      const last = current[current.length - 1];
      // Streamed text arrives in fragments: grow the last line instead of
      // pushing one node per token.
      if (line.kind === "text" && last?.kind === "text") {
        return [...current.slice(0, -1), { kind: "text", text: last.text + line.text }];
      }
      return [...current, line];
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Built by wasm-bindgen into public/, so it is loaded at runtime
        // rather than resolved by the bundler.
        const url = new URL("/pkg/tress_wasm.js", window.location.origin).href;
        const module = await import(/* @vite-ignore */ url);
        await module.default();
        if (cancelled) return;
        session.current = new module.TressSession(
          "/api/messages",
          "claude-sonnet-5",
          {},
          SEED,
        ) as TressSession;
        const probe = await fetch("/api/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: [], probe: true }),
        });
        if (cancelled) return;
        setMode(probe.headers.get("x-tress-mode") === "live" ? "live" : "replay");
        setReady(true);
      } catch (error) {
        push({ kind: "error", text: `could not load the agent: ${error}` });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [push]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lines]);

  const run = async (prompt: string) => {
    const agent = session.current;
    if (!agent || busy) return;
    setBusy(true);
    setInput("");
    push({ kind: "prompt", text: prompt });

    try {
      await agent.send(prompt, (raw) => {
        const event = JSON.parse(raw) as {
          type: string;
          text?: string;
          summary?: string;
        };
        if (event.type === "text" && event.text) {
          push({ kind: "text", text: event.text });
        } else if (event.type === "tool" && event.summary) {
          push({ kind: "tool", text: event.summary });
        }
      });
      const updated = agent.files();
      setFiles(updated);
      const changed = Object.keys(updated).find((path) => updated[path] !== files[path]);
      if (changed) setOpen(changed);
    } catch (error) {
      push({ kind: "error", text: String(error) });
    } finally {
      setBusy(false);
      field.current?.focus();
    }
  };

  return (
    <div className="term">
      <div className="term-bar">
        <span className="term-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="term-title">tress — in your browser</span>
        <span className="term-mode">
          {!ready
            ? "loading wasm…"
            : mode === "live"
              ? "● live model"
              : "● recorded session"}
        </span>
      </div>

      <div className="term-body">
        <div className="term-log" ref={scroller}>
          <pre className="term-banner">{BANNER}</pre>
          <div className="term-intro">
            The agent below is Rust compiled to WebAssembly, running in this tab.
            It reads and edits the files on the right. Nothing is installed and
            nothing leaves your machine except the model call.
          </div>

          {lines.map((line, index) => (
            <div key={index} className={`term-line term-${line.kind}`}>
              {line.kind === "prompt" ? <span className="term-caret">❯ </span> : null}
              {line.kind === "tool" ? <span className="term-bullet">· </span> : null}
              {line.text}
            </div>
          ))}

          {lines.length === 0 && ready ? (
            <div className="term-suggest">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => run(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <aside className="term-files">
          <div className="term-tabs">
            {Object.keys(files).map((path) => (
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
          <pre className="term-source">{files[open] ?? ""}</pre>
        </aside>
      </div>

      <form
        className="term-input"
        onSubmit={(event) => {
          event.preventDefault();
          if (input.trim()) run(input.trim());
        }}
      >
        <span className="term-caret">❯</span>
        <input
          ref={field}
          value={input}
          disabled={!ready || busy}
          placeholder={busy ? "working…" : "ask it to change the code…"}
          onChange={(event) => setInput(event.target.value)}
          aria-label="Ask the agent"
        />
        <button type="submit" disabled={!ready || busy || !input.trim()}>
          run
        </button>
      </form>
    </div>
  );
}
