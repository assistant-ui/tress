import React from "react";
import { Thread } from "../components/Thread";
import { InstallLine } from "../components/InstallLine";

const FEATURES: { title: string; body: string }[] = [
  {
    title: "The session outlives the window",
    body: "A run lives in a thread on a host, not in your terminal. Close the lid mid-task and the agent keeps working. Come back and the transcript, the files, and the result are all there.",
  },
  {
    title: "Many clients, one run",
    body: "A thread is replicated state, so a terminal, a browser, and a phone can all watch the same run at once. Open this page twice and both follow along.",
  },
  {
    title: "Tiny native binary",
    body: "4.2 MB, no background service. It starts, does the work, and exits. Install it in a terminal, a CI job, or an agent sandbox.",
  },
  {
    title: "Runs in the browser",
    body: "The core carries no I/O of its own, so it compiles to 312 KB of WebAssembly and runs in a tab, in a worker, or on a server. No JSPI, no flags.",
  },
  {
    title: "You approve the shell",
    body: "Every command asks first. With no terminal attached, gated calls are denied rather than quietly run. File tools refuse paths that escape the workspace.",
  },
  {
    title: "Embeddable and model agnostic",
    body: "Tools and Provider are traits. Supply your own filesystem and transport and the loop is unchanged — the browser build is exactly that swap.",
  },
];

export default function HomePage() {
  return (
    <main className="page">
      <header className="top">
        <h1>Durable, tiny, native coding agent.</h1>
        <InstallLine />
        <p className="sub">
          v0.1.0 · 4.2 MiB · status: <span className="warn">experimental</span>
          <br />
          <span className="soft">
            early and changing often — the tool surface is deliberately small
          </span>
        </p>
      </header>

      <section className="demo">
        <Thread />
        <p className="note">
          This thread runs on the server, not in this tab. Start a run and then
          close the tab, or open this page in a second window — the work
          continues and every client sees the same thread.
        </p>
      </section>

      <section className="prose">
        <p>
          tress is a coding agent built around one idea: the session is a
          thread, and the thread is not owned by your terminal. The agent is a
          small Rust core with no I/O of its own, so the same engine runs as a
          native binary, inside a browser tab, and on a server driving a
          replicated thread.
        </p>
        <p>
          It reads and edits files, runs commands you approve, and reports what
          it did. Its output is closer to a Unix shell than an IDE.
        </p>
        <p>
          It is open source under MIT, model agnostic, and suitable for local
          work, CI, and hosted use.
        </p>
      </section>

      <div className="rule">* * *</div>

      <section className="features">
        {FEATURES.map((feature) => (
          <article key={feature.title}>
            <h2>{feature.title}</h2>
            <p>{feature.body}</p>
          </article>
        ))}
      </section>

      <footer>
        <a href="https://github.com/assistant-ui/tress">github</a>
        <a href="https://github.com/assistant-ui/statewire-rs">statewire</a>
        <span className="soft">MIT · built with farm.js</span>
      </footer>
    </main>
  );
}
