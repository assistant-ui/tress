"use client";

import { useEffect, useRef, useState } from "react";

export type ThreadSummary = {
  id: string;
  title: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
type Props = {
  open: boolean;
  onClose: () => void;
  threads: ThreadSummary[];
  currentId?: string;
  working: boolean;
  loaded: boolean;
  busy: boolean;
  error: string;
  onRetry: () => Promise<void>;
  onSelect: (id?: string) => Promise<boolean>;
  onUpdate: (
    id: string,
    patch: { title?: string; archived?: boolean },
  ) => Promise<boolean>;
};

export function ThreadSidebar(props: Props) {
  const {
    open,
    onClose,
    threads,
    currentId,
    working,
    loaded,
    busy,
    error,
    onSelect,
    onUpdate,
  } = props;
  const [mobile, setMobile] = useState(false);
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [title, setTitle] = useState("");
  const drawer = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1199px)");
    const sync = () => setMobile(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    const element = drawer.current;
    if (mobile && open && element && !element.open) element.showModal();
    else if (element?.open) element.close();
    if (open && !wasOpen.current) closeButton.current?.focus();
    if (!open && wasOpen.current)
      document.querySelector<HTMLButtonElement>(".threads-toggle")?.focus();
    wasOpen.current = open;
  }, [open, mobile]);

  const visible = threads.filter(
    (thread) => Boolean(thread.archivedAt) === archived,
  );
  const content = (
    <>
      <div className="threads-heading">
        <h2>Threads</h2>
        <button
          className="new-thread"
          type="button"
          aria-label="New thread"
          title="New thread"
          disabled={busy}
          onClick={() => void onSelect()}
        >
          <span aria-hidden="true">+</span>
        </button>
        <button
          ref={closeButton}
          type="button"
          aria-label="Close threads"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div
        className="thread-list"
        aria-label={archived ? "Archived threads" : "Your threads"}
      >
        {!loaded && !error ? (
          <p className="threads-empty" role="status">
            Loading threads…
          </p>
        ) : null}
        {loaded && !visible.length ? (
          <p className="threads-empty">
            {archived
              ? "No archived threads."
              : "Your threads will appear here."}
          </p>
        ) : null}
        {visible.map((thread) => (
          <div className="thread-row" key={thread.id}>
            {editing === thread.id ? (
              <form
                className="thread-rename"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (await onUpdate(thread.id, { title }))
                    setEditing(undefined);
                }}
              >
                <input
                  aria-label="Thread title"
                  value={title}
                  maxLength={80}
                  autoFocus
                  onChange={(event) => setTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setEditing(undefined);
                    }
                  }}
                />
                <div>
                  <button type="submit" disabled={busy || !title.trim()}>
                    Save
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setEditing(undefined)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <>
                <button
                  type="button"
                  className="thread-select"
                  disabled={busy}
                  aria-current={currentId === thread.id ? "page" : undefined}
                  title={`${thread.title ?? "New thread"}${currentId === thread.id && working ? " · working" : ""}`}
                  onClick={() => void onSelect(thread.id)}
                >
                  <span className="thread-marker" aria-hidden="true">
                    {currentId === thread.id ? (working ? "·" : "›") : ""}
                  </span>
                  <span className="thread-row-title">
                    {thread.title ?? "New thread"}
                  </span>
                </button>
                <details
                  className="thread-actions"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      event.currentTarget.open = false;
                      event.currentTarget.querySelector("summary")?.focus();
                    }
                  }}
                >
                  <summary
                    aria-label={`Manage ${thread.title ?? "new thread"}`}
                  >
                    ···
                  </summary>
                  <div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={(event) => {
                        event.currentTarget.closest("details")!.open = false;
                        setEditing(thread.id);
                        setTitle(thread.title ?? "");
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async (event) => {
                        event.currentTarget.closest("details")!.open = false;
                        await onUpdate(thread.id, {
                          archived: !thread.archivedAt,
                        });
                      }}
                    >
                      {thread.archivedAt ? "Restore" : "Archive"}
                    </button>
                  </div>
                </details>
              </>
            )}
          </div>
        ))}
      </div>
      {error ? (
        <div className="threads-error" role="alert">
          {error}{" "}
          <button type="button" onClick={() => void props.onRetry()}>
            Retry
          </button>
        </div>
      ) : null}
      {archived || threads.some((thread) => thread.archivedAt) ? (
        <button
          type="button"
          className="archived-toggle"
          aria-pressed={archived}
          onClick={() => setArchived((value) => !value)}
        >
          {archived
            ? "← All threads"
            : `Archived${threads.some((thread) => thread.archivedAt) ? ` (${threads.filter((thread) => thread.archivedAt).length})` : ""}`}
        </button>
      ) : null}
    </>
  );

  return mobile ? (
    <dialog
      id="thread-sidebar"
      className="thread-sidebar thread-drawer"
      ref={drawer}
      aria-label="Threads"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="thread-sidebar-content">{content}</div>
    </dialog>
  ) : (
    <aside
      id="thread-sidebar"
      className="thread-sidebar"
      hidden={!open}
      aria-label="Threads"
    >
      {content}
    </aside>
  );
}
