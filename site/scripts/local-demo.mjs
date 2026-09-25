import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const site = fileURLToPath(new URL("../", import.meta.url));
const files = {
  "README.md": `# Local workspace demo

These are real files in site/.tress/local-demo on the host running tress.
Changes made from the browser or an attached terminal are saved to this folder.

Try asking tress to add a note to notes.md, or create a new text file.
Open the same folder in your editor to see the changes on disk.

The file tools and just-bash share this directory. Text commands such as
cat, grep, and sed work here. Native programs such as npm are not available
in this demo's simulated shell.

Clearing the conversation keeps these files. Restarting the demo keeps them too.
`,
  "notes.md": `# Notes

- This file lives on your computer.
- Your browser and attached terminal share the same workspace.
`,
};

/** Seed only missing files, so rerunning the demo preserves the user's edits. */
export async function prepareLocalDemo(root = join(site, ".tress/local-demo")) {
  await mkdir(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    try {
      await writeFile(join(root, name), content, { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  return root;
}

async function main() {
  const root = await prepareLocalDemo();
  const build = spawnSync("npm", ["run", "predev"], {
    cwd: site,
    stdio: "inherit",
  });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status ?? 1);
  const require = createRequire(import.meta.url);
  const cli = fileURLToPath(
    new URL(
      "bin/farm.js",
      pathToFileURL(require.resolve("@farm.js/cli/package.json")),
    ),
  );
  const args = process.argv.slice(2);
  console.log(`Local demo files: ${root}`);
  const child = spawn(
    process.execPath,
    [cli, "dev", ...(args.length ? args : ["--port", "5311"])],
    {
      cwd: site,
      stdio: "inherit",
      env: {
        ...process.env,
        TRESS_WORKSPACE: "local",
        TRESS_WORKSPACE_ROOT: root,
        TRESS_ALLOW_WRITES: "1",
        TRESS_VISIBLE_FILES: '[""]',
        TRESS_LOCAL_DEMO: "1",
      },
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 0;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
