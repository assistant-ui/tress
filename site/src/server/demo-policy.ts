import type { DemoThread, ThreadStore } from "./thread-store";

export class DemoPolicyError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

const setting = (name: string, fallback: number) => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`${name} must be a nonnegative integer.`);
  return Number(value);
};

export const demoLimits = () => ({
  runsPerOwner: setting("TRESS_RUNS_PER_OWNER_DAY", 50),
  runsPerHost: setting("TRESS_RUNS_PER_HOST_DAY", 500),
  sessionsPerOwner: setting("TRESS_SESSIONS_PER_OWNER_DAY", 10),
  sessionsPerHost: setting("TRESS_SESSIONS_PER_HOST_DAY", 100),
  sessionHours: setting("TRESS_SESSION_TTL_HOURS", 168),
  idleMinutes: setting("TRESS_HOST_IDLE_MINUTES", 10),
});

export const assertSessionActive = (thread: DemoThread, now = Date.now()) => {
  const { sessionHours } = demoLimits();
  if (
    sessionHours &&
    now >= Date.parse(thread.createdAt) + sessionHours * 3_600_000
  )
    throw new DemoPolicyError(
      "This demo session has expired. Open the site without its session link to start a new one.",
      410,
    );
};

export type UsageBucket = { key: string; limit: number };

export const consumeBudget = async (
  store: Pick<ThreadStore, "consume">,
  kind: "runs" | "sessions",
  ownerId: string,
  now = Date.now(),
) => {
  const limits = demoLimits();
  const owner = kind === "runs" ? limits.runsPerOwner : limits.sessionsPerOwner;
  const host = kind === "runs" ? limits.runsPerHost : limits.sessionsPerHost;
  const buckets = [
    { key: `${kind}:host`, limit: host },
    { key: `${kind}:owner:${ownerId}`, limit: owner },
  ].filter((bucket) => bucket.limit > 0);
  if (!buckets.length || (await store.consume(buckets, now))) return;
  const retry = Math.max(
    1,
    Math.ceil(
      (Date.parse(new Date(now).toISOString().slice(0, 10)) +
        86_400_000 -
        now) /
        1000,
    ),
  );
  throw new DemoPolicyError(
    `The demo's daily ${kind === "runs" ? "run" : "new-session"} limit has been reached. Try again after midnight UTC.`,
    429,
    retry,
  );
};

export const admitRun = async (thread?: DemoThread) => {
  if (thread) assertSessionActive(thread);
  const { threadStore } = await import("./thread-store");
  await consumeBudget(threadStore(), "runs", thread?.ownerId ?? "shared");
};

export const policyResponse = (error: DemoPolicyError) =>
  Response.json(
    { error: error.message },
    {
      status: error.status,
      headers: {
        "Cache-Control": "no-store",
        ...(error.retryAfter
          ? { "Retry-After": String(error.retryAfter) }
          : {}),
      },
    },
  );
