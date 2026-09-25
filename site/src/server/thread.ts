// The durable side of the demo.
//
// A thread's state lives in a statewire host in this server process, not in
// any browser tab. The agent that writes to it is the same Rust engine the
// binary runs, loaded here as a Node wasm module. So a run continues while
// every tab is closed, and any number of clients see the same thread.

import { resource } from "@assistant-ui/tap";
import { useStatewireCommands, useStatewireState } from "statewire/host";
import { StatewireSocketHost } from "statewire/host-internal";
import { openSession, SEED_FILES } from "./agent";

type Entry = {
  id: string;
  role: "user" | "agent";
  text: string;
  tools: string[];
};

export type ThreadState = {
  entries: Entry[];
  status: "idle" | "running";
  files: Record<string, string>;
  /** Bumped on every run so clients can show that work happened while away. */
  runs: number;
};

const newId = () => Math.random().toString(36).slice(2, 10);

const createThreadElement = () =>
  resource(() => {
    const [state] = useStatewireState<ThreadState>(() => ({
      entries: [],
      status: "idle",
      files: SEED_FILES(),
      runs: 0,
    }));

    const commands = useStatewireCommands({
      /**
       * Runs one turn. The handler stays awaited while the agent works, and
       * every mutation inside it replicates to attached clients as it
       * happens — which is also what keeps the run going with nobody
       * attached.
       */
      send: async (prompt: string) => {
        if (typeof prompt !== "string" || !prompt.trim()) return;
        if (state.status === "running") return;

        state.entries.push({
          id: newId(),
          role: "user",
          text: prompt,
          tools: [],
        });
        state.status = "running";

        const reply: Entry = { id: newId(), role: "agent", text: "", tools: [] };
        state.entries.push(reply);
        const index = state.entries.length - 1;

        try {
          const session = openSession({ ...state.files });
          await session.send(prompt, (raw: string) => {
            const event = JSON.parse(raw) as {
              type: string;
              text?: string;
              summary?: string;
            };
            if (event.type === "text" && event.text) {
              state.entries[index].text += event.text;
            } else if (event.type === "tool" && event.summary) {
              state.entries[index].tools.push(event.summary);
            }
          });
          state.files = session.files();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          state.entries[index].text += message.includes("401")
            ? "The server's ANTHROPIC_API_KEY was rejected. Update site/.env.local and restart."
            : `\n[error: ${message}]`;
        } finally {
          state.status = "idle";
          state.runs += 1;
        }
      },

      /** Puts the thread back to its seeded state. */
      reset: () => {
        state.entries = [];
        state.files = SEED_FILES();
        state.status = "idle";
      },
    });

    return { state, commands };
  })();

// One host for the whole process: every visitor of the demo shares this
// thread, which is what makes the second tab show the first tab's run.
const globalKey = Symbol.for("tress.demo.thread");
type Holder = { host?: ReturnType<typeof StatewireSocketHost> };
const holder = ((globalThis as Record<symbol, unknown>)[globalKey] ??= {}) as Holder;

export const threadHost = (holder.host ??= StatewireSocketHost(
  createThreadElement(),
));
