"use client";

import { useEffect, useState } from "react";
import { CopyButton } from "./CopyButton";
import type { WorkspaceDetails } from "@tress/workspaces";

export type LocalDevice = {
  id: string;
  label: string;
  rootLabel: string;
  writable: boolean;
  online: boolean;
  details?: WorkspaceDetails;
};

export function LocalConnection({
  threadId,
  attachId,
  origin,
  onDevice,
}: {
  threadId: string;
  attachId: string;
  origin: string;
  onDevice: (device: LocalDevice | null) => void;
}) {
  const [device, setDevice] = useState<LocalDevice | null>(null);
  const [visible, setVisible] = useState(false);
  const [manageable, setManageable] = useState(false);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const command = `tress connect --site ${origin || "https://your-tress-site"} --root .`;

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const response = await fetch(
          `/api/connect/status?thread=${encodeURIComponent(threadId)}&session=${encodeURIComponent(attachId)}`,
          { cache: "no-store" },
        );
        if (!alive) return;
        if (response.status === 404) {
          setVisible(false);
          onDevice(null);
          return;
        }
        if (!response.ok) throw new Error("Couldn’t check the local connection.");
        const data = await response.json();
        setVisible(true);
        setManageable(data.manageable === true);
        setDevice(data.device);
        onDevice(data.device);
        setError("");
      } catch (cause) {
        if (alive) setError((cause as Error).message);
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [threadId, attachId, onDevice]);

  const claim = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/connect/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId, code: code.trim() }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? "Pairing failed. Check the code and try again.");
      setDevice(data.device);
      onDevice(data.device);
      setCode("");
      setExpanded(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect this folder from the thread? The files stay on your computer."))
      return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(
        `/api/connect/status?thread=${encodeURIComponent(threadId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("Couldn’t disconnect this folder.");
      setDevice(null);
      onDevice(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(false);
    }
  };

  if (!visible || (!manageable && !device)) return null;
  return (
    <div className="local-connect">
      <div className="local-connect-head">
        <div>
          <strong>local folder</strong>
          <span role="status">
            {device
              ? `${device.label} · ${device.rootLabel} · ${device.online ? "online" : "offline"} · ${device.writable ? "read + write" : "read-only"}`
              : "not connected"}
          </span>
        </div>
        {device && manageable ? (
          <button type="button" disabled={pending} onClick={() => void disconnect()}>
            disconnect
          </button>
        ) : !device && manageable ? (
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? "close" : "connect folder"}
          </button>
        ) : null}
      </div>
      {!device && expanded ? (
        <div className="local-connect-steps">
          <p>Run this inside the folder you want to share. The connection is read-only unless you add <code>--allow-write</code>.</p>
          <div className="attach-command">
            <span aria-hidden="true">$</span>
            <code>{command}</code>
            <CopyButton text={command} label="Copy local folder command" compact disabled={!origin} />
          </div>
          <form onSubmit={(event) => void claim(event)}>
            <label htmlFor="local-pair-code">Pairing code printed by Tress</label>
            <input
              id="local-pair-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              maxLength={32}
              required
            />
            <button type="submit" disabled={pending || !code.trim()}>
              {pending ? "Connecting…" : "Connect"}
            </button>
          </form>
          <p>Anyone with this thread’s private attach link can ask the agent to use the folder. File content read by the agent may enter the model and Harness Cloud conversation.</p>
        </div>
      ) : null}
      {device && !manageable ? <p className="local-connect-viewer">This folder is shared with this thread. Only its owner can disconnect it.</p> : null}
      {error ? <p className="local-connect-error" role="alert">{error}</p> : null}
    </div>
  );
}
