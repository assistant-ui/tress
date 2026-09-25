import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resource } from "@assistant-ui/tap";
import { Harness, HarnessCloud } from "harness-sdk";
import { useEffect } from "@assistant-ui/tap/react-shim";
import { useStatewireCommands, useStatewireState } from "statewire/host";
import { StatewireSocketHost } from "statewire/host-internal";
import type { Entry, ThreadState } from "../lib/thread";
import type { ThreadMode } from "./config";
import { workspaceConfig } from "./workspace";
import {
  forgetManagedWorkspace,
  refreshManagedFiles,
  subscribeManagedFiles,
} from "./managed-workspace";
import { createPresenceTracker } from "./presence";

type CloudMode = Extract<ThreadMode, { kind: "cloud" }>;
const validId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9._~-]+$/.test(id);

export const managedEntries = (messages: readonly Harness.Message[]): Entry[] =>
  messages.map((message) => ({
    id: message.id,
    role: message.role === "user" ? "user" : "agent",
    text: message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
    tools: message.parts
      .filter((part) => part.type === "tool")
      .map((part) =>
        typeof part.input.summary === "string"
          ? part.input.summary
          : part.toolName,
      ),
  }));

/** The SDK's managed connection and loopback tunnel live on the host, not in a tab. */
export const createManagedGateway = async (
  config: CloudMode,
  factory?: (threadId: string) => Harness,
) => {
  const presence = createPresenceTracker();
  const namespace = createHash("sha256")
    .update(
      JSON.stringify([
        config.origin,
        config.workspaceId,
        config.initialThreadId,
      ]),
    )
    .digest("hex")
    .slice(0, 20);
  const directory = resolve(process.env.HARNESS_STATE_DIR ?? ".tress/harness");
  const path = join(directory, `${namespace}.json`);
  let threadId = config.initialThreadId;
  try {
    threadId = JSON.parse(await readFile(path, "utf8")).threadId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!validId(threadId))
    throw new Error("Invalid persisted HARNESS_THREAD_ID.");
  const save = async (id: string) => {
    await mkdir(directory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ threadId: id }), {
      mode: 0o600,
    });
    await rename(temporary, path);
  };
  await save(threadId);
  const connect = () =>
    factory?.(threadId) ??
    new Harness({
      transport: HarnessCloud({
        origin: config.origin,
        workspaceId: config.workspaceId,
        threadId,
        url: config.backendUrl,
        credential: () => {
          const key = process.env.HARNESS_API_KEY;
          if (!key) throw new Error("HARNESS_API_KEY is not configured.");
          return Promise.resolve(key);
        },
      }),
    });
  let harness = connect();
  let unsubscribe = () => {};
  let sending = false;
  let notify = () => {};
  const virtualFiles = ["memory", "overlay"].includes(workspaceConfig().mode);
  let restoredFiles = false;
  const info = (): NonNullable<ThreadState["harness"]> => {
    const error = harness.transport.error?.message ?? harness.error?.message;
    return {
      threadId,
      origin: config.origin,
      workspaceId: config.workspaceId,
      connection:
        harness.isLoading && harness.transport.status === "connected"
          ? "connecting"
          : harness.transport.status,
      ...(error ? { error } : {}),
    };
  };
  const element = resource(() => {
    const [state] = useStatewireState<ThreadState>(() => ({
      entries: [],
      status: "idle",
      files: {},
      runs: 0,
      clients: [],
      harness: info(),
    }));
    useEffect(
      () => presence.subscribe((clients) => (state.clients = clients)),
      [],
    );
    const sync = () => {
      const entries = managedEntries(harness.messages);
      if (harness.error && entries.at(-1)?.role === "agent") {
        const last = entries.at(-1)!;
        last.error = true;
        if (!last.text) last.text = harness.error.message;
      }
      state.entries = entries;
      state.status =
        sending ||
        harness.isBusy ||
        harness.status === "submitted" ||
        harness.status === "streaming"
          ? "running"
          : "idle";
      state.runs =
        entries.filter((entry) => entry.role === "agent").length -
        (state.status === "running" && entries.at(-1)?.role === "agent"
          ? 1
          : 0);
      state.harness = info();
      if (virtualFiles && state.status === "idle") {
        const data = harness.messages.at(-1)?.metadata?.provider?.tress as
          { files?: unknown } | undefined;
        const files = data?.files;
        if (
          files &&
          typeof files === "object" &&
          !Array.isArray(files) &&
          Object.values(files).every((content) => typeof content === "string")
        ) {
          restoredFiles = true;
          state.files = files as Record<string, string>;
        }
      }
    };
    notify = sync;
    useEffect(() => {
      unsubscribe = harness.subscribe(() => notify());
      const stopFiles = subscribeManagedFiles((id, files) => {
        if (
          id === threadId &&
          (!restoredFiles || state.status === "running" || !virtualFiles)
        )
          state.files = files;
      });
      sync();
      void refreshManagedFiles(threadId).catch((error) => {
        state.harness = { ...info(), error: `Workspace: ${error.message}` };
      });
      return () => {
        unsubscribe();
        stopFiles();
      };
    }, []);
    const commands = useStatewireCommands({
      send: async (prompt: string) => {
        if (typeof prompt !== "string" || !prompt.trim())
          throw new Error("A prompt is required.");
        if (sending || harness.isBusy)
          throw new Error("Wait for the current run to finish.");
        if (harness.transport.status !== "connected" || harness.isLoading)
          throw new Error(
            info().error ?? "Managed Harness is not connected yet.",
          );
        sending = true;
        sync();
        try {
          await harness.sendMessage(prompt.trim());
        } finally {
          sending = false;
          notify();
        }
      },
      reset: async () => {
        if (sending || harness.isBusy)
          throw new Error("Wait for the current run to finish.");
        if (harness.transport.status !== "connected")
          throw new Error("Reconnect before starting a new thread.");
        sending = true;
        sync();
        try {
          const nextId = `tress-${randomUUID()}`;
          await save(nextId);
          unsubscribe();
          harness.dispose();
          forgetManagedWorkspace(threadId);
          threadId = nextId;
          restoredFiles = false;
          harness = connect();
          unsubscribe = harness.subscribe(() => notify());
          state.files = {};
          await refreshManagedFiles(threadId);
        } finally {
          sending = false;
          notify();
        }
      },
    });
    return { state, commands };
  })();
  let host: ReturnType<typeof StatewireSocketHost>;
  try {
    host = StatewireSocketHost(element);
  } catch (error) {
    harness.dispose();
    throw error;
  }
  return {
    host,
    presence,
    info,
    dispose: () => {
      host.dispose();
      harness.dispose();
    },
  };
};

const key = Symbol.for("tress.managed.gateway");
type Holder = {
  gateway?: Promise<Awaited<ReturnType<typeof createManagedGateway>>>;
};
const holder = ((globalThis as Record<symbol, unknown>)[key] ??= {}) as Holder;
export const managedGateway = (config: CloudMode) =>
  (holder.gateway ??= createManagedGateway(config).catch((error) => {
    holder.gateway = undefined;
    throw error;
  }));
