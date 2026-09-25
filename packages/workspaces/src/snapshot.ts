import { workspacePath } from "./paths.js";
import type { Workspace } from "./types.js";

export interface SnapshotOptions {
  /** Explicit files/directories to share. Empty means share nothing. Use [""] to scan the root. */
  paths: string[];
  maxFiles?: number;
  maxFileChars?: number;
  maxTotalChars?: number;
  maxEntries?: number;
  maxDepth?: number;
  /** Additional filter. Applied to directories before traversing them. */
  include?: (path: string) => boolean;
}
const excluded = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  "coverage",
]);

/** A bounded text preview, not storage, a backup, or the workspace itself. */
export async function snapshotWorkspace(
  workspace: Workspace,
  options: SnapshotOptions,
): Promise<Record<string, string>> {
  const files: Record<string, string> = Object.create(null);
  let count = 0,
    total = 0,
    scanned = 0;
  const maxFiles = options.maxFiles ?? 100;
  const maxFile = options.maxFileChars ?? 100_000;
  const maxTotal = options.maxTotalChars ?? 500_000;
  const maxEntries = options.maxEntries ?? 1_000;
  const maxDepth = options.maxDepth ?? 8;
  for (const value of [maxFiles, maxFile, maxTotal, maxEntries, maxDepth]) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("Snapshot limits must be nonnegative integers.");
  }
  const include = (path: string) =>
    !path
      .split("/")
      .some(
        (part) =>
          part.startsWith(".") ||
          excluded.has(part) ||
          /\.(pem|key|p12|pfx)$/i.test(part),
      ) &&
    (options.include?.(path) ?? true);
  const visit = async (
    path: string,
    depth: number,
    kind?: "file" | "directory",
  ): Promise<void> => {
    if (
      scanned >= maxEntries ||
      count >= maxFiles ||
      total >= maxTotal ||
      depth > maxDepth ||
      !include(path)
    )
      return;
    scanned++;
    if (kind !== "directory" && path) {
      try {
        const content = await workspace.readFile(path);
        if (
          content.length <= maxFile &&
          total + content.length <= maxTotal &&
          !content.includes("\0") &&
          !Object.hasOwn(files, path)
        ) {
          files[path] = content;
          count++;
          total += content.length;
        }
        return;
      } catch {
        if (kind === "file") return;
      }
    }
    for (const entry of await workspace.listFiles(path)) {
      if (scanned >= maxEntries || count >= maxFiles || total >= maxTotal)
        break;
      // Do not trust directory entries from third-party adapters.
      if (
        !entry.name ||
        entry.name.includes("/") ||
        entry.name === "." ||
        entry.name === ".."
      )
        continue;
      await visit(
        workspacePath(path ? `${path}/${entry.name}` : entry.name),
        depth + 1,
        entry.type,
      );
    }
  };
  for (const path of options.paths) {
    try {
      await visit(workspacePath(path), 0);
    } catch {
      /* Missing or unreadable previews don't fail the model's tool call. */
    }
  }
  return files;
}
