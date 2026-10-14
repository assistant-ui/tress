import { cp, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

// Farm beta.106 copies docs to the old Nitro chunks/nitro layout. Nitro 3's
// Rolldown entry lives at the function root and searches upward from there.
// Keep the content beside that entry until Farm handles both output layouts.
if (process.env.FARM_DEPLOY_TARGET === "vercel") {
  const functions = resolve(".vercel/output/functions");
  for (const entry of await readdir(functions, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".func")) continue;
    const root = join(functions, entry.name);
    const source = join(root, "chunks/nitro/farm-docs-content");
    const destination = join(root, "farm-docs-content");
    const exists = await stat(source).then(() => true, (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (exists) await cp(source, destination, { recursive: true });
  }
}
