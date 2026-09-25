import { realpath, stat } from "node:fs/promises";
import { OverlayFs, ReadWriteFs } from "just-bash";
import { createBashWorkspace, type BashWorkspaceOptions } from "./just-bash.js";
import type { Workspace } from "./types.js";

export interface LocalWorkspaceOptions {
  root: string;
  /** overlay reads the directory but keeps changes in memory. Default: read-write. */
  mode?: "read-write" | "overlay";
  maxFileReadSize?: number;
  bash?: Omit<NonNullable<BashWorkspaceOptions["bash"]>, "fs">;
}

/** Scoped disk access with a simulated shell; it does not launch host binaries. */
export async function createLocalWorkspace(
  options: LocalWorkspaceOptions,
): Promise<Workspace> {
  const root = await realpath(options.root);
  if (!(await stat(root)).isDirectory())
    throw new Error("Workspace root must be a directory.");
  const overlay = options.mode === "overlay";
  const fsOptions = {
    root,
    allowSymlinks: false,
    maxFileReadSize: options.maxFileReadSize ?? 1_048_576,
  };
  const fs = overlay
    ? new OverlayFs({ ...fsOptions, mountPoint: "/workspace" })
    : new ReadWriteFs(fsOptions);
  const workspace = createBashWorkspace({
    cwd: overlay ? "/workspace" : "/",
    bash: { ...options.bash, fs },
  });
  return { ...workspace, kind: overlay ? "local-overlay" : "local" };
}
