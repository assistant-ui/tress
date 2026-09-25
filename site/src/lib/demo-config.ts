export type DemoConfig = {
  configured: boolean;
  model: string;
  workspace?: {
    mode: string;
    writes: boolean;
    localDemo?: boolean;
    root?: string;
  };
};

type Update =
  | { status: "loading" }
  | { status: "ready"; config: DemoConfig }
  | { status: "error" };

/** Recover from host restarts without replacing the conversation or draft. */
export const observeDemoConfig = (
  update: (value: Update) => void,
  fetcher: typeof fetch = globalThis.fetch,
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
    try {
      const response = await fetcher("/api/mode", {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Configuration unavailable");
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
      update({ status: "error" });
      timer = setTimeout(
        () => void retry(),
        Math.min(1000 * 2 ** failures++, 15_000),
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
