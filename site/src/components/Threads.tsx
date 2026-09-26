"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DemoConfig } from "../lib/demo-config";
import { Thread } from "./Thread";
import { ThreadSidebar, type ThreadSummary } from "./ThreadSidebar";
import { TerminalIcon } from "./terminal/TerminalIcon";

export function Threads() {
  const [selected, setSelected] = useState<string>();
  const [config, setConfig] = useState<DemoConfig | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [working, setWorking] = useState(false);
  const drafts = useRef(new Map<string, string>());
  const action = useRef(false);
  const naming = useRef(new Set<string>());
  const refreshVersion = useRef(0);
  const current = useRef<string | undefined>(undefined);
  current.current = config?.session?.id;
  const currentToken = useRef<string | undefined>(undefined);
  currentToken.current = config?.session?.attachId;

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const response = await fetch("/api/threads", { cache: "no-store" });
      if (!response.ok)
        throw new Error("Couldn’t load your threads. Try again.");
      const data = await response.json();
      if (version !== refreshVersion.current) return;
      setThreads(data.threads);
      setLoaded(true);
      setError("");
    } catch (error) {
      if (version === refreshVersion.current)
        setError((error as Error).message);
    }
  }, []);

  const ready = useCallback((next: DemoConfig) => {
    setConfig(next);
    if (next.session) {
      const url = new URL(window.location.href);
      url.searchParams.set("session", next.session.attachId);
      window.history.replaceState(null, "", url);
    }
  }, []);

  useEffect(() => {
    setOpen(window.matchMedia("(min-width: 1200px)").matches);
    const back = () => {
      const next =
        new URL(window.location.href).searchParams.get("session") ?? undefined;
      if (next === currentToken.current) return;
      setConfig(null);
      setWorking(false);
      setSelected(next);
    };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);

  useEffect(() => {
    if (!config?.session) return;
    void refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [config?.session?.id, refresh]);

  const request = async (path: string, method: string, body = {}) => {
    const response = await fetch(`/api/threads${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error ?? "Couldn’t update this thread.");
    return data;
  };

  const run = async (task: () => Promise<void>) => {
    if (action.current) return false;
    action.current = true;
    setBusy(true);
    refreshVersion.current++;
    setError("");
    try {
      await task();
      return true;
    } catch (error) {
      setError((error as Error).message);
      return false;
    } finally {
      action.current = false;
      setBusy(false);
    }
  };

  const select = (id?: string) => {
    if (id && id === current.current) {
      if (window.matchMedia("(max-width: 1199px)").matches) setOpen(false);
      return Promise.resolve(true);
    }
    return run(async () => {
      const data = await request(id ? `/${id}` : "", "POST");
      setConfig(null);
      setWorking(false);
      window.history.pushState(null, "", `${data.session.browserUrl}#demo`);
      setSelected(data.session.attachId);
      if (window.matchMedia("(max-width: 1199px)").matches) setOpen(false);
    });
  };
  const update = (id: string, patch: { title?: string; archived?: boolean }) =>
    run(async () => {
      const data = await request(`/${id}`, "PATCH", patch);
      setThreads((items) =>
        items.map((item) => (item.id === id ? data.thread : item)),
      );
    });

  const activity = useCallback(
    (id: string, running: boolean, prompt?: string) => {
      if (current.current === id) setWorking(running);
      const thread = threads.find((thread) => thread.id === id);
      if (!prompt || !thread || thread.title || naming.current.has(id)) return;
      naming.current.add(id);
      // Derive a short title from existing content; no extra model request.
      void request(`/${id}`, "PATCH", {
        title: prompt.replace(/\s+/g, " ").trim().slice(0, 80),
        ifUntitled: true,
      })
        .then((data) =>
          setThreads((items) =>
            items.map((item) => (item.id === id ? data.thread : item)),
          ),
        )
        .catch(() => {})
        .finally(() => naming.current.delete(id));
    },
    [threads],
  );

  return (
    <div className="thread-shell">
      {loaded || config?.session ? (
        <ThreadSidebar
          open={open}
          onClose={() => setOpen(false)}
          threads={threads}
          currentId={config?.session?.id}
          working={working}
          loaded={loaded}
          busy={busy}
          error={error}
          onRetry={refresh}
          onSelect={select}
          onUpdate={update}
        />
      ) : null}
      <Thread
        key={selected ?? "initial"}
        session={selected}
        onReady={ready}
        onActivity={activity}
        drafts={drafts.current}
        toolbar={
          config?.session ? (
            <button
              type="button"
              className="threads-toggle"
              aria-label="Threads"
              aria-expanded={open}
              aria-controls="thread-sidebar"
              onClick={() => {
                setOpen((value) => !value);
                if (!open) void refresh();
              }}
            >
              <TerminalIcon name="threads" /> <span>threads</span>
            </button>
          ) : undefined
        }
      />
    </div>
  );
}
