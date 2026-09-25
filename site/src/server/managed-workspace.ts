import type { UIMessage } from "ai";
import { snapshotWorkspace, type Workspace } from "@tress/workspaces";
import { createBashWorkspace } from "@tress/workspaces/just-bash";
import { openWorkspace, workspaceConfig } from "./workspace";
import { SEED_FILES } from "./seed";

const key = Symbol.for("tress.managed.workspaces");
type Runtime = {
  workspaces: Map<string, Promise<Workspace>>;
  listeners: Set<(threadId: string, files: Record<string, string>) => void>;
};
const runtime = ((globalThis as Record<symbol, unknown>)[key] ??= {
  workspaces: new Map(),
  listeners: new Set(),
}) as Runtime;

export const contextFrom = (messages: UIMessage[]): unknown[] => {
  let context: unknown[] = [];
  for (const message of messages) {
    let restored = false;
    for (const part of message.parts ?? []) {
      if (
        message.role === "assistant" &&
        part.type === "data-tress-context" &&
        Array.isArray(part.data)
      ) {
        context = part.data;
        restored = true;
        break;
      }
    }
    if (restored) continue;
    const content = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (content) context = [...context, { role: message.role, content }];
  }
  return context;
};

const filesFrom = (messages: UIMessage[]) => {
  for (const message of [...messages].reverse()) {
    for (const part of message.parts ?? []) {
      if (
        part.type === "data-files" &&
        part.data &&
        typeof part.data === "object" &&
        !Array.isArray(part.data) &&
        Object.values(part.data).every((value) => typeof value === "string")
      )
        return part.data as Record<string, string>;
    }
  }
  return undefined;
};

export const managedWorkspace = (
  threadId: string,
  history: UIMessage[] = [],
) => {
  let workspace = runtime.workspaces.get(threadId);
  const config = workspaceConfig();
  const files = filesFrom(history);
  if (
    !workspace ||
    (files && (config.mode === "memory" || config.mode === "overlay"))
  ) {
    workspace = (async () => {
      if (config.mode === "memory")
        return createBashWorkspace({ files: files ?? SEED_FILES() });
      const value = await openWorkspace();
      if (config.mode === "overlay" && files)
        for (const [path, content] of Object.entries(files))
          await value.writeFile(path, content);
      return value;
    })();
    runtime.workspaces.set(threadId, workspace);
    void workspace.catch(() => runtime.workspaces.delete(threadId));
  }
  return workspace;
};

export const refreshManagedFiles = async (threadId: string) => {
  const paths = workspaceConfig().paths;
  const files = paths.length
    ? await snapshotWorkspace(await managedWorkspace(threadId), { paths })
    : {};
  for (const listener of runtime.listeners) listener(threadId, files);
  return files;
};

export const subscribeManagedFiles = (
  listener: (threadId: string, files: Record<string, string>) => void,
) => {
  runtime.listeners.add(listener);
  return () => {
    runtime.listeners.delete(listener);
  };
};

export const forgetManagedWorkspace = (threadId: string) => {
  runtime.workspaces.delete(threadId);
};
