import type { ThreadMode } from "./config";
import { accessHash } from "./demo-session";
import { threadStore, type ThreadStore } from "./thread-store";
import { randomUUID } from "node:crypto";
import { HARNESS_PROTOCOL } from "harness-sdk";

/** Read-only probes still negotiate the Statewire wire and Harness protocols. */
export const managedStreamHeaders = (
  config: Extract<ThreadMode, { kind: "cloud" }>,
  backendUrl = config.backendUrl,
) => ({
  Authorization: `Bearer ${process.env.HARNESS_API_KEY}`,
  "Aui-Workspace-Id": config.workspaceId,
  "Aui-Backend-Url": backendUrl,
  "Statewire-Client-Id": `tress-probe-${randomUUID()}`,
  // Statewire 0.19's wire version; a real host contract test catches drift.
  "Statewire-Version": '"2026-09-13"',
  "Statewire-Protocol": `${HARNESS_PROTOCOL.name}; version="${HARNESS_PROTOCOL.version}"; min-version="${HARNESS_PROTOCOL.minVersion}"`,
  Accept: "text/event-stream",
});

/** Harness pins a callback URL for life; display/attach aliases can change. */
export const managedBackendUrl = async (
  config: Extract<ThreadMode, { kind: "cloud" }>,
  scope: string,
  threadId: string,
  store: Pick<ThreadStore, "get"> = threadStore(),
  fetcher: typeof fetch = fetch,
): Promise<string> => {
  const proposed = new URL(config.backendUrl);
  const origin = new URL(config.origin);
  const id = `${origin.hostname.split(".")[0]}~${threadId}`;
  let response: Response;
  try {
    // Open only the state stream, never a run. Resolve the pin before mounting
    // either the cloud client or its local callback tunnel.
    response = await fetcher(new URL(`/threads/${id}/stream`, origin), {
      headers: managedStreamHeaders(config, proposed.href),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Let the SDK handle transient network errors and authentication normally.
    return proposed.href;
  }
  if (response.status !== 403) {
    await response.body?.cancel();
    return proposed.href;
  }
  const body = await response.json().catch(() => null);
  const prefix = "thread is pinned to ";
  if (typeof body?.detail !== "string" || !body.detail.startsWith(prefix))
    return proposed.href;
  let pinned: URL;
  try {
    pinned = new URL(body.detail.slice(prefix.length));
  } catch {
    return proposed.href;
  }
  const token = pinned.searchParams.get("session");
  if (!token || !/^(?:[A-Za-z0-9_-]{12}|[A-Za-z0-9_-]{32})$/.test(token))
    return proposed.href;
  const withoutSession = (url: URL) => {
    const copy = new URL(url);
    copy.searchParams.delete("session");
    copy.searchParams.sort();
    return copy.href;
  };
  // A cloud error must never redirect our tunnel to another host, endpoint,
  // or visitor's files. Only an existing alias of this exact workspace is valid.
  if (
    pinned.searchParams.getAll("session").length !== 1 ||
    withoutSession(pinned) !== withoutSession(proposed) ||
    (await store.get(accessHash(token)))?.id !== scope
  )
    return proposed.href;
  return pinned.href;
};
