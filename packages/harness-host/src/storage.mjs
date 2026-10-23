import { open, readFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function fileStorage(path) {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }
    },
    async save(snapshot) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify(snapshot));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
        const directory = await open(dirname(path), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    },
  };
}
