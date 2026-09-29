import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

export type Device = {
  id: string;
  threadId: string | null;
  label: string;
  rootLabel: string;
  writable: boolean;
  lastSeenAt: number | null;
  revoked: boolean;
};
export type DeviceJob = {
  id: string;
  operation: "read" | "list" | "write";
  path: string;
  content?: string;
};
export type DeviceResult = {
  ok: boolean;
  value?: string | { name: string; type: "file" | "directory" }[];
  error?: string;
};
export type JobState =
  | { status: "pending" | "leased" }
  | { status: "done"; result: DeviceResult };

export interface ConnectStore {
  offer(input: {
    id: string;
    codeHash: string;
    tokenHash: string;
    label: string;
    rootLabel: string;
    writable: boolean;
    expiresAt: number;
  }): Promise<void>;
  claim(codeHash: string, threadId: string): Promise<Device | undefined>;
  device(threadId: string): Promise<Device | undefined>;
  revoke(threadId: string): Promise<boolean>;
  heartbeat(tokenHash: string): Promise<{ paired: boolean; revoked: boolean } | undefined>;
  enqueue(threadId: string, job: DeviceJob): Promise<boolean>;
  take(tokenHash: string): Promise<DeviceJob | undefined>;
  complete(tokenHash: string, id: string, result: DeviceResult): Promise<boolean>;
  result(id: string): Promise<JobState | undefined>;
  forget(id: string): Promise<void>;
}

export const connectHash = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
export const deviceOnline = (device: Device, now = Date.now()) =>
  !device.revoked &&
  device.threadId !== null &&
  device.lastSeenAt !== null &&
  now - device.lastSeenAt < 30_000;

export const createMemoryConnectStore = (): ConnectStore => {
  type Row = Device & { codeHash: string | null; tokenHash: string; expiresAt: number };
  type Work = { deviceId: string; job: DeviceJob; state: JobState };
  const devices = new Map<string, Row>();
  const jobs = new Map<string, Work>();
  const byToken = (hash: string) =>
    [...devices.values()].find((device) => device.tokenHash === hash);
  return {
    async offer(input) {
      devices.set(input.id, {
        id: input.id,
        threadId: null,
        codeHash: input.codeHash,
        tokenHash: input.tokenHash,
        label: input.label,
        rootLabel: input.rootLabel,
        writable: input.writable,
        expiresAt: input.expiresAt,
        lastSeenAt: null,
        revoked: false,
      });
    },
    async claim(hash, threadId) {
      const candidate = [...devices.values()].find(
        (device) =>
          device.codeHash === hash &&
          !device.revoked &&
          device.threadId === null &&
          device.expiresAt > Date.now(),
      );
      if (!candidate) return undefined;
      for (const device of devices.values())
        if (device.threadId === threadId) device.revoked = true;
      candidate.threadId = threadId;
      candidate.codeHash = null;
      return { ...candidate };
    },
    async device(threadId) {
      const row = [...devices.values()].find(
        (device) => device.threadId === threadId && !device.revoked,
      );
      return row ? { ...row } : undefined;
    },
    async revoke(threadId) {
      let changed = false;
      for (const device of devices.values())
        if (device.threadId === threadId && !device.revoked) {
          device.revoked = true;
          changed = true;
        }
      return changed;
    },
    async heartbeat(hash) {
      const row = byToken(hash);
      if (!row) return undefined;
      if (!row.threadId && row.expiresAt <= Date.now()) row.revoked = true;
      if (row.revoked) return { paired: Boolean(row.threadId), revoked: true };
      if (row.threadId) row.lastSeenAt = Date.now();
      return { paired: Boolean(row.threadId), revoked: false };
    },
    async enqueue(threadId, job) {
      const device = await this.device(threadId);
      if (!device || !deviceOnline(device)) return false;
      if (job.operation === "write" && !device.writable) return false;
      jobs.set(job.id, { deviceId: device.id, job, state: { status: "pending" } });
      return true;
    },
    async take(hash) {
      const device = byToken(hash);
      if (!device || device.revoked || !device.threadId) return undefined;
      for (const work of jobs.values())
        if (work.deviceId === device.id && work.state.status === "pending") {
          work.state = { status: "leased" };
          return work.job;
        }
      return undefined;
    },
    async complete(hash, id, result) {
      const device = byToken(hash);
      const work = jobs.get(id);
      if (!device || device.revoked || !work || work.deviceId !== device.id)
        return false;
      if (work.state.status === "pending") return false;
      if (work.state.status === "done")
        return JSON.stringify(work.state.result) === JSON.stringify(result);
      work.state = { status: "done", result };
      return true;
    },
    async result(id) {
      return jobs.get(id)?.state;
    },
    async forget(id) {
      jobs.delete(id);
    },
  };
};

type Row = {
  id: string;
  threadId: string | null;
  label: string;
  rootLabel: string;
  writable: boolean;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
};
const fromRow = (row: Row): Device => ({
  id: row.id,
  threadId: row.threadId,
  label: row.label,
  rootLabel: row.rootLabel,
  writable: row.writable,
  lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt).getTime() : null,
  revoked: row.revokedAt !== null,
});
const columns = `id, thread_id AS "threadId", label, root_label AS "rootLabel",
  writable, last_seen_at AS "lastSeenAt", revoked_at AS "revokedAt"`;

export const createPostgresConnectStore = (pool: Pool): ConnectStore => ({
  async offer(input) {
    await pool.query(
      `DELETE FROM tress_demo_devices WHERE thread_id IS NULL
       AND code_expires_at < now() - interval '1 day'`,
    );
    await pool.query(
      `DELETE FROM tress_demo_device_jobs WHERE created_at < now() - interval '1 day'`,
    );
    await pool.query(
      `INSERT INTO tress_demo_devices
       (id, code_hash, token_hash, label, root_label, writable, code_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))`,
      [input.id, input.codeHash, input.tokenHash, input.label, input.rootLabel, input.writable, input.expiresAt],
    );
  },
  async claim(hash, threadId) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      // Serialize competing claims for the same thread, not only the same code.
      await db.query("SELECT id FROM tress_demo_threads WHERE id = $1 FOR UPDATE", [threadId]);
      const offer = await db.query(
        `SELECT id FROM tress_demo_devices WHERE code_hash = $1 AND thread_id IS NULL
         AND revoked_at IS NULL AND code_expires_at > now() FOR UPDATE`,
        [hash],
      );
      if (!offer.rows.length) {
        await db.query("ROLLBACK");
        return undefined;
      }
      await db.query(
        "UPDATE tress_demo_devices SET revoked_at = now() WHERE thread_id = $1 AND revoked_at IS NULL",
        [threadId],
      );
      const claimed = await db.query(
        `UPDATE tress_demo_devices SET thread_id = $2, code_hash = NULL,
         code_expires_at = NULL WHERE id = $1 RETURNING ${columns}`,
        [offer.rows[0].id, threadId],
      );
      await db.query("COMMIT");
      return fromRow(claimed.rows[0]);
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  },
  async device(threadId) {
    const { rows } = await pool.query(
      `SELECT ${columns} FROM tress_demo_devices
       WHERE thread_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [threadId],
    );
    return rows[0] ? fromRow(rows[0]) : undefined;
  },
  async revoke(threadId) {
    const result = await pool.query(
      "UPDATE tress_demo_devices SET revoked_at = now() WHERE thread_id = $1 AND revoked_at IS NULL",
      [threadId],
    );
    return Boolean(result.rowCount);
  },
  async heartbeat(hash) {
    const { rows } = await pool.query(
      `UPDATE tress_demo_devices SET last_seen_at = CASE WHEN thread_id IS NOT NULL
         AND revoked_at IS NULL THEN now() ELSE last_seen_at END
       WHERE token_hash = $1 RETURNING thread_id IS NOT NULL AS paired,
         (revoked_at IS NOT NULL OR
          (thread_id IS NULL AND code_expires_at <= now())) AS revoked`,
      [hash],
    );
    return rows[0] ?? undefined;
  },
  async enqueue(threadId, job) {
    const result = await pool.query(
      `INSERT INTO tress_demo_device_jobs (id, device_id, operation, path, content)
       SELECT $2, id, $3, $4, $5 FROM tress_demo_devices
       WHERE thread_id = $1 AND revoked_at IS NULL
         AND last_seen_at > now() - interval '30 seconds'
         AND ($3 <> 'write' OR writable)
       ORDER BY created_at DESC LIMIT 1`,
      [threadId, job.id, job.operation, job.path, job.content ?? null],
    );
    return Boolean(result.rowCount);
  },
  async take(hash) {
    const { rows } = await pool.query(
      `WITH next AS (
         SELECT j.id FROM tress_demo_device_jobs j
         JOIN tress_demo_devices d ON d.id = j.device_id
         WHERE d.token_hash = $1 AND d.revoked_at IS NULL AND d.thread_id IS NOT NULL
           AND j.status = 'pending'
         ORDER BY j.created_at, j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED
       ) UPDATE tress_demo_device_jobs j SET status = 'leased', leased_at = now()
         FROM next WHERE j.id = next.id
         RETURNING j.id, j.operation, j.path, j.content`,
      [hash],
    );
    return rows[0] ?? undefined;
  },
  async complete(hash, id, result) {
    const { rowCount } = await pool.query(
      `UPDATE tress_demo_device_jobs j SET status = 'done', result = $3,
         completed_at = now() FROM tress_demo_devices d
       WHERE j.id = $2 AND j.device_id = d.id AND d.token_hash = $1
         AND d.revoked_at IS NULL AND
         (j.status = 'leased' OR (j.status = 'done' AND j.result = $3::jsonb))`,
      [hash, id, JSON.stringify(result)],
    );
    return Boolean(rowCount);
  },
  async result(id) {
    const { rows } = await pool.query(
      "SELECT status, result FROM tress_demo_device_jobs WHERE id = $1",
      [id],
    );
    return rows[0] ?? undefined;
  },
  async forget(id) {
    await pool.query("DELETE FROM tress_demo_device_jobs WHERE id = $1", [id]);
  },
});

const key = Symbol.for("tress.demo.connect-store.v1");
const holder = ((globalThis as Record<symbol, unknown>)[key] ??= {}) as {
  store?: ConnectStore;
};
export const connectStore = (): ConnectStore =>
  (holder.store ??= process.env.TRESS_DATABASE_URL
    ? createPostgresConnectStore(
        new Pool({
          connectionString: process.env.TRESS_DATABASE_URL,
          max: 5,
          connectionTimeoutMillis: 5000,
        }),
      )
    : createMemoryConnectStore());

export const newDeviceId = () => randomUUID();
