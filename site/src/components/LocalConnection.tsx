"use client";

import { useEffect, useRef, useState } from "react";
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
  const deviceRef = useRef(device);
  deviceRef.current = device;
  const [visible, setVisible] = useState(false);
  const [manageable, setManageable] = useState(false);
  const [pairingRequired, setPairingRequired] = useState(true);
  const [showPairing, setShowPairing] = useState(false);
  const [manualPairing, setManualPairing] = useState(false);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const command = `tress attach ${origin || "https://your-tress-site"} -s ${attachId} --ui`;
  const releasedCommand = `tress connect --site ${origin || "https://your-tress-site"} --root .`;

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
        setPairingRequired(data.pairingRequired !== false);
        setShowPairing(data.showPairing === true || data.pairingRequired !== false);
        setDevice(data.device);
        onDevice(data.device);
        setError("");
      } catch (cause) {
        if (alive) {
          setError((cause as Error).message);
          const unavailable = deviceRef.current ? { ...deviceRef.current, online: false } : null;
          setDevice(unavailable);
          onDevice(unavailable);
        }
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
    if (!window.confirm("Disconnect this folder from the thread? The files stay on its host."))
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
          <strong>host workspace</strong>
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
          <p><strong>Source preview.</strong> This combined file-sharing command requires a <a href="/docs/try#build-the-source-preview">CLI built from source</a>; the installer currently provides v0.3.0.</p>
          <p>Run this on your computer, VM, or remote host. It connects the whole filesystem accessible to that terminal and opens this chat. Add <code>--root /path/to/project</code> to restrict access to a folder, or <code>--allow-write</code> to allow edits. Shell execution is not included.</p>
          <div className="attach-command">
            <span aria-hidden="true">$</span>
            <code>{command}</code>
            <CopyButton text={command} label="Copy workspace connection command" compact disabled={!origin} />
          </div>
          {showPairing ? (
            <details>
              <summary>Using the released v0.3.0 CLI?</summary>
              <p>Run this in the folder you want to share, in a separate terminal. Enter its code in the pairing form below; choose “Have a pairing code?” to open it if needed. Add <code>--allow-write</code> to permit edits.</p>
              <div className="attach-command">
                <span aria-hidden="true">$</span>
                <code>{releasedCommand}</code>
                <CopyButton text={releasedCommand} label="Copy v0.3.0 folder connection command" compact disabled={!origin} />
              </div>
            </details>
          ) : null}
          {showPairing && !pairingRequired ? (
            <button
              type="button"
              aria-expanded={manualPairing}
              aria-controls="local-pair-form"
              onClick={() => setManualPairing((shown) => !shown)}
            >
              {manualPairing ? "Hide pairing form" : "Have a pairing code?"}
            </button>
          ) : null}
          {pairingRequired || (showPairing && manualPairing) ? (
            <form id="local-pair-form" onSubmit={(event) => void claim(event)}>
              <p>{pairingRequired ? "This host requires browser approval. " : ""}Enter the code printed by the terminal to connect.</p>
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
          ) : null}
          <p>Keep the terminal open while using its files. Anyone with this thread’s private attach link can access the shared scope, including personal files your terminal can read. Files read by the agent enter its model conversation.</p>
        </div>
      ) : null}
      {device && !manageable ? <p className="local-connect-viewer">This folder is shared with this thread. Only its owner can disconnect it.</p> : null}
      {error ? <p className="local-connect-error" role="alert">{error}</p> : null}
    </div>
  );
}
