import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resource } from "@assistant-ui/tap";
import { Harness, HarnessCloud } from "harness-sdk";
import { useEffect } from "@assistant-ui/tap/react-shim";
import { useStatewireCommands, useStatewireState } from "statewire/host";
import { StatewireSocketHost } from "statewire/host-internal";
import type { StatewireHostInternal } from "statewire/host-internal";
import type { Entry, ThreadState } from "../lib/thread";
import type { ThreadMode } from "./config";
import { workspaceConfig } from "./workspace";
import {
  forgetManagedWorkspace,
  refreshManagedFiles,
  subscribeManagedFiles,
} from "./managed-workspace";
import { createPresenceTracker } from "./presence";
import { managedBackendUrl } from "./managed-backend";

export type GatewaySession = {
  scope: string;
  threadId: string;
  selectThread: (id: string) => Promise<void>;
};

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
  session?: GatewaySession,
  persistence?: StatewireHostInternal.SocketHostPersistence,
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
  let threadId = session?.threadId ?? config.initialThreadId;
  try {
    if (!session) threadId = JSON.parse(await readFile(path, "utf8")).threadId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!validId(threadId))
    throw new Error("Invalid persisted HARNESS_THREAD_ID.");
  const save = async (id: string) => {
    if (session) return session.selectThread(id);
    await mkdir(directory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ threadId: id }), {
      mode: 0o600,
    });
    await rename(temporary, path);
  };
  if (!session) await save(threadId);
  const connect = async () => {
    if (factory) return factory(threadId);
    const backendUrl = session
      ? await managedBackendUrl(config, session.scope, threadId)
      : config.backendUrl;
    return new Harness({
      transport: HarnessCloud({
        origin: config.origin,
        workspaceId: config.workspaceId,
        threadId,
        url: backendUrl,
        credential: () => {
          const key = process.env.HARNESS_API_KEY;
          if (!key) throw new Error("HARNESS_API_KEY is not configured.");
          return Promise.resolve(key);
        },
      }),
    });
  };
  let harness = await connect();
  let unsubscribe = () => {};
  let sending = false;
  let pending: Promise<unknown> = Promise.resolve();
  let remoteFiles = false;
  let setFiles = (_files: Record<string, string>) => {};
  let notify = () => {};
  let disposed = false;
  let reconnecting: Promise<void> | undefined;
  const reconnect = () => {
    if (reconnecting) return reconnecting;
    if (
      disposed ||
      sending ||
      harness.isBusy ||
      harness.transport.status !== "stopped"
    )
      return Promise.resolve();
    reconnecting = (async () => {
      const next = await connect();
      if (disposed) {
        next.dispose();
        return;
      }
      unsubscribe();
      harness.dispose();
      harness = next;
      unsubscribe = harness.subscribe(() => notify());
      notify();
    })().finally(() => {
      reconnecting = undefined;
    });
    return reconnecting;
  };
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
    setFiles = (files) => {
      remoteFiles = true;
      state.files = files;
    };
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
      if (virtualFiles && !remoteFiles) {
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
      void refreshManagedFiles(threadId, session?.scope).catch((error) => {
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
          pending = harness.sendMessage(prompt.trim());
          await pending;
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
          harness = await connect();
          unsubscribe = harness.subscribe(() => notify());
          state.files = {};
          await refreshManagedFiles(threadId, session?.scope);
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
    host = StatewireSocketHost(element, undefined, persistence);
  } catch (error) {
    harness.dispose();
    throw error;
  }
  return {
    host,
    presence,
    info,
    reconnect,
    drain: () => pending.catch(() => {}),
    setFiles: (files: Record<string, string>) => setFiles(files),
    dispose: () => {
      disposed = true;
      host.dispose();
      harness.dispose();
    },
  };
};

const key = Symbol.for("tress.managed.gateway");
// Bump when the cached host's shape or resource wiring changes. Farm reloads
// routes without clearing globalThis, so an older host can outlive its callers.
const GATEWAY_VERSION = 2;
type Holder = {
  version?: number;
  gateway?: Promise<Awaited<ReturnType<typeof createManagedGateway>>>;
};
const holder = ((globalThis as Record<symbol, unknown>)[key] ??= {}) as Holder;
const sessionsKey = Symbol.for("tress.managed.session-gateways.v1");
const sessions = ((globalThis as Record<symbol, unknown>)[sessionsKey] ??=
  new Map()) as Map<string, Holder>;
export const managedGateway = (config: CloudMode, session?: GatewaySession) => {
  let cache = holder;
  if (session) {
    const id = JSON.stringify([
      config.origin,
      config.workspaceId,
      session.scope,
    ]);
    cache = sessions.get(id) ?? {};
    sessions.set(id, cache);
  }
  if (cache.version !== GATEWAY_VERSION || !cache.gateway) {
    const previous = cache.gateway;
    cache.version = GATEWAY_VERSION;
    const gateway = (async () => {
      // Retire the old tunnel and streams before opening their replacement.
      // The persisted thread id keeps the managed conversation intact.
      const stale = await previous?.catch(() => undefined);
      stale?.dispose();
      return createManagedGateway(config, undefined, session);
    })();
    cache.gateway = gateway;
    void gateway.catch(() => {
      if (cache.gateway === gateway) cache.gateway = undefined;
    });
  }
  return cache.gateway;
};
