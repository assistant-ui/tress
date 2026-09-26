import type { Workspace } from "@tress/workspaces";
import { createBashWorkspace } from "@tress/workspaces/just-bash";
import { SEED_FILES } from "./seed";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export function workspaceConfig(scope?: string) {
  if (scope && !/^[a-f0-9-]{36}$/.test(scope))
    throw new Error("Invalid workspace id.");
  const mode = process.env.TRESS_WORKSPACE ?? "memory";
  if (!["memory", "local", "overlay", "vercel"].includes(mode))
    throw new Error(`Unknown TRESS_WORKSPACE: ${mode}`);
  const visible = process.env.TRESS_VISIBLE_FILES;
  const paths: unknown = visible
    ? JSON.parse(visible)
    : mode === "memory"
      ? [""]
      : [];
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string"))
    throw new Error(
      "TRESS_VISIBLE_FILES must be a JSON array of relative paths.",
    );
  return {
    mode,
    root:
      mode === "local" && scope && process.env.TRESS_WORKSPACE_ROOT
        ? join(process.env.TRESS_WORKSPACE_ROOT, "threads", scope)
        : process.env.TRESS_WORKSPACE_ROOT,
    localDemo: mode === "local" && process.env.TRESS_LOCAL_DEMO === "1",
    paths: paths as string[],
    writes:
      mode === "memory" ||
      mode === "overlay" ||
      process.env.TRESS_ALLOW_WRITES === "1",
  };
}

/** Describe the host workspace without exposing remote or overlay host paths. */
export function workspaceInfo(scope?: string) {
  const { mode, root } = workspaceConfig(scope);
  return {
    mode,
    ...(mode === "local" && root ? { root: resolve(root) } : {}),
  };
}

/** Replace this factory to use your own provider. Clients never choose a host path. */
export async function openWorkspace(scope?: string): Promise<Workspace> {
  const { mode, root, localDemo } = workspaceConfig(scope);
  if (mode === "memory") return createBashWorkspace({ files: SEED_FILES() });
  if (mode === "local" || mode === "overlay") {
    if (!root)
      throw new Error(
        "Set TRESS_WORKSPACE_ROOT to an existing local directory.",
      );
    if (scope && mode === "local") {
      await mkdir(root, { recursive: true });
      if (localDemo) {
        const files = {
          "README.md":
            "# Your local workspace\n\nThese files belong to your demo thread. Browser and terminal clients attached to this thread share them.\n",
          "notes.md":
            "# Notes\n\n- This file lives on the host running tress.\n- Your browser and attached terminal share this workspace.\n",
        };
        for (const [name, content] of Object.entries(files)) {
          try {
            await writeFile(join(root, name), content, { flag: "wx" });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
      }
    }
    const { createLocalWorkspace } = await import("@tress/workspaces/local");
    return createLocalWorkspace({
      root,
      mode: mode === "overlay" ? "overlay" : "read-write",
    });
  }
  const template = process.env.TRESS_SANDBOX_NAME;
  if (scope && !template?.includes("{threadId}"))
    throw new Error(
      "Isolated remote demos need a separate sandbox per thread. Set TRESS_SANDBOX_NAME with a {threadId} placeholder and provision those sandboxes in your workspace factory.",
    );
  const name = scope ? template?.replaceAll("{threadId}", scope) : template;
  if (!name)
    throw new Error("Set TRESS_SANDBOX_NAME to a sandbox you created.");
  const [{ Sandbox }, { createVercelWorkspace }] = await Promise.all([
    import("@vercel/sandbox"),
    import("@tress/workspaces/vercel"),
  ]);
  const sandbox = await Sandbox.get({ name });
  return createVercelWorkspace({
    sandbox,
    root: process.env.TRESS_WORKSPACE_ROOT ?? "/vercel/sandbox",
  });
}
