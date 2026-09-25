export type ThreadMode =
  | { kind: "local" }
  | {
      kind: "cloud";
      origin: string;
      workspaceId: string;
      backendUrl: string;
      initialThreadId: string;
    };

/** Credentials stay on the server; both clients use the same managed thread. */
export const threadMode = (requestUrl: string): ThreadMode => {
  const mode = process.env.TRESS_THREAD_MODE;
  if (mode && mode !== "local" && mode !== "cloud")
    throw new Error("TRESS_THREAD_MODE must be local or cloud.");
  if (mode === "local" || (!mode && !process.env.HARNESS_API_KEY))
    return { kind: "local" };
  if (!process.env.HARNESS_API_KEY)
    throw new Error("Cloud mode requires HARNESS_API_KEY.");
  return {
    kind: "cloud",
    origin:
      process.env.HARNESS_ORIGIN ??
      "https://at0600k385ob55agvefbz.harness.assistant-api.com",
    workspaceId: process.env.HARNESS_WORKSPACE ?? "tress-demo",
    backendUrl:
      process.env.PUBLIC_BACKEND_URL ?? new URL("/api/chat", requestUrl).href,
    initialThreadId: process.env.HARNESS_THREAD_ID ?? "tress-local-demo",
  };
};
