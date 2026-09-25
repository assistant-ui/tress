/** Normalize a workspace-relative path without allowing a root escape. */
export function workspacePath(path: string): string {
  if (
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[a-z]:/i.test(path)
  )
    throw new Error("Use a path relative to the workspace root.");
  const parts = path.split("/").filter((part) => part && part !== ".");
  if (parts.includes(".."))
    throw new Error("Paths cannot escape the workspace root.");
  return parts.join("/");
}

export function filePath(path: string): string {
  const normalized = workspacePath(path);
  if (!normalized) throw new Error("A file path is required.");
  return normalized;
}
