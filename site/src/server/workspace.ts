import type { Workspace } from "@tress/workspaces";
import { createBashWorkspace } from "@tress/workspaces/just-bash";
import { SEED_FILES } from "./seed";

export function workspaceConfig() {
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
    localDemo: mode === "local" && process.env.TRESS_LOCAL_DEMO === "1",
    paths: paths as string[],
    writes:
      mode === "memory" ||
      mode === "overlay" ||
      process.env.TRESS_ALLOW_WRITES === "1",
  };
}

/** Replace this factory to use your own provider. Clients never choose a host path. */
export async function openWorkspace(): Promise<Workspace> {
  const { mode } = workspaceConfig();
  if (mode === "memory") return createBashWorkspace({ files: SEED_FILES() });
  if (mode === "local" || mode === "overlay") {
    const root = process.env.TRESS_WORKSPACE_ROOT;
    if (!root)
      throw new Error(
        "Set TRESS_WORKSPACE_ROOT to an existing local directory.",
      );
    const { createLocalWorkspace } = await import("@tress/workspaces/local");
    return createLocalWorkspace({
      root,
      mode: mode === "overlay" ? "overlay" : "read-write",
    });
  }
  const name = process.env.TRESS_SANDBOX_NAME;
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
