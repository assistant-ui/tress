// Farm loads the WASM engine; credentials and workspace tools stay on the host.
import {
  createAgent,
  WORKSPACE_TOOLS,
  type Workspace,
  type WorkspaceToolsOptions,
} from "@tress/workspaces";
import { workspaceConfig } from "./workspace";

export const openSession = async (
  workspace: Workspace,
  options: Pick<WorkspaceToolsOptions, "onToolResult" | "onObserverError"> & {
    messages?: unknown[];
  } = {},
) => {
  const { messages, ...hooks } = options;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set on the server");
  const { TressHostSession } = await import("../wasm/pkg/tress_wasm.js");
  const { writes } = workspaceConfig();
  const virtual = workspace.kind !== "vercel";
  return createAgent({
    Session: TressHostSession,
    workspace,
    url: process.env.TRESS_API_URL ?? "https://api.anthropic.com/v1/messages",
    model: process.env.TRESS_MODEL ?? "claude-sonnet-5",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    system: `You are tress, a coding agent working in a shared workspace. Browser and terminal clients share this conversation and its files.
Answer questions directly. Only inspect or change files when needed for the user's request. Paths are relative to the workspace root.
${virtual ? "The shell is just-bash: simulated file and text commands, not a native operating system. Node, npm, git, and project test runners are not available. Never claim tests ran unless a tool actually ran them." : "Commands run inside the remote sandbox, with a timeout. Installed runtimes and dependencies belong to that sandbox."}
${writes ? "Read relevant files before editing, make the smallest useful change, and report what you verified." : "This workspace is read-only; explain proposed changes without trying to write files."}
Keep replies short and concrete.`,
    tools: { include: writes ? WORKSPACE_TOOLS : ["read", "ls"], ...hooks },
    messages,
  });
};
