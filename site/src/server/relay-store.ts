import { Pool } from "pg";
import type { StatewireHostInternal } from "statewire/host-internal";
import type { ThreadState } from "../lib/thread";

type ClientRecord = StatewireHostInternal.ClientRecord;
type Client = ThreadState["clients"][number];

/** Routes a frame to the function invocation holding its SSE connection. */
export const createRelayStore = (pool: Pool) => ({
  async files(scope: string) {
    const { rows } = await pool.query(
      "SELECT files FROM tress_demo_threads WHERE id = $1",
      [scope],
    );
    return rows[0]?.files as Record<string, string> | null | undefined;
  },
  async previews(scope: string) {
    const { rows } = await pool.query(
      "SELECT previews FROM tress_demo_threads WHERE id = $1",
      [scope],
    );
    return rows[0]?.previews as Record<string, string> | null | undefined;
  },
  async saveFiles(
    scope: string,
    threadId: string,
    files: Record<string, string>,
    previews: Record<string, string>,
  ) {
    await pool.query(
      "UPDATE tress_demo_threads SET files = $3, previews = $4 WHERE id = $1 AND harness_thread_id = $2",
      [scope, threadId, JSON.stringify(files), JSON.stringify(previews)],
    );
  },
  async selectThread(scope: string, threadId: string) {
    await pool.query(
      "UPDATE tress_demo_threads SET harness_thread_id = $2, files = NULL, previews = NULL, updated_at = now() WHERE id = $1",
      [scope, threadId],
    );
  },
  async connect(scope: string, client: Client, lease: string) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      // Claim the journal first: serializes overlapping reconnects of one client.
      const { rows } = await db.query(
        `INSERT INTO tress_demo_relay_clients (thread_id, client_id, owner)
         VALUES ($1, $2, $3) ON CONFLICT (thread_id, client_id)
         DO UPDATE SET owner = EXCLUDED.owner RETURNING record`,
        [scope, client.id, lease],
      );
      await db.query(
        `DELETE FROM tress_demo_relay_connections
         WHERE (thread_id = $1 AND client_id = $2) OR expires_at < now()`,
        [scope, client.id],
      );
      await db.query(
        `INSERT INTO tress_demo_relay_connections (lease, thread_id, client_id, details)
         VALUES ($1, $2, $3, $4)`,
        [lease, scope, client.id, JSON.stringify(client)],
      );
      await db.query("COMMIT");
      return rows[0]?.record as ClientRecord | null;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  },
  async save(
    scope: string,
    clientId: string,
    lease: string,
    record: ClientRecord,
  ) {
    const result = await pool.query(
      `UPDATE tress_demo_relay_clients SET record = $4
       WHERE thread_id = $1 AND client_id = $2 AND owner = $3`,
      [scope, clientId, lease, JSON.stringify(record)],
    );
    if (!result.rowCount) throw new Error("Connection superseded.");
  },
  async heartbeat(scope: string, lease: string) {
    const renewed = await pool.query(
      `UPDATE tress_demo_relay_connections SET expires_at = now() + interval '45 seconds'
       WHERE lease = $1 AND thread_id = $2 AND expires_at > now()`,
      [lease, scope],
    );
    if (!renewed.rowCount) return undefined;
    const { rows } = await pool.query(
      `SELECT harness_thread_id, previews AS files, COALESCE((SELECT jsonb_agg(details)
         FROM tress_demo_relay_connections WHERE thread_id = $1 AND expires_at > now()), '[]') AS clients
       FROM tress_demo_threads WHERE id = $1`,
      [scope],
    );
    return rows[0] as
      | {
          harness_thread_id: string;
          clients: Client[];
          files: Record<string, string> | null;
        }
      | undefined;
  },
  async pending(lease: string) {
    const { rows } = await pool.query(
      `SELECT id, body FROM tress_demo_relay_frames
       WHERE lease = $1 AND status IS NULL ORDER BY created_at, id LIMIT 16`,
      [lease],
    );
    return rows as { id: string; body: string }[];
  },
  async complete(id: string, status: number, response: string) {
    await pool.query(
      "UPDATE tress_demo_relay_frames SET status = $2, response = $3 WHERE id = $1",
      [id, status, response],
    );
  },
  async enqueue(scope: string, lease: string, id: string, body: string) {
    const { rowCount } = await pool.query(
      `INSERT INTO tress_demo_relay_frames (id, lease, body)
       SELECT $3, lease, $4 FROM tress_demo_relay_connections
       WHERE thread_id = $1 AND lease = $2 AND expires_at > now()
         AND (SELECT count(*) FROM tress_demo_relay_frames WHERE lease = $2 AND status IS NULL) < 16`,
      [scope, lease, id, body],
    );
    return Boolean(rowCount);
  },
  async result(id: string) {
    const { rows } = await pool.query(
      `SELECT f.status, f.response FROM tress_demo_relay_frames f
       JOIN tress_demo_relay_connections c ON c.lease = f.lease
       WHERE f.id = $1 AND c.expires_at > now()`,
      [id],
    );
    return rows[0] as
      { status: number | null; response: string | null } | undefined;
  },
  async forget(id: string) {
    await pool.query("DELETE FROM tress_demo_relay_frames WHERE id = $1", [id]);
  },
  async release(lease: string) {
    await pool.query(
      "DELETE FROM tress_demo_relay_connections WHERE lease = $1",
      [lease],
    );
  },
});

export type RelayStore = ReturnType<typeof createRelayStore>;
const key = Symbol.for("tress.serverless-relay.store");
const holder = ((globalThis as Record<symbol, unknown>)[key] ??= {}) as {
  store?: RelayStore;
};
export const relayStore = () => {
  if (!process.env.TRESS_DATABASE_URL)
    throw new Error("Serverless mode requires TRESS_DATABASE_URL.");
  return (holder.store ??= createRelayStore(
    new Pool({
      connectionString: process.env.TRESS_DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 10000,
    }),
  ));
};
