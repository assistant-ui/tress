import { posix } from "node:path";
import { filePath, workspacePath } from "./paths.js";
import type { Workspace } from "./types.js";

/** Structural interface: pass an @vercel/sandbox 3.5+ Sandbox directly. */
export interface VercelSandboxClient {
  fs: {
    readFile(path: string, encoding: "utf8"): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    mkdir(path: string, options: { recursive: true }): Promise<unknown>;
    readdir(
      path: string,
      options: { withFileTypes: true },
    ): Promise<
      Array<{
        name: string;
        isFile(): boolean;
        isDirectory(): boolean;
        isSymbolicLink(): boolean;
      }>
    >;
    realpath(path: string): Promise<string>;
  };
  runCommand(options: {
    cmd: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    timeoutMs: number;
  }): Promise<{
    exitCode: number;
    stdout(): Promise<string>;
    stderr(): Promise<string>;
  }>;
}

export interface VercelWorkspaceOptions {
  sandbox: VercelSandboxClient;
  /** Existing absolute directory inside the sandbox. */
  root?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/** The caller creates/resumes/stops the sandbox; this adapter only uses it. */
export async function createVercelWorkspace(
  options: VercelWorkspaceOptions,
): Promise<Workspace> {
  const { sandbox } = options;
  const requested = options.root ?? "/vercel/sandbox";
  if (!posix.isAbsolute(requested))
    throw new Error("Sandbox root must be absolute.");
  const root = await sandbox.fs.realpath(requested);
  const inside = (target: string) => {
    if (target !== root && !target.startsWith(root === "/" ? "/" : `${root}/`))
      throw new Error("Symlink escapes the workspace root.");
    return target;
  };
  const resolve = async (path: string, writing = false): Promise<string> => {
    const target = posix.join(root, workspacePath(path));
    // Validate each existing ancestor before mkdir/write; don't follow an
    // existing symlink outside root. The VM remains the shell security boundary.
    let current = root;
    for (const component of workspacePath(path).split("/").filter(Boolean)) {
      current = posix.join(current, component);
      try {
        inside(await sandbox.fs.realpath(current));
      } catch (error) {
        if (!writing || (error as { code?: string }).code !== "ENOENT")
          throw error;
        break;
      }
    }
    return target;
  };
  return {
    kind: "vercel",
    async readFile(path) {
      return sandbox.fs.readFile(await resolve(filePath(path)), "utf8");
    },
    async writeFile(path, content) {
      const target = await resolve(filePath(path), true);
      await sandbox.fs.mkdir(posix.dirname(target), { recursive: true });
      await sandbox.fs.writeFile(await resolve(path, true), content);
    },
    async listFiles(path = "") {
      const entries = await sandbox.fs.readdir(await resolve(path), {
        withFileTypes: true,
      });
      return entries
        .filter(
          (entry) =>
            !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()),
        )
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory()
            ? ("directory" as const)
            : ("file" as const),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async exec(command) {
      const result = await sandbox.runCommand({
        cmd: "bash",
        args: ["-c", command],
        cwd: root,
        env: options.env,
        timeoutMs: options.timeoutMs ?? 60_000,
      });
      const [stdout, stderr] = await Promise.all([
        result.stdout(),
        result.stderr(),
      ]);
      return { stdout, stderr, exitCode: result.exitCode };
    },
  };
}
