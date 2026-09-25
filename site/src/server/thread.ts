// The durable side of the demo.
//
// A thread's state lives in a statewire host in this server process, not in
// any browser tab. The agent that writes to it is the same Rust engine the
// binary runs, loaded here as a Node wasm module. So a run continues while
// every tab is closed, and any number of clients see the same thread.

import { createRequire } from "node:module";
import { resource } from "@assistant-ui/tap";
import { useStatewireCommands, useStatewireState } from "statewire/host";
import { StatewireSocketHost } from "statewire/host-internal";

const require = createRequire(import.meta.url);

type TressSession = {
  send: (prompt: string, onEvent: (raw: string) => void) => Promise<void>;
  files: () => Record<string, string>;
};

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

const CART = `export function cartTotal(items, discountPercent = 0) {
  return items.reduce((sum, item) => {
    const price = item.price * (1 - discountPercent / 100);
    return sum + Math.round(price * 100) / 100 * item.quantity;
  }, 0);
}
`;

const CART_TEST = `import { cartTotal } from "./cart.js";

test("applies a discount to the whole cart", () => {
  const items = [{ price: 9.99, quantity: 7 }];
  expect(cartTotal(items, 15)).toBe(59.44);
});
`;

const seedFiles = (): Record<string, string> => ({
  "cart.js": CART,
  "cart.test.js": CART_TEST,
});

const newId = () => Math.random().toString(36).slice(2, 10);

const createThreadElement = () =>
  resource(() => {
    const [state] = useStatewireState<ThreadState>(() => ({
      entries: [],
      status: "idle",
      files: seedFiles(),
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

        const { TressSession } = require("./pkg-node/tress_wasm.js") as {
          TressSession: new (
            url: string,
            model: string,
            headers: Record<string, string>,
            files: Record<string, string>,
          ) => TressSession;
        };
        // The server holds the key, so the agent calls the API directly
        // rather than looping back through this server's own proxy.
        const key = process.env.ANTHROPIC_API_KEY;
        if (!key) {
          state.entries[index].text =
            "No ANTHROPIC_API_KEY on the server, so this thread cannot run. Add one to site/.env.local and restart.";
          state.status = "idle";
          return;
        }
        const session = new TressSession(
          "https://api.anthropic.com/v1/messages",
          process.env.TRESS_MODEL ?? "claude-sonnet-5",
          { "x-api-key": key, "anthropic-version": "2023-06-01" },
          { ...state.files },
        );

        try {
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
          state.entries[index].text += `\n[error: ${String(error)}]`;
        } finally {
          state.status = "idle";
          state.runs += 1;
        }
      },

      /** Puts the thread back to its seeded state. */
      reset: () => {
        state.entries = [];
        state.files = seedFiles();
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
