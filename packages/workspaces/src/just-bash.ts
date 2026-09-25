import { Bash, type BashOptions } from "just-bash";
import { filePath, workspacePath } from "./paths.js";
import type { Workspace } from "./types.js";

export interface BashWorkspaceOptions {
  /** Keys are relative to the workspace root. */
  files?: Record<string, string>;
  /** Virtual root. Use / with ReadWriteFs; /workspace for a virtual filesystem. */
  cwd?: string;
  bash?: Omit<BashOptions, "files" | "cwd">;
}

/** File tools and shell commands share exactly the same just-bash filesystem. */
export function createBashWorkspace(
  options: BashWorkspaceOptions = {},
): Workspace {
  const cwd = options.cwd ?? "/workspace";
  if (!cwd.startsWith("/") || cwd.includes("..") || cwd.includes("\0"))
    throw new Error("cwd must be an absolute virtual directory.");
  const root = cwd.replace(/\/+$/, "") || "/";
  const resolve = (path: string) =>
    `${root === "/" ? "" : root}/${workspacePath(path)}`;
  const files = Object.fromEntries(
    Object.entries(options.files ?? {}).map(([path, content]) => [
      resolve(filePath(path)),
      content,
    ]),
  );
  const bash = new Bash({
    executionLimitProfile: "hardened",
    ...options.bash,
    cwd: root,
    files,
  });
  // The directory must exist even when there are no seed files.
  const ready = bash.fs.mkdir(root, { recursive: true });
  return {
    kind: "just-bash",
    async readFile(path) {
      await ready;
      return bash.fs.readFile(resolve(filePath(path)));
    },
    async writeFile(path, content) {
      await ready;
      const target = resolve(filePath(path));
      await bash.fs.mkdir(target.slice(0, target.lastIndexOf("/")) || "/", {
        recursive: true,
      });
      await bash.fs.writeFile(target, content);
    },
    async listFiles(path = "") {
      await ready;
      const directory = resolve(path);
      const entries = bash.fs.readdirWithFileTypes
        ? await bash.fs.readdirWithFileTypes(directory)
        : await Promise.all(
            (await bash.fs.readdir(directory)).map(async (name) => ({
              name,
              ...(await bash.fs.lstat(`${directory}/${name}`)),
            })),
          );
      return entries
        .filter(
          (entry) =>
            !entry.isSymbolicLink && (entry.isFile || entry.isDirectory),
        )
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory ? ("directory" as const) : ("file" as const),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async exec(command) {
      await ready;
      const { stdout, stderr, exitCode } = await bash.exec(command, {
        cwd: root,
      });
      return { stdout, stderr, exitCode };
    },
  };
}
