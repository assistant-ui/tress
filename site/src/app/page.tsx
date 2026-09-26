import React from "react";
import { Threads } from "../components/Threads";
import { InstallLine } from "../components/InstallLine";

const SOURCE = "https://github.com/assistant-ui/tress";

export default function HomePage() {
  return (
    <div className="page">
      <a className="skip-link" href="#demo">
        Skip to terminal
      </a>
      <header className="site-header">
        <a className="wordmark" href="#" aria-label="tress home">
          tress
        </a>
        <span className="nav-divider" aria-hidden="true">
          /
        </span>
        <nav aria-label="Main navigation">
          <a href="#demo">try</a>
          <a href="#about">about</a>
          <a href={`${SOURCE}#readme`}>docs</a>
          <a href={SOURCE}>github ↗</a>
        </nav>
      </header>

      <main>
        <section className="intro" aria-labelledby="page-title">
          <h1 id="page-title">
            Tiny, native coding agent. One durable thread.
          </h1>
          <InstallLine />
          <p className="version">
            v0.1.0 · durable threads · status: <span>experimental</span>
          </p>
        </section>

        <section id="demo" aria-label="Live terminal demo">
          <Threads />
          <p className="demo-note">
            The agent runs on the host. Close this tab, attach a terminal, or
            open another window — the same thread is waiting.
          </p>
        </section>

        <section className="about" id="about" aria-label="About tress">
          <p>
            tress is a small coding agent written in Rust. It reads and edits
            files, works through a task, and keeps tool activity in the
            conversation.
          </p>
          <p>
            The session belongs to a thread. Your terminal and browser are just
            ways to connect to it. Start in one, follow along in the other, and
            pick up where you left off.
          </p>
          <p>
            Open source under MIT. A native binary, with the same core compiled
            to WebAssembly.
          </p>

          <div className="rule" aria-hidden="true">
            * * *
          </div>

          <article>
            <h2>A thread that stays with you</h2>
            <p>
              The host keeps working when every client disconnects. Reattach to
              recover the conversation and files. Managed Harness stores the
              conversation across server restarts. Local execution continues
              while the host is running.
            </p>
          </article>
          <article>
            <h2>A small tool surface</h2>
            <p>
              <code>read</code>, <code>write</code>, <code>edit</code>,{" "}
              <code>ls</code>, and <code>bash</code>. Local shell commands ask
              for approval in the native CLI. The shared host supports virtual
              files, a local directory, or a remote sandbox.
            </p>
          </article>
          <article>
            <h2>One engine, a few places to run</h2>
            <p>
              Use the native CLI in your project, or embed the Wasm core in a
              browser or server. Supply your own tools and provider; keep the
              agent loop.
            </p>
          </article>
        </section>
      </main>

      <footer>
        <a href={SOURCE}>github</a>
        <a href="https://github.com/assistant-ui/statewire-rs">statewire</a>
        <span>
          MIT · powered by <a href="https://harness-sdk.dev">harness-sdk</a>
        </span>
      </footer>
    </div>
  );
}
