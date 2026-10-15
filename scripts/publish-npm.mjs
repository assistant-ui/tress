import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platforms } from "../packages/cli/lib/platform.mjs";

export function publishPackages(directory, { run = execFileSync, log = console.log } = {}) {
  const packages = JSON.parse(readFileSync(resolve(directory, "release.json"), "utf8"));
  const names = [...platforms.map(({ name }) => name), "@assistant-ui/tress"];
  if (packages.length !== names.length || packages.some((pkg, index) => pkg.name !== names[index] || pkg.version !== packages[0].version)) {
    throw new Error("Expected four native packages followed by @assistant-ui/tress, all at the same version.");
  }
  // Validate the entire artifact set before publishing any package.
  for (const pkg of packages) {
    if (basename(pkg.filename) !== pkg.filename) throw new Error("Invalid release manifest.");
    const integrity = `sha512-${createHash("sha512").update(readFileSync(resolve(directory, pkg.filename))).digest("base64")}`;
    if (integrity !== pkg.integrity) throw new Error(`Integrity mismatch for ${pkg.filename}`);
  }
  const registry = "https://registry.npmjs.org";
  for (const pkg of packages) {
    let published;
    try {
      published = JSON.parse(run("npm", ["view", `${pkg.name}@${pkg.version}`, "dist.integrity", "--json", `--registry=${registry}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    } catch (error) {
      let code;
      try { code = JSON.parse(error.stdout).error?.code; } catch { /* Preserve unexpected registry failures below. */ }
      if (code !== "E404") throw error;
    }
    if (published) {
      if (published !== pkg.integrity) throw new Error(`${pkg.name}@${pkg.version} already exists with different contents. Use a new version.`);
      log(`Already published: ${pkg.name}@${pkg.version}`);
      continue;
    }
    run("npm", ["publish", resolve(directory, pkg.filename), "--access=public", `--registry=${registry}`, "--tag", pkg.version.includes("-") ? "next" : "latest"], { stdio: "inherit" });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/publish-npm.mjs <npm-package-directory>");
  publishPackages(process.argv[2]);
}
