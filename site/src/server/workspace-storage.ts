import type { Workspace } from "@tress/workspaces";

/** Durable text files are separate from the filtered, bounded UI previews. */
export async function workspaceFiles(workspace: Workspace) {
  const files: Record<string, string> = Object.create(null);
  let entries = 0;
  let bytes = 0;
  const walk = async (directory: string, depth: number) => {
    if (depth > 32)
      throw new Error(
        "Hosted demo directories cannot be deeper than 32 levels.",
      );
    for (const entry of await workspace.listFiles(directory)) {
      if (++entries > 1000)
        throw new Error("Hosted demo workspaces are limited to 1,000 entries.");
      if (
        !entry.name ||
        entry.name === "." ||
        entry.name === ".." ||
        entry.name.includes("/")
      )
        throw new Error("Invalid workspace entry.");
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.type === "directory") await walk(path, depth + 1);
      else {
        const content = await workspace.readFile(path);
        bytes += Buffer.byteLength(content);
        if (bytes > 10 * 1024 * 1024)
          throw new Error(
            "Hosted demo workspaces are limited to 10 MB of text.",
          );
        files[path] = content;
      }
    }
  };
  await walk("", 0);
  return files;
}
