// Rebuild the vendored preview from a clean, pinned upstream Git snapshot.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const revision = "c07dab9b1eb32a3800d2bad25e807efa0cfeedef";
const upstream = process.argv[2];
if (!upstream) throw new Error("Usage: node scripts/pack-harness-preview.mjs /path/to/harness-sdk");
const destination = fileURLToPath(new URL("../vendor/", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "tress-harness-preview-"));
try {
  const archive = execFileSync("git", ["-C", resolve(upstream), "archive", revision,
    "packages/harness-sdk/ai-sdk", "packages/harness-sdk/assistant-ui", "packages/statewire/node", "LICENSE"]);
  execFileSync("tar", ["-x", "-C", temporary], { input: archive });
  for (const relative of ["packages/harness-sdk/ai-sdk", "packages/harness-sdk/assistant-ui", "packages/statewire/node"]) {
    const dir = join(temporary, relative);
    const original = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    await mkdir(join(dir, "dist"), { recursive: true });
    await build({ absWorkingDir: dir, entryPoints: ["src/index.ts"], outfile: "dist/index.js",
      bundle: true, packages: "external", platform: "neutral", format: "esm", target: "es2022", jsx: "automatic", tsconfigRaw: {} });
    await writeFile(join(dir, "LICENSE"), await readFile(join(temporary, "LICENSE")));
    const peers = { ...original.dependencies, ...original.peerDependencies };
    delete peers.next;
    for (const name of Object.keys(peers)) {
      if (peers[name] === "workspace:*") peers[name] = name === "statewire" ? "0.19.4" : "0.3.0";
    }
    await writeFile(join(dir, "package.json"), JSON.stringify({
      name: original.name, version: original.version, private: true, type: "module", license: "MIT",
      tressPreviewSource: { repository: "https://github.com/assistant-ui/harness-sdk", revision, directory: relative },
      exports: { ".": { types: "./src/index.ts", import: "./dist/index.js" } },
      files: ["dist", "src", "LICENSE", "README.md"], peerDependencies: peers,
    }, null, 2) + "\n");
    execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", destination], { cwd: dir, stdio: "pipe" });
    process.stdout.write(`Packed ${original.name} from ${revision}\n`);
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
