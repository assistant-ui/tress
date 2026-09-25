import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import pg from "pg";

if (!process.env.TRESS_DATABASE_URL)
  throw new Error("Set TRESS_DATABASE_URL before importing sessions.");

const directory = resolve(process.env.TRESS_SESSION_DIR ?? ".tress/sessions");
const names = (await readdir(directory)).filter((name) =>
  /^[a-f0-9]{64}\.json$/.test(name),
);
const pool = new pg.Pool({
  connectionString: process.env.TRESS_DATABASE_URL,
  connectionTimeoutMillis: 10_000,
});
let client;
try {
  client = await pool.connect();
  await client.query("BEGIN");
  const addAccess = async (hash, id) => {
    await client.query(
      `INSERT INTO tress_demo_access (access_hash, thread_id) VALUES ($1, $2)
       ON CONFLICT (access_hash) DO NOTHING`,
      [hash, id],
    );
    const {
      rows: [saved],
    } = await client.query(
      "SELECT thread_id FROM tress_demo_access WHERE access_hash = $1",
      [hash],
    );
    if (saved.thread_id !== id)
      throw new Error(
        "An access ID belongs to another session; import cancelled.",
      );
  };
  let imported = 0;
  for (const name of names) {
    const thread = JSON.parse(await readFile(join(directory, name), "utf8"));
    if (name !== `${thread.accessHash}.json`)
      throw new Error("A session record does not match its filename.");
    const result = await client.query(
      `INSERT INTO tress_demo_threads
         (id, owner_id, access_hash, harness_thread_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [
        thread.id,
        thread.ownerId,
        thread.accessHash,
        thread.harnessThreadId,
        thread.createdAt,
        thread.updatedAt,
      ],
    );
    const {
      rows: [saved],
    } = await client.query(
      "SELECT owner_id, access_hash FROM tress_demo_threads WHERE id = $1",
      [thread.id],
    );
    if (
      saved.owner_id !== thread.ownerId ||
      saved.access_hash !== thread.accessHash
    )
      throw new Error(
        "An existing database session has different ownership; import cancelled.",
      );
    imported += result.rowCount;
    await addAccess(thread.accessHash, thread.id);
  }
  const aliases = await readdir(join(directory, "access")).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const name of aliases.filter((name) =>
    /^[a-f0-9]{64}\.json$/.test(name),
  )) {
    const alias = JSON.parse(
      await readFile(join(directory, "access", name), "utf8"),
    );
    const {
      rows: [thread],
    } = await client.query(
      "SELECT id FROM tress_demo_threads WHERE access_hash = $1",
      [alias.accessHash],
    );
    if (!thread)
      throw new Error(
        "An alias refers to a missing session; import cancelled.",
      );
    await addAccess(name.slice(0, -5), thread.id);
  }
  await client.query("COMMIT");
  console.log(
    `Imported ${imported} sessions; ${names.length - imported} already existed. Local records kept intact.`,
  );
} catch (error) {
  await client?.query("ROLLBACK");
  // Do not print connection strings or database error details containing records.
  console.error(
    `Session import failed (${error.code ?? error.name}). No records were imported.`,
  );
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
