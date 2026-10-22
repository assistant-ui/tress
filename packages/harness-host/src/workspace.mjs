import { spawn } from "node:child_process";
import { open, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, relative, sep, dirname } from "node:path";

export async function machineWorkspace({ root, allowExec = false }) {
  root = await realpath(root);
  const pathFor = async (path = "", create = false) => {
    if (typeof path !== "string" || path.includes("\0"))
      throw new Error("Invalid workspace path");
    const target = resolve(root, path);
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`))
      throw new Error("Path must stay in the workspace");
    let part = root;
    for (const segment of rel.split(sep).filter(Boolean)) {
      part = resolve(part, segment);
      try {
        if ((await lstat(part)).isSymbolicLink())
          throw new Error("Workspace symlinks are not available");
      } catch (error) {
        if (!(create && error.code === "ENOENT")) throw error;
      }
    }
    return target;
  };
  return {
    kind: "machine",
    details: {
      environment: "device",
      access: "in-process",
      storage: "filesystem",
      writable: true,
      label: "host project",
      shell: allowExec ? "native" : "none",
    },
    async readFile(path) {
      const file = await open(
        await pathFor(path),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 1_048_576)
          throw new Error("File unavailable or larger than 1 MiB");
        return await file.readFile("utf8");
      } finally {
        await file.close();
      }
    },
    async writeFile(path, content) {
      const target = await pathFor(path, true);
      await mkdir(dirname(target), { recursive: true });
      const file = await open(
        target,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o644,
      );
      try {
        if (!(await file.stat()).isFile())
          throw new Error("Expected a regular file");
        await file.truncate(0);
        await file.writeFile(content);
      } finally {
        await file.close();
      }
    },
    async listFiles(path = "") {
      return (await readdir(await pathFor(path), { withFileTypes: true }))
        .filter((entry) => entry.isFile() || entry.isDirectory())
        .slice(0, 1000)
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
        }));
    },
    exec: allowExec
      ? (command) =>
          new Promise((resolve, reject) => {
            const child = spawn(
              process.env.SHELL || "/bin/sh",
              ["-c", command],
              {
                cwd: root,
                detached: process.platform !== "win32",
                stdio: ["ignore", "pipe", "pipe"],
                env: { ...process.env, AI_AGENT: "tress" },
              },
            );
            let stdout = "";
            let stderr = "";
            let size = 0;
            let terminated;
            let killTimer;
            const kill = (signal) => {
              if (!child.pid) return;
              try {
                process.platform === "win32"
                  ? child.kill(signal)
                  : process.kill(-child.pid, signal);
              } catch (error) {
                if (error.code !== "ESRCH") throw error;
              }
            };
            const terminate = (reason) => {
              if (terminated) return;
              terminated = reason;
              kill("SIGTERM");
              killTimer = setTimeout(() => kill("SIGKILL"), 1000);
            };
            const timer = setTimeout(
              () => terminate("Command exceeded the 120 second limit."),
              120_000,
            );
            const cleanup = () => {
              clearTimeout(timer);
              clearTimeout(killTimer);
            };
            const capture = (target) => (chunk) => {
              size += chunk.length;
              if (size > 1_048_576) terminate("Command output exceeded 1 MiB.");
              else if (target === "stdout") stdout += chunk;
              else stderr += chunk;
            };
            child.stdout.on("data", capture("stdout"));
            child.stderr.on("data", capture("stderr"));
            child.once("error", (error) => {
              cleanup();
              reject(error);
            });
            child.once("close", (code) => {
              cleanup();
              resolve({
                stdout,
                stderr: [stderr, terminated].filter(Boolean).join("\n"),
                exitCode: terminated ? 1 : (code ?? 1),
              });
            });
          })
      : undefined,
  };
}
