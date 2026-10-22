import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AuiConfig, AuiProvider, ThreadPrimitive, MessagePrimitive, ComposerPrimitive } from "@assistant-ui/react";
import { HarnessThread } from "@assistant-ui/react-harness-sdk";
import { StatewireHttp } from "statewire";
import "./style.css";

function Message() {
  return <MessagePrimitive.Root className="message"><MessagePrimitive.Content /></MessagePrimitive.Root>;
}

function Chat() {
  const config = useMemo(() => AuiConfig({ thread: HarnessThread({
    transport: StatewireHttp({ url: new URL("/api/threads/main", window.location.origin).href }),
  }) }), []);
  return <AuiProvider config={config}><ThreadPrimitive.Root className="thread">
    <ThreadPrimitive.Viewport className="messages">
      <ThreadPrimitive.Empty><p className="muted">Send a message here, then continue from your terminal.</p></ThreadPrimitive.Empty>
      <ThreadPrimitive.Messages components={{ UserMessage: Message, AssistantMessage: Message }} />
    <ComposerPrimitive.Root className="composer">
      <ComposerPrimitive.Input placeholder="Message your existing agent…" aria-label="Message" />
      <ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
    </ComposerPrimitive.Root>
    </ThreadPrimitive.Viewport>
  </ThreadPrimitive.Root></AuiProvider>;
}

function App() {
  const [session, setSession] = useState();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState(false);
  const [copied, setCopied] = useState(false);
  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { "content-type": "application/json" } });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }
  async function refresh() { setSession(await api("/api/session")); }
  useEffect(() => { refresh().catch((error) => setError(error.message)); }, []);
  async function act(callback) {
    setPending(true); setError("");
    try { await callback(); } catch (error) { setError(error.message); }
    finally { setPending(false); }
  }
  const command = session?.endpoint ? `tress attach ${session.endpoint} --headers-file app-headers.json` : "";
  return <main>
    <header><a href="/">tress / existing app</a><span>source preview</span></header>
    <h1>One conversation. Two clients.</h1>
    <p className="muted">This reference app uses assistant-ui and a server-owned Harness thread. Its sample agent echoes your message. Replace the transport with your existing agent.</p>
    {error && <p role="alert" className="error">{error}</p>}
    {!session ? <p role="status">Loading session…</p> : !session.authenticated ?
      <form onSubmit={(event) => { event.preventDefault(); act(async () => {
        await api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
        setPassword(""); await refresh();
      }); }}>
        <label htmlFor="password">Application password</label>
        <input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
        <button disabled={pending}>{pending ? "Signing in…" : "Sign in"}</button>
      </form> : <>
        <Chat />
        <section aria-labelledby="terminal-title">
          <h2 id="terminal-title">Open in terminal</h2>
          <p>Download a one-hour grant for this conversation, then run the command in the folder where you saved it.</p>
          <button disabled={pending} onClick={() => act(async () => {
            const grant = await api("/api/connections", { method: "POST" });
            const url = URL.createObjectURL(new Blob([JSON.stringify(grant.headers, null, 2) + "\n"], { type: "application/json" }));
            const link = document.createElement("a"); link.href = url; link.download = "app-headers.json"; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setCreated(true); await refresh();
          })}>Download terminal credential</button>
          {created && <p role="status">Credential downloaded. Keep this file private.</p>}
          <pre><code>{`chmod 600 app-headers.json\n${command}`}</code></pre>
          <button onClick={() => act(async () => {
            await navigator.clipboard.writeText(`chmod 600 app-headers.json\n${command}`);
            setCopied(true); setTimeout(() => setCopied(false), 1500);
          })}>{copied ? "Copied" : "Copy command"}</button>
          <h2>Terminal access</h2>
          {session.connections.length === 0 ? <p className="muted">No active terminal grants.</p> :
            <ul>{session.connections.map((connection) => <li key={connection.id}>
              <span>Terminal {connection.id.slice(0, 8)} <small>expires {new Date(connection.expiresAt).toLocaleTimeString()}</small></span>
              <button disabled={pending} onClick={() => act(async () => {
                await api(`/api/connections/${connection.id}`, { method: "DELETE" }); await refresh();
              })}>Revoke</button>
            </li>)}</ul>}
          <p className="muted">Revoking a grant disconnects its terminal. This browser and the host's run stay active.</p>
        </section>
      </>}
    <footer>Application-owned identity · persistent thread · <a href="https://github.com/assistant-ui/tress">source</a></footer>
  </main>;
}

createRoot(document.getElementById("root")).render(<App />);
