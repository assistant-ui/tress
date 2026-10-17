import { execFile } from "node:child_process";
import { chmod, copyFile, cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, parseArgs } from "node:util";
import { platforms } from "../packages/cli/lib/platform.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "packages/cli");

export async function releaseVersion() {
  const cargo = await readFile(join(root, "Cargo.toml"), "utf8");
  const section = cargo.split("[workspace.package]")[1]?.split(/^\[/m)[0];
  const version = section?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version || !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/.test(version)) {
    throw new Error("Expected a release version in Cargo.toml [workspace.package].");
  }
  return version;
}

export async function packageRelease({ artifactsDir, outputDir, version, env = process.env }) {
  // Check all inputs before creating an output; never package a partial matrix.
  for (const platform of platforms) {
    const artifact = join(artifactsDir, `tress-${platform.target}`);
    if (!(await stat(artifact)).isFile()) throw new Error(`Not a release binary: ${artifact}`);
  }
  await mkdir(outputDir); // Refuse an existing directory containing stale packages.
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  const { private: _private, scripts: _scripts, ...metadata } = manifest;
  const common = {
    version,
    license: manifest.license,
    repository: manifest.repository,
    publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
  };
  const packages = [];
  async function pack(directory, pkg) {
    await writeFile(join(directory, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    await copyFile(join(root, "LICENSE"), join(directory, "LICENSE"));
    const { stdout } = await exec("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", outputDir], { cwd: directory, env });
    const [packed] = JSON.parse(stdout);
    packages.push({ name: pkg.name, version, filename: packed.filename, integrity: packed.integrity });
  }
  for (const platform of platforms) {
    const directory = join(outputDir, `${platform.os}-${platform.cpu}`);
    await mkdir(join(directory, "bin"), { recursive: true });
    const binary = join(directory, "bin/tress");
    await copyFile(join(artifactsDir, `tress-${platform.target}`), binary);
    await chmod(binary, 0o755);
    await writeFile(join(directory, "README.md"), `# ${platform.name}\n\nNative binary for @assistant-ui/tress. Install @assistant-ui/tress instead.\n`);
    await pack(directory, {
      ...common,
      name: platform.name,
      description: `Tress native client for ${platform.os} ${platform.cpu}`,
      os: [platform.os],
      cpu: [platform.cpu],
      files: ["bin/tress", "README.md", "LICENSE"],
    });
  }
  const directory = join(outputDir, "cli");
  await mkdir(directory);
  for (const path of ["bin", "lib", "README.md"]) {
    await cp(join(source, path), join(directory, path), { recursive: true });
  }
  await chmod(join(directory, "bin/tress.mjs"), 0o755);
  await pack(directory, {
    ...metadata,
    ...common,
    os: ["darwin", "linux"],
    cpu: ["arm64", "x64"],
    optionalDependencies: Object.fromEntries(platforms.map(({ name }) => [name, version])),
  });
  // Native packages must become available before the CLI wrapper is published.
  await writeFile(join(outputDir, "release.json"), `${JSON.stringify(packages, null, 2)}\n`);
  return packages;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { artifacts: { type: "string" }, out: { type: "string" } } });
  if (!values.artifacts || !values.out) throw new Error("Usage: node scripts/package-npm.mjs --artifacts <binaries> --out <new-directory>");
  const version = await releaseVersion();
  await mkdir(dirname(resolve(values.out)), { recursive: true });
  const packages = await packageRelease({ artifactsDir: resolve(values.artifacts), outputDir: resolve(values.out), version });
  console.log(`Packed ${packages.length} npm packages for Tress ${version} in ${resolve(values.out)}`);
}
