import { useEffect, useState } from "react";
import { SourcePane } from "./generated/SourcePane";
import { Spinner } from "./generated/terminal/Spinner";

export interface TressWorkspace {
  label: string;
  description?: string;
  writable?: boolean;
  shell?: boolean;
  list(
    path: string,
    signal: AbortSignal,
  ): Promise<{ name: string; type: "file" | "directory" }[]>;
  read(path: string, signal: AbortSignal): Promise<Blob>;
}
export function FilesPane({
  workspace,
  onAsk,
}: {
  workspace: TressWorkspace;
  onAsk: (prompt: string) => void;
}) {
  const [directory, setDirectory] = useState("");
  const [revision, setRevision] = useState(0);
  const [entries, setEntries] = useState<
    { name: string; type: "file" | "directory" }[]
  >([]);
  const [selected, setSelected] = useState("");
  const [file, setFile] = useState<Blob>();
  const [preview, setPreview] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    setEntries([]);
    workspace
      .list(directory, abort.signal)
      .then((entries) => {
        if (!abort.signal.aborted) setEntries(entries);
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [workspace, directory, revision]);
  useEffect(() => {
    setFile(undefined);
    setPreview(undefined);
    if (!selected) {
      setReading(false);
      return;
    }
    const abort = new AbortController();
    setReading(true);
    setError("");
    workspace
      .read(selected, abort.signal)
      .then(async (blob) => {
        const text = blob.size <= 1_048_576 ? await blob.text() : undefined;
        if (abort.signal.aborted) return;
        setFile(blob);
        setPreview(
          text !== undefined && !text.includes("\0") && !text.includes("\ufffd")
            ? text
            : undefined,
        );
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setReading(false);
      });
    return () => abort.abort();
  }, [workspace, selected, revision]);
  return (
    <section aria-label="Workspace files">
      <div className="host-file-navigation">
        <code>{directory || "/"}</code>
        {directory ? (
          <button
            type="button"
            onClick={() => {
              setDirectory(directory.split("/").slice(0, -1).join("/"));
              setSelected("");
            }}
          >
            Parent folder
          </button>
        ) : null}
        <button
          type="button"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh files
        </button>
      </div>
      {loading ? (
        <div className="source-loading">
          <Spinner label="Loading files…" />
        </div>
      ) : (
        <div className="host-file-list">
          {entries.map((entry) => {
            const path = [directory, entry.name].filter(Boolean).join("/");
            return (
              <button
                key={entry.name}
                type="button"
                aria-pressed={
                  entry.type === "file" ? path === selected : undefined
                }
                onClick={() => {
                  if (entry.type === "directory") {
                    setDirectory(path);
                    setSelected("");
                  } else setSelected(path);
                }}
              >
                {entry.name}
                {entry.type === "directory" ? "/" : ""}
              </button>
            );
          })}
          {!entries.length ? <p>No files in this folder.</p> : null}
        </div>
      )}
      {error ? (
        <p role="alert" className="host-file-error">
          {error}
        </p>
      ) : null}
      {reading ? (
        <div className="source-loading">
          <Spinner label="Loading preview…" />
        </div>
      ) : selected && file ? (
        <div className="host-file-preview">
          {preview !== undefined ? (
            <SourcePane
              files={{ [selected]: preview }}
              open={selected}
              onOpen={() => {}}
              onAsk={onAsk}
              writable={workspace.writable}
            />
          ) : (
            <p className="host-file-error">
              Preview unavailable for this file. Download it to open it locally.
            </p>
          )}
          <div className="host-file-navigation">
            <code>{selected}</code>
            <button
              type="button"
              onClick={() => {
                const url = URL.createObjectURL(file);
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = selected.split("/").at(-1) ?? "download";
                anchor.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              Download file
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
