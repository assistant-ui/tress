import React from "react";
import { Terminal } from "../components/Terminal";
import { InstallLine } from "../components/InstallLine";

export default function HomePage() {
  return (
    <div className="wrap">
      <nav className="nav">
        <span className="brand">tress</span>
        <span className="ver">v0.1.0</span>
        <span className="spacer" />
        <a href="#demo">demo</a>
        <a href="#how">how it works</a>
        <a href="https://github.com/assistant-ui/tress">github</a>
      </nav>

      <header className="hero">
        <h1>A coding agent small enough to put anywhere.</h1>
        <p>
          One <strong>4.2 MB</strong> binary in your terminal, no background
          service. The same engine compiles to{" "}
          <strong>312 KB of WebAssembly</strong> and runs in a browser tab —
          which is what you are about to use.
        </p>
        <InstallLine />
        <p className="meta">
          macOS · Linux · Windows — MIT — reads and edits files, runs commands
          you approve
        </p>
      </header>

      <section id="demo" style={{ borderTop: 0, paddingTop: 8 }}>
        <p className="eyebrow">Try it here</p>
        <h2>A real bug, fixed in your browser.</h2>
        <p className="lede">
          The workspace on the right holds a shopping cart with a genuine
          rounding bug and a test that catches it. Ask the agent to find and fix
          it — it reads both files, works out the mechanism, and rewrites the
          function. No install, no key, no server doing the work.
        </p>
        <Terminal />
        <p className="meta">
          The agent, its tool loop, and its message parsing are all Rust
          compiled to wasm. Only the model call leaves the page.
        </p>
      </section>

      <section>
        <p className="eyebrow">What it is</p>
        <h2>Small, direct, and yours to embed.</h2>
        <div className="grid">
          <div className="cell">
            <h3>Five tools</h3>
            <p>
              <b>read</b>, <b>write</b>, <b>edit</b>, <b>ls</b>, <b>bash</b>.
              File tools are scoped to the directory you start in and refuse
              paths that escape it — symlinks included.
            </p>
          </div>
          <div className="cell">
            <h3>You approve the shell</h3>
            <p>
              Every command asks first. Answer <b>always</b> to stop being asked
              this session. With no terminal attached — a pipe, CI — gated calls
              are <b>denied</b>, never quietly run.
            </p>
          </div>
          <div className="cell">
            <h3>No background service</h3>
            <p>
              It starts, does the work, and exits. Nothing to install beyond one
              binary, nothing running when you are not using it.
            </p>
          </div>
          <div className="cell">
            <h3>Runs in a browser</h3>
            <p>
              The core carries no I/O of its own, so it builds for{" "}
              <b>wasm32</b> with an in-memory workspace. No JSPI, no special
              flags — any browser with WebAssembly.
            </p>
          </div>
          <div className="cell">
            <h3>Embeddable</h3>
            <p>
              <b>Tools</b> and <b>Provider</b> are traits. Supply your own
              filesystem and transport and the loop is unchanged — the browser
              build is that swap, and nothing else.
            </p>
          </div>
          <div className="cell">
            <h3>Model agnostic</h3>
            <p>
              Anthropic today, and any endpoint speaking the same shape. The
              page you are reading points the agent at its own proxy so no key
              ships to the client.
            </p>
          </div>
        </div>
      </section>

      <section id="how">
        <p className="eyebrow">How it works</p>
        <h2>One core, three surfaces.</h2>
        <p className="lede">
          The engine is a library that talks to two traits and reports events.
          It never touches a terminal, a socket, or a file — which is exactly
          why the same code runs in your shell and in this tab.
        </p>
        <div className="layers">
          <div className="layer">
            <div className="tag">surfaces</div>
            <div className="what">
              the <b>tress</b> binary · this <b>browser</b> build · your app, via
              the crate
            </div>
          </div>
          <p className="tween">↑ events out, prompts and approvals in ↑</p>
          <div className="layer">
            <div className="tag">engine — the part that never changes</div>
            <div className="what">
              the turn loop, the approval gate, and message assembly.{" "}
              <b>No I/O of its own.</b>
            </div>
          </div>
          <p className="tween">↑ two traits ↑</p>
          <div className="layer">
            <div className="tag">tools + provider — swapped per surface</div>
            <div className="what">
              native: real files and <b>sh</b> · browser: an in-memory workspace
              and <b>fetch</b>
            </div>
          </div>
        </div>
      </section>

      <section>
        <p className="eyebrow">Honest notes</p>
        <h2>What it does not do.</h2>
        <div className="tablewrap">
          <table>
            <tbody>
              <tr>
                <td>no shell in the browser</td>
                <td>
                  A tab has none, and a surface advertises only what it can
                  honor — so the browser build offers four tools, not five.
                </td>
              </tr>
              <tr>
                <td>no background daemon</td>
                <td>
                  Close the terminal and the run ends. Sessions that outlive the
                  window are the next thing being built, on{" "}
                  <a href="https://github.com/assistant-ui/statewire-rs">
                    statewire
                  </a>
                  .
                </td>
              </tr>
              <tr>
                <td>early</td>
                <td>
                  Version 0.1. The tool surface is deliberately small, and the
                  prompt is still being tuned against real work.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <footer>
        <span>tress — MIT</span>
        <span>
          <a href="https://github.com/assistant-ui/tress">github</a> · built with{" "}
          <a href="https://farmjs.dev">farm.js</a>
        </span>
      </footer>
    </div>
  );
}
