import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { Pool } from "pg";

export type DemoThread = {
  id: string;
  ownerId: string;
  accessHash: string;
  harnessThreadId: string;
  createdAt: string;
  updatedAt: string;
};

/** Replace this store to integrate your own accounts/database. Tokens stay hashed. */
export interface ThreadStore {
  get(accessHash: string): Promise<DemoThread | undefined>;
  create(thread: DemoThread): Promise<void>;
  addAccess(accessHash: string, aliasHash: string): Promise<void>;
  selectThread(accessHash: string, harnessThreadId: string): Promise<void>;
}

export const createFileThreadStore = (directory: string): ThreadStore => {
  const path = (hash: string) => {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid access hash.");
    return join(directory, `${hash}.json`);
  };
  const aliasPath = (hash: string) =>
    join(directory, "access", basename(path(hash)));
  const store: ThreadStore = {
    async get(hash) {
      try {
        return JSON.parse(await readFile(path(hash), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          try {
            const primary = JSON.parse(await readFile(aliasPath(hash), "utf8"));
            return JSON.parse(await readFile(path(primary.accessHash), "utf8"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              return undefined;
            throw error;
          }
        }
        throw error;
      }
    },
    async create(thread) {
      if (await store.get(thread.accessHash))
        throw new Error("Session ID already exists.");
      await mkdir(directory, { recursive: true });
      await writeFile(path(thread.accessHash), JSON.stringify(thread), {
        flag: "wx",
        mode: 0o600,
      });
    },
    async addAccess(hash, aliasHash) {
      const thread = await store.get(hash);
      if (!thread) throw new Error("Thread no longer exists.");
      const existing = await store.get(aliasHash);
      if (existing) {
        if (existing.id !== thread.id)
          throw new Error("Session ID already exists.");
        return;
      }
      await mkdir(join(directory, "access"), { recursive: true });
      try {
        await writeFile(
          aliasPath(aliasHash),
          JSON.stringify({ accessHash: thread.accessHash }),
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await store.get(aliasHash))?.id !== thread.id)
          throw new Error("Session ID already exists.");
      }
    },
    async selectThread(hash, harnessThreadId) {
      const thread = await store.get(hash);
      if (!thread) throw new Error("Thread no longer exists.");
      const target = path(thread.accessHash);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify({
          ...thread,
          harnessThreadId,
          updatedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      await rename(temporary, target);
    },
  };
  return store;
};

export const createPostgresThreadStore = (pool: Pool): ThreadStore => ({
  async get(hash) {
    const { rows } = await pool.query(
      `SELECT t.id, t.owner_id AS "ownerId", t.access_hash AS "accessHash",
              t.harness_thread_id AS "harnessThreadId",
              t.created_at AS "createdAt", t.updated_at AS "updatedAt"
         FROM tress_demo_threads t JOIN tress_demo_access a ON a.thread_id = t.id
        WHERE a.access_hash = $1`,
      [hash],
    );
    const row = rows[0];
    return row
      ? {
          ...row,
          createdAt: new Date(row.createdAt).toISOString(),
          updatedAt: new Date(row.updatedAt).toISOString(),
        }
      : undefined;
  },
  async create(thread) {
    await pool.query(
      `WITH created AS (INSERT INTO tress_demo_threads
         (id, owner_id, access_hash, harness_thread_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, access_hash)
       INSERT INTO tress_demo_access (access_hash, thread_id)
       SELECT access_hash, id FROM created`,
      [
        thread.id,
        thread.ownerId,
        thread.accessHash,
        thread.harnessThreadId,
        thread.createdAt,
        thread.updatedAt,
      ],
    );
  },
  async addAccess(hash, aliasHash) {
    await pool.query(
      `INSERT INTO tress_demo_access (access_hash, thread_id)
       SELECT $2, thread_id FROM tress_demo_access WHERE access_hash = $1
       ON CONFLICT (access_hash) DO NOTHING`,
      [hash, aliasHash],
    );
    const { rows } = await pool.query(
      `SELECT 1 FROM tress_demo_access original JOIN tress_demo_access alias
          ON alias.thread_id = original.thread_id
        WHERE original.access_hash = $1 AND alias.access_hash = $2`,
      [hash, aliasHash],
    );
    if (!rows.length)
      throw new Error("Session ID already exists or thread no longer exists.");
  },
  async selectThread(hash, id) {
    const result = await pool.query(
      `UPDATE tress_demo_threads SET harness_thread_id = $2, updated_at = now()
       WHERE id = (SELECT thread_id FROM tress_demo_access WHERE access_hash = $1)`,
      [hash, id],
    );
    if (!result.rowCount) throw new Error("Thread no longer exists.");
  },
});

const key = Symbol.for("tress.demo.thread-store.v2");
type Holder = { store?: ThreadStore };
const holder = ((globalThis as Record<symbol, unknown>)[key] ??= {}) as Holder;
export const threadStore = () =>
  (holder.store ??= process.env.TRESS_DATABASE_URL
    ? createPostgresThreadStore(
        new Pool({
          connectionString: process.env.TRESS_DATABASE_URL,
          max: 5,
          connectionTimeoutMillis: 5000,
        }),
      )
    : createFileThreadStore(
        resolve(process.env.TRESS_SESSION_DIR ?? ".tress/sessions"),
      ));
