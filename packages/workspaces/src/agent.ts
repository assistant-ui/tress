import { createWorkspaceTools, type WorkspaceToolsOptions } from "./tools.js";
import type { AgentEvent, HostSessionConstructor, Workspace } from "./types.js";

export interface AgentOptions {
  /** TressHostSession from the generated Node or browser wasm-bindgen module. */
  Session: HostSessionConstructor;
  workspace: Workspace;
  /** An Anthropic Messages-compatible endpoint, or your proxy. */
  url: string;
  model: string;
  headers?: Record<string, string>;
  system?: string;
  tools?: WorkspaceToolsOptions;
  /** A trusted checkpoint previously returned by checkpoint(). */
  messages?: unknown[];
}

/** One model conversation and one workspace, independent of any UI. */
export function createAgent(options: AgentOptions) {
  const tools = createWorkspaceTools(options.workspace, options.tools);
  const session = new options.Session(
    options.url,
    options.model,
    options.headers ?? {},
    JSON.stringify(tools.schemas),
    async (name, raw) => {
      try {
        return JSON.stringify(await tools.execute(name, JSON.parse(raw)));
      } catch (error) {
        return JSON.stringify({
          content: error instanceof Error ? error.message : String(error),
          is_error: true,
        });
      }
    },
  );
  try {
    if (options.system !== undefined) session.setSystem(options.system);
    if (options.messages)
      session.restoreMessages(JSON.stringify(options.messages));
  } catch (error) {
    session.free();
    throw error;
  }
  let busy = false;
  let disposed = false;
  const ready = () => {
    if (disposed) throw new Error("Agent has been disposed.");
    if (busy) throw new Error("A turn is already running.");
  };
  return {
    workspace: options.workspace,
    async send(
      prompt: string,
      onEvent: (event: AgentEvent) => void = () => {},
    ) {
      ready();
      if (!prompt.trim()) throw new Error("A prompt is required.");
      busy = true;
      try {
        await session.send(prompt, (raw) =>
          onEvent(JSON.parse(raw) as AgentEvent),
        );
      } finally {
        busy = false;
      }
    },
    /** Persist separately from workspace files; contains model/tool history. */
    checkpoint(): unknown[] {
      ready();
      return JSON.parse(session.messages());
    },
    clear() {
      ready();
      session.restoreMessages("[]");
    },
    /** Frees the engine; does not delete files or stop a caller-owned sandbox. */
    dispose() {
      ready();
      session.free();
      disposed = true;
    },
  };
}

export type Agent = ReturnType<typeof createAgent>;
