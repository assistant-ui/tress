// The durable side of the demo.
//
// A thread's state lives in a statewire host in this server process, not in
// any browser tab. The agent that writes to it is the same Rust engine the
// binary runs, loaded through Farm's WASM plugin. So a run continues while
// every tab is closed, and any number of clients see the same thread.

import { resource } from "@assistant-ui/tap";
import { useEffect } from "@assistant-ui/tap/react-shim";
import { useStatewireCommands, useStatewireState } from "statewire/host";
import { StatewireSocketHost } from "statewire/host-internal";
import {
  snapshotWorkspace,
  type Agent,
  type Workspace,
} from "@tress/workspaces";
import { openSession } from "./agent";
import { SEED_FILES } from "./seed";
import { openWorkspace, workspaceConfig } from "./workspace";
import type { Entry, ThreadState } from "../lib/thread";
import { createPresenceTracker } from "./presence";

const newId = () => Math.random().toString(36).slice(2, 10);

const createThreadElement = (presence: ReturnType<typeof createPresenceTracker>, scope?: string) => {
  const config = workspaceConfig(scope);
  let session: Agent | undefined;
  let workspace: Promise<Workspace> | undefined;
  let initialized = false;
  let previewRevision = 0;
  const getWorkspace = () =>
    (workspace ??= openWorkspace(scope).catch((error) => {
      workspace = undefined;
      throw error;
    }));
  return resource(() => {
    const [state] = useStatewireState<ThreadState>(() => ({
      entries: [],
      status: "idle",
      files: config.mode === "memory" ? SEED_FILES() : {},
      runs: 0,
      clients: [],
    }));

    useEffect(
      () => presence.subscribe((clients) => (state.clients = clients)),
      [],
    );

    const refreshFiles = async () => {
      const revision = ++previewRevision;
      const files = config.paths.length
        ? await snapshotWorkspace(await getWorkspace(), { paths: config.paths })
        : {};
      if (revision === previewRevision) state.files = files;
    };
    if (!initialized) {
      initialized = true;
      void refreshFiles().catch((error) =>
        console.error("Workspace initialization failed:", error),
      );
    }

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

        const reply: Entry = {
          id: newId(),
          role: "agent",
          text: "",
          tools: [],
        };
        state.entries.push(reply);
        const index = state.entries.length - 1;

        try {
          session ??= await openSession(await getWorkspace(), {
            onToolResult: refreshFiles,
            onObserverError: (error) =>
              console.error("File preview failed:", error),
          });
          await session.send(prompt, (event) => {
            if (event.type === "text" && event.text) {
              state.entries[index].text += event.text;
            } else if (event.type === "tool" && event.summary) {
              state.entries[index].tools.push(event.summary);
            }
          });
          await refreshFiles();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          state.entries[index].error = true;
          state.entries[index].text += message.includes("401")
            ? "The server's ANTHROPIC_API_KEY was rejected. Update site/.env.local and restart."
            : `\n[error: ${message}]`;
        } finally {
          state.status = "idle";
          state.runs += 1;
        }
      },

      /** Clears model context; only the disposable demo resets its files. */
      reset: async () => {
        // Another attached client must not clear an in-flight reply.
        if (state.status === "running") return;
        state.status = "running";
        try {
          session?.dispose();
          session = undefined;
          if (config.mode === "memory") workspace = undefined;
          await refreshFiles();
          state.entries = [];
          state.runs = 0;
        } finally {
          state.status = "idle";
        }
      },
    });

    return { state, commands };
  })();
};

// One host for the whole process: every visitor of the demo shares this
// thread, which is what makes the second tab show the first tab's run.
const globalKey = Symbol.for("tress.demo.thread");
type ThreadBackend = {
  host: ReturnType<typeof StatewireSocketHost>;
  presence: ReturnType<typeof createPresenceTracker>;
};
type Holder = { backend?: ThreadBackend; backends?: Map<string, ThreadBackend> };
const holder = ((globalThis as Record<symbol, unknown>)[globalKey] ??=
  {}) as Holder;

const createThreadBackend = (scope?: string): ThreadBackend => {
  const presence = createPresenceTracker();
  return {
    host: StatewireSocketHost(createThreadElement(presence, scope)),
    presence,
  };
};

export const localThreadBackend = (scope?: string) => {
  if (!scope) return holder.backend ??= createThreadBackend();
  const backends = holder.backends ??= new Map();
  let backend = backends.get(scope);
  if (!backend) backends.set(scope, backend = createThreadBackend(scope));
  return backend;
};
