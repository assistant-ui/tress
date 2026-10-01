import type { WorkspaceDetails } from "@tress/workspaces";

export type DemoConfig = {
  configured: boolean;
  model: string;
  host?: {
    label: string;
    runtime: "local" | "managed";
  };
  session?: {
    id: string;
    attachId: string;
    clientUrl: string;
    browserUrl: string;
  };
  workspace?: {
    mode: string;
    writes: boolean;
    localDemo?: boolean;
    root?: string;
    details?: WorkspaceDetails;
  };
};

type Update =
  | { status: "loading" }
  | { status: "ready"; config: DemoConfig }
  | { status: "error"; message?: string; retryable?: boolean };

/** Recover from host restarts without replacing the conversation or draft. */
export const observeDemoConfig = (
  update: (value: Update) => void,
  fetcher: typeof fetch = globalThis.fetch,
  url = "/api/mode",
) => {
  let disposed = false;
  let loaded = false;
  let failures = 0;
  let active: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const retry = async () => {
    if (disposed || active) return;
    clearTimeout(timer);
    const controller = new AbortController();
    active = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    update({ status: "loading" });
    let failure: { message?: string; retryable?: boolean } = {};
    let retryAfter: number | undefined;
    try {
      const response = await fetcher(url, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) {
        if ([400, 401, 403, 404, 410, 429].includes(response.status)) {
          const body = await response.json().catch(() => null);
          failure = {
            message:
              typeof body?.error === "string"
                ? body.error.slice(0, 500)
                : "This session is unavailable. Open the site to start a new one.",
            retryable: response.status === 429,
          };
          const seconds = Number(response.headers.get("Retry-After"));
          if (Number.isFinite(seconds) && seconds > 0)
            retryAfter = Math.min(seconds, 86_400) * 1000;
        }
        throw new Error("Configuration unavailable");
      }
      const config = await response.json();
      if (
        !config ||
        typeof config.configured !== "boolean" ||
        typeof config.model !== "string"
      )
        throw new Error("Invalid configuration response");
      if (disposed) return;
      loaded = true;
      failures = 0;
      update({ status: "ready", config });
    } catch {
      if (disposed) return;
      loaded = false;
      update({ status: "error", ...failure });
      if (failure.retryable !== false)
        timer = setTimeout(
          () => void retry(),
          retryAfter ?? Math.min(1000 * 2 ** failures++, 15_000),
        );
    } finally {
      clearTimeout(timeout);
      active = undefined;
    }
  };

  void retry();
  return {
    retry,
    retryIfNeeded: () => {
      if (!loaded) void retry();
    },
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      active?.abort();
    },
  };
};
