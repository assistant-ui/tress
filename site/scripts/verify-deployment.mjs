// Boot the deployed function away from the checkout: ancestor node_modules
// must not hide a dependency missing from the uploaded Vercel artifact.
import assert from "node:assert/strict";
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const temporary = await realpath(await mkdtemp(join(tmpdir(), "tress-deployment-")));
try {
  await cp(resolve(".vercel/output/functions/__nitro.func"), temporary, {
    recursive: true, dereference: true,
  });
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--permission", `--allow-fs-read=${temporary}`,
    "--input-type=module", "-e", `
    const { default: app } = await import("./index.mjs");
    for (const path of ["/", "/docs", "/docs/workspace", "/docs/embedding", "/docs/local", "/docs/authentication", "/docs/production"]) {
      const response = await app.fetch(new Request("https://example.test" + path));
      const html = await response.text();
      if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/html") || !html.includes("<h1")) {
        throw new Error(path + " returned " + response.status + ": " + html.slice(0, 500));
      }
      console.log(response.status, path);
    }
    for (const path of ["/docs.md", "/docs/workspace.md", "/docs/embedding.md", "/docs/local.md"]) {
      for (const accept of ["text/html", "text/markdown"]) {
        const response = await app.fetch(new Request("https://example.test" + path, {
          headers: { Accept: accept },
        }));
        const expected = "text/plain";
        if (response.status !== 200 || !response.headers.get("content-type")?.startsWith(expected)) {
          throw new Error(path + " did not serve " + expected + " for " + accept);
        }
        if (response.headers.get("content-disposition") !== "inline" || response.headers.get("x-content-type-options") !== "nosniff") {
          throw new Error(path + " should display in the browser");
        }
        const markdown = await response.text();
        if (!markdown.includes("title:") || markdown.includes("<DocsPageActions")) {
          throw new Error(path + " returned invalid Markdown source");
        }
        console.log(response.status, path, expected);
      }
    }
    process.exit(0);
  `], {
    cwd: temporary,
    env: { PATH: process.env.PATH, NODE_ENV: "production", NODE_PATH: "", TRESS_BACKEND: "local", TRESS_WORKSPACE_MODE: "memory" },
    timeout: 30_000,
  });
  assert.match(stdout, /200 \/docs\/production/);
  process.stdout.write(stdout);
  console.log("Isolated Vercel function serves the app and docs without checkout dependencies.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
