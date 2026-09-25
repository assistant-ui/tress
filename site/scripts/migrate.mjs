import { readFile, readdir } from "node:fs/promises";
import pg from "pg";

if (!process.env.TRESS_DATABASE_URL)
  throw new Error("Set TRESS_DATABASE_URL before migrating.");
const pool = new pg.Pool({ connectionString: process.env.TRESS_DATABASE_URL });
try {
  const directory = new URL("../migrations/", import.meta.url);
  for (const name of (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort())
    await pool.query(await readFile(new URL(name, directory), "utf8"));
  console.log("Tress thread registry is ready.");
} finally {
  await pool.end();
}
