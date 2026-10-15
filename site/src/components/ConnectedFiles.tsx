"use client";

import { useEffect, useState } from "react";
import type { FileEntry } from "@tress/workspaces";
import type { LocalDevice } from "./LocalConnection";
import { SourcePane } from "./SourcePane";
import { Spinner } from "./terminal/Spinner";
import { TerminalIcon } from "./terminal/TerminalIcon";

/** Browse one directory/file at a time through the already paired device. */
export function ConnectedFiles({
  device, threadId, attachId, refreshKey, onAsk, actionsDisabled,
}: {
  device: LocalDevice;
  threadId: string;
  attachId: string;
  refreshKey: number;
  onAsk: (prompt: string) => void;
  actionsDisabled: boolean;
}) {
  const [directory, setDirectory] = useState("");
  const [selection, setSelection] = useState({ operation: "list", path: "" });
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [preview, setPreview] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!device.online) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setPreview({});
    const query = new URLSearchParams({
      thread: threadId, session: attachId, device: device.id,
      operation: selection.operation, path: selection.path,
    });
    void fetch(`/api/connect/files?${query}`, {
      cache: "no-store", signal: controller.signal,
    }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load the workspace.");
      if (controller.signal.aborted) return;
      if (data.deviceId !== device.id || data.path !== selection.path)
        throw new Error("The workspace connection changed. Refresh to continue.");
      if (selection.operation === "list") {
        if (!Array.isArray(data.value)) throw new Error("Invalid directory response.");
        setEntries([...data.value].sort((a: FileEntry, b: FileEntry) =>
          (a.type === b.type ? 0 : a.type === "directory" ? -1 : 1) || a.name.localeCompare(b.name)));
      } else {
        if (typeof data.value !== "string") throw new Error("Invalid file response.");
        setPreview({ [selection.path]: data.value });
      }
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load the workspace.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [device.id, device.online, threadId, attachId, selection, revision, refreshKey]);

  const browse = (path: string) => {
    setDirectory(path);
    setEntries([]);
    setSelection({ operation: "list", path });
  };

  if (!device.online) return <p className="workspace-empty" role="status">{device.label} is offline. Restart its Tress connection to browse files.</p>;

  return <section className="connected-files" aria-label="Connected workspace files">
    <div className="file-browser-toolbar">
      <button type="button" disabled={!directory || loading} onClick={() => browse(directory.split("/").slice(0, -1).join("/"))} aria-label="Parent folder">↑</button>
      <span className="file-browser-path" title={`${device.rootLabel}/${directory}`}>{device.rootLabel}{directory ? ` / ${directory}` : ""}</span>
      <button type="button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>Refresh</button>
    </div>
    <div className="file-browser-body" aria-busy={loading}>
      <div className="file-browser-list" aria-label="Files and folders">
        {entries.map((entry) => {
          const path = directory ? `${directory}/${entry.name}` : entry.name;
          return <button type="button" key={entry.name} disabled={loading}
            aria-pressed={selection.operation === "read" && selection.path === path}
            onClick={() => entry.type === "directory" ? browse(path) : setSelection({ operation: "read", path })}>
            <TerminalIcon name={entry.type === "directory" ? "chevron" : "files"} />
            <span>{entry.name}{entry.type === "directory" ? "/" : ""}</span>
          </button>;
        })}
        {!loading && !error && entries.length === 0 ? <p className="workspace-empty">This folder is empty.</p> : null}
      </div>
      <div className="file-browser-preview">
        {loading ? <div className="workspace-empty" role="status"><Spinner label="Loading from the host…" /></div> : error ?
          <div className="workspace-empty" role="alert"><p>{error}</p><button type="button" onClick={() => setRevision((value) => value + 1)}>Try again</button></div> :
          Object.keys(preview).length ? <SourcePane files={preview} open={selection.path} onOpen={() => {}} onAsk={onAsk} writable={device.writable} actionsDisabled={actionsDisabled} /> :
          <p className="workspace-empty">Select a file to preview it. Files are loaded from {device.label} as you open them.</p>}
      </div>
    </div>
  </section>;
}
