// Where the demo's thread lives.
//
// Locally the thread is hosted in this process, which is what lets a run
// survive every client disconnecting. A deployed site points at assistant-ui
// cloud instead, where threads persist across restarts and come with a
// thread list — but the cloud reaches a `localhost` backend only through an
// open page, so it is not the local default.

export const HARNESS_ORIGIN =
  process.env.HARNESS_ORIGIN ??
  "https://at0600k385ob55agvefbz.harness.assistant-api.com";

export const HARNESS_WORKSPACE = process.env.HARNESS_WORKSPACE ?? "tress-demo";

/** The public https endpoint a harness can reach; unset locally. */
export const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL;

export type ThreadMode = { kind: "local" } | {
  kind: "cloud";
  origin: string;
  workspaceId: string;
  backendUrl: string;
};

/**
 * Cloud only when a harness key and a publicly reachable backend both exist,
 * since the cloud must be able to call the endpoint itself.
 */
export const threadMode = (): ThreadMode =>
  process.env.HARNESS_API_KEY && PUBLIC_BACKEND_URL
    ? {
        kind: "cloud",
        origin: HARNESS_ORIGIN,
        workspaceId: HARNESS_WORKSPACE,
        backendUrl: PUBLIC_BACKEND_URL,
      }
    : { kind: "local" };
