import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { platforms } from "../lib/platform.mjs";
import { publishPackages } from "../../../scripts/publish-npm.mjs";

async function release(t, version = "1.2.3") {
  const directory = await mkdtemp(join(tmpdir(), "tress-npm-publish-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packages = [];
  for (const name of [...platforms.map(({ name }) => name), "@assistant-ui/tress"]) {
    const contents = Buffer.from(name);
    const filename = `${name.replace("@assistant-ui/", "")}.tgz`;
    await writeFile(join(directory, filename), contents);
    packages.push({ name, version, filename, integrity: `sha512-${createHash("sha512").update(contents).digest("base64")}` });
  }
  await writeFile(join(directory, "release.json"), JSON.stringify(packages));
  return { directory, packages };
}

function registry(packages, existing = new Map(), fail) {
  const published = [];
  return {
    published,
    run(command, args) {
      assert.equal(command, "npm");
      if (args[0] === "view") {
        if (existing.has(args[1])) return JSON.stringify(existing.get(args[1]));
        throw Object.assign(new Error("not found"), { stdout: JSON.stringify({ error: { code: "E404" } }) });
      }
      const pkg = packages.find(({ filename }) => filename === basename(args[1]));
      if (pkg.name === fail) throw new Error("registry unavailable");
      published.push({ name: pkg.name, tag: args.at(-1) });
      existing.set(`${pkg.name}@${pkg.version}`, pkg.integrity);
    },
    log() {},
  };
}

test("publishes dependencies first and safely resumes a partial publication", async (t) => {
  const { directory, packages } = await release(t);
  const existing = new Map();
  const first = registry(packages, existing, packages[2].name);
  assert.throws(() => publishPackages(directory, first), /registry unavailable/);
  assert.deepEqual(first.published.map(({ name }) => name), packages.slice(0, 2).map(({ name }) => name));
  const retry = registry(packages, existing);
  publishPackages(directory, retry);
  assert.deepEqual(retry.published, packages.slice(2).map(({ name }) => ({ name, tag: "latest" })));
  const repeated = registry(packages, existing);
  publishPackages(directory, repeated);
  assert.deepEqual(repeated.published, []);
});

test("prereleases use next; changed archives and registry conflicts fail closed", async (t) => {
  const { directory, packages } = await release(t, "1.2.3-beta.1");
  const next = registry(packages);
  publishPackages(directory, next);
  assert.ok(next.published.every(({ tag }) => tag === "next"));
  const conflict = registry(packages, new Map([[`${packages[0].name}@${packages[0].version}`, "sha512-other"]]));
  assert.throws(() => publishPackages(directory, conflict), /different contents/);
  assert.deepEqual(conflict.published, []);
  await writeFile(join(directory, packages.at(-1).filename), "corrupted");
  const corrupted = registry(packages);
  assert.throws(() => publishPackages(directory, corrupted), /Integrity mismatch/);
  assert.deepEqual(corrupted.published, []);
});

test("authentication failures do not trigger publication", async (t) => {
  const { directory } = await release(t);
  assert.throws(() => publishPackages(directory, {
    run(_command, args) {
      assert.equal(args[0], "view");
      throw Object.assign(new Error("authentication required"), { stdout: JSON.stringify({ error: { code: "E401" } }) });
    },
  }), /authentication required/);
});
