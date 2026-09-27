import { threadMode } from "./config";
import {
  resolveDemoSession,
  sessionResponse,
  type DemoSession,
} from "./demo-session";
import { threadStore, type ThreadStore } from "./thread-store";
import { managedBackendUrl, managedStreamHeaders } from "./managed-backend";
import { demoLimits } from "./demo-policy";

type Check = {
  name: string;
  status: "ok" | "error" | "unknown";
  message: string;
};
export type HealthReport = { ok: boolean; checks: Check[]; checkedAt: string };
const check = (
  name: string,
  status: Check["status"],
  message: string,
): Check => ({ name, status, message });

const probe = async (
  name: string,
  url: URL,
  headers: Record<string, string>,
  fetcher: typeof fetch,
): Promise<Check> => {
  try {
    const response = await fetcher(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    await response.body?.cancel();
    if (response.ok)
      return check(
        name,
        "ok",
        name === "Model"
          ? "Model metadata access verified; no generation performed."
          : "Managed thread is reachable.",
      );
    if (response.status === 401 || response.status === 403)
      return check(
        name,
        "error",
        `${name} access rejected (HTTP ${response.status}). Check the host's credentials and allowed backend URL.`,
      );
    if (response.status === 404 && name === "Model")
      return check(
        name,
        "unknown",
        "Model metadata was not found. Check the model ID; compatible proxies may not support this check.",
      );
    return check(
      name,
      "error",
      `${name} check failed (HTTP ${response.status}). Ask the host operator to check the service.`,
    );
  } catch {
    return check(
      name,
      "error",
      `${name} could not be reached within five seconds. Check the host's service URL and connection.`,
    );
  }
};

export const checkHost = async (
  request: Request,
  session: DemoSession | undefined,
  store: ThreadStore = threadStore(),
  fetcher: typeof fetch = fetch,
): Promise<HealthReport> => {
  const storage = (async () => {
    try {
      await store.check();
      return check(
        "Storage",
        "ok",
        "Session storage and required schema are available.",
      );
    } catch {
      return check(
        "Storage",
        "error",
        "Session storage is unavailable. Check the database connection and run the tress migrations.",
      );
    }
  })();
  const model = (async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key)
      return check(
        "Model",
        "error",
        "The host has no model credential configured.",
      );
    try {
      const url = new URL(
        process.env.TRESS_API_URL ?? "https://api.anthropic.com/v1/messages",
      );
      if (!url.pathname.endsWith("/messages"))
        return check(
          "Model",
          "unknown",
          "This model endpoint does not expose a known metadata URL.",
        );
      url.pathname = `${url.pathname.slice(0, -"messages".length)}models/${encodeURIComponent(process.env.TRESS_MODEL ?? "claude-sonnet-5")}`;
      return await probe(
        "Model",
        url,
        { "x-api-key": key, "anthropic-version": "2023-06-01" },
        fetcher,
      );
    } catch {
      return check(
        "Model",
        "error",
        "TRESS_API_URL is invalid. Ask the host operator to correct it.",
      );
    }
  })();
  const harness = (async () => {
    try {
      const mode = threadMode(request.url);
      if (mode.kind === "local")
        return check(
          "Harness",
          "ok",
          "Local host selected; managed Harness is not in use.",
        );
      const proposed = new URL(mode.backendUrl);
      if (session) proposed.searchParams.set("session", session.token);
      const config = { ...mode, backendUrl: proposed.href };
      const id = session?.thread.harnessThreadId ?? mode.initialThreadId;
      const backend = session
        ? await managedBackendUrl(config, session.thread.id, id, store, fetcher)
        : proposed.href;
      const origin = new URL(mode.origin);
      const url = new URL(
        `/threads/${origin.hostname.split(".")[0]}~${encodeURIComponent(id)}/stream`,
        origin,
      );
      return await probe(
        "Harness",
        url,
        managedStreamHeaders(mode, backend),
        fetcher,
      );
    } catch {
      return check(
        "Harness",
        "error",
        "Harness configuration is invalid. Check the host's Harness key, origin, workspace, and backend URL.",
      );
    }
  })();
  const checks = await Promise.all([storage, model, harness]);
  try {
    demoLimits();
  } catch {
    checks.push(
      check(
        "Limits",
        "error",
        "Demo limit settings must be nonnegative integers.",
      ),
    );
  }
  return {
    ok: checks.every((item) => item.status === "ok"),
    checks,
    checkedAt: new Date().toISOString(),
  };
};

const cached = new Map<
  string,
  { until: number; report: Promise<HealthReport> }
>();
export const healthRequest = async (request: Request) => {
  let session;
  try {
    session = await resolveDemoSession(request);
  } catch (error) {
    try {
      return sessionResponse(error);
    } catch {
      return Response.json(
        {
          ok: false,
          checks: [
            check(
              "Storage",
              "error",
              "Session storage is unavailable. Check the database connection and migrations.",
            ),
          ],
          checkedAt: new Date().toISOString(),
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  }
  const key = session?.thread.id ?? "shared";
  let value = cached.get(key);
  if (!value || value.until < Date.now()) {
    if (cached.size >= 64) cached.clear();
    value = { until: Date.now() + 30_000, report: checkHost(request, session) };
    cached.set(key, value);
  }
  const report = await value.report;
  return Response.json(report, {
    status: report.ok ? 200 : 503,
    headers: { "Cache-Control": "private, no-store" },
  });
};
