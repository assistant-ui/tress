import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
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
  title?: string | null;
  archivedAt?: string | null;
};

export type ThreadPatch = { title?: string; archivedAt?: string | null };

/** Replace this store to integrate your own accounts/database. Tokens stay hashed. */
export interface ThreadStore {
  get(accessHash: string): Promise<DemoThread | undefined>;
  create(thread: DemoThread): Promise<void>;
  addAccess(accessHash: string, aliasHash: string): Promise<void>;
  selectThread(accessHash: string, harnessThreadId: string): Promise<void>;
  owner(hash: string): Promise<string | undefined>;
  createOwner(hash: string, legacyOwnerId?: string): Promise<string>;
  list(ownerId: string): Promise<DemoThread[]>;
  update(
    ownerId: string,
    id: string,
    patch: ThreadPatch,
    onlyUntitled?: boolean,
  ): Promise<DemoThread | undefined>;
}

// Serialize local metadata edits with conversation rotation, across store instances.
const writes = new Map<string, Promise<unknown>>();
const editFile = <T>(target: string, edit: () => Promise<T>): Promise<T> => {
  const task = (writes.get(target) ?? Promise.resolve())
    .catch(() => {})
    .then(edit);
  writes.set(target, task);
  void task
    .finally(() => {
      if (writes.get(target) === task) writes.delete(target);
    })
    .catch(() => {});
  return task;
};

export const createFileThreadStore = (directory: string): ThreadStore => {
  const path = (hash: string) => {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid access hash.");
    return join(directory, `${hash}.json`);
  };
  const aliasPath = (hash: string) =>
    join(directory, "access", basename(path(hash)));
  const save = async (thread: DemoThread) => {
    const target = path(thread.accessHash);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(thread), { mode: 0o600 });
    await rename(temporary, target);
  };
  const ownerPath = (hash: string) =>
    join(directory, "owners", basename(path(hash)));
  const store: ThreadStore = {
    async owner(hash) {
      try {
        return JSON.parse(await readFile(ownerPath(hash), "utf8")).id;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
    },
    async createOwner(hash, legacyOwnerId) {
      return editFile(ownerPath(hash), async () => {
        const existing = await store.owner(hash);
        if (existing) return existing;
        await mkdir(join(directory, "owners", "ids"), { recursive: true });
        let id = legacyOwnerId ?? randomUUID();
        try {
          await writeFile(
            join(directory, "owners", "ids", `${id}.json`),
            JSON.stringify({ hash }),
            { flag: "wx", mode: 0o600 },
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          id = randomUUID();
          await writeFile(
            join(directory, "owners", "ids", `${id}.json`),
            JSON.stringify({ hash }),
            { flag: "wx", mode: 0o600 },
          );
        }
        await writeFile(ownerPath(hash), JSON.stringify({ id }), {
          flag: "wx",
          mode: 0o600,
        });
        return id;
      });
    },
    async list(ownerId) {
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const threads: DemoThread[] = await Promise.all(
        names
          .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
          .map((name) =>
            readFile(join(directory, name), "utf8").then(JSON.parse),
          ),
      );
      return threads
        .filter((thread) => thread.ownerId === ownerId)
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
        );
    },
    async update(ownerId, id, patch, onlyUntitled = false) {
      const found = (await store.list(ownerId)).find(
        (thread) => thread.id === id,
      );
      if (!found) return undefined;
      return editFile(path(found.accessHash), async () => {
        const current = await store.get(found.accessHash);
        if (!current || current.ownerId !== ownerId) return undefined;
        if (onlyUntitled && current.title) return current;
        const next = {
          ...current,
          ...patch,
          updatedAt: new Date().toISOString(),
        };
        await save(next);
        return next;
      });
    },
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
      const found = await store.get(hash);
      if (!found) throw new Error("Thread no longer exists.");
      await editFile(path(found.accessHash), async () => {
        const thread = await store.get(found.accessHash);
        if (!thread) throw new Error("Thread no longer exists.");
        await save({
          ...thread,
          harnessThreadId,
          updatedAt: new Date().toISOString(),
        });
      });
    },
  };
  return store;
};

const columns = `t.id, t.owner_id AS "ownerId", t.access_hash AS "accessHash",
  t.harness_thread_id AS "harnessThreadId", t.title, t.archived_at AS "archivedAt",
  t.created_at AS "createdAt", t.updated_at AS "updatedAt"`;
const fromRow = (row: DemoThread) => ({
  ...row,
  createdAt: new Date(row.createdAt).toISOString(),
  updatedAt: new Date(row.updatedAt).toISOString(),
  archivedAt: row.archivedAt ? new Date(row.archivedAt).toISOString() : null,
});

export const createPostgresThreadStore = (pool: Pool): ThreadStore => ({
  async owner(hash) {
    const { rows } = await pool.query(
      "SELECT id FROM tress_demo_owners WHERE access_hash = $1",
      [hash],
    );
    return rows[0]?.id;
  },
  async createOwner(hash, legacyOwnerId) {
    const id = legacyOwnerId ?? randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO tress_demo_owners (id, access_hash) VALUES ($1, $2)
      ON CONFLICT DO NOTHING RETURNING id`,
      [id, hash],
    );
    if (rows.length) return rows[0].id;
    const existing = await pool.query(
      "SELECT id FROM tress_demo_owners WHERE access_hash = $1",
      [hash],
    );
    if (existing.rows.length) return existing.rows[0].id;
    // An already-bound legacy thread never grants another visitor its owner's list.
    const fresh = await pool.query(
      `INSERT INTO tress_demo_owners (id, access_hash) VALUES ($1, $2)
      ON CONFLICT (access_hash) DO UPDATE SET access_hash = EXCLUDED.access_hash RETURNING id`,
      [randomUUID(), hash],
    );
    return fresh.rows[0].id;
  },
  async list(ownerId) {
    const { rows } = await pool.query(
      `SELECT ${columns} FROM tress_demo_threads t WHERE owner_id = $1 ORDER BY updated_at DESC, id`,
      [ownerId],
    );
    return rows.map(fromRow);
  },
  async update(ownerId, id, patch, onlyUntitled = false) {
    const { rows } = await pool.query(
      `UPDATE tress_demo_threads t SET
      title = CASE WHEN $3::boolean THEN $4::text ELSE title END,
      archived_at = CASE WHEN $5::boolean THEN $6::timestamptz ELSE archived_at END,
      updated_at = now() WHERE owner_id = $1 AND id = $2 AND (NOT $7::boolean OR title IS NULL) RETURNING ${columns}`,
      [
        ownerId,
        id,
        patch.title !== undefined,
        patch.title ?? null,
        patch.archivedAt !== undefined,
        patch.archivedAt ?? null,
        onlyUntitled,
      ],
    );
    if (rows[0]) return fromRow(rows[0]);
    const current = await pool.query(
      `SELECT ${columns} FROM tress_demo_threads t WHERE owner_id = $1 AND id = $2`,
      [ownerId, id],
    );
    return current.rows[0] ? fromRow(current.rows[0]) : undefined;
  },
  async get(hash) {
    const { rows } = await pool.query(
      `SELECT ${columns}
         FROM tress_demo_threads t JOIN tress_demo_access a ON a.thread_id = t.id
        WHERE a.access_hash = $1`,
      [hash],
    );
    const row = rows[0];
    return row ? fromRow(row) : undefined;
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

const key = Symbol.for("tress.demo.thread-store.v3");
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
