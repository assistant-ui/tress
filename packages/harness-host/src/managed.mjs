import { Harness, HarnessCloud } from "harness-sdk";

/** Keep the managed credential and SDK's backend tunnel in the machine host. */
export function createManagedHarnessHost(options) {
  const { fetch: fetcher = globalThis.fetch, ...cloud } = options;
  // The SDK validates the origin, ids and credential and maintains the tunnel.
  const client = new Harness({
    transport: HarnessCloud({ ...cloud, fetch: fetcher }),
  });
  const origin = new URL(cloud.origin);
  const harnessId = origin.hostname.split(".")[0];
  const threadUrl = new URL(`/threads/${harnessId}~${cloud.threadId}`, origin);
  return {
    client,
    async fetch(request) {
      const incoming = new URL(request.url);
      const route = incoming.pathname.split("/").at(-1);
      if (!["stream", "frames"].includes(route))
        return new Response("Not found", { status: 404 });
      const target = new URL(`${threadUrl.pathname}/${route}`, origin);
      target.search = incoming.search;
      const headers = new Headers();
      for (const name of ["content-type", "accept", "last-event-id"])
        if (request.headers.has(name))
          headers.set(name, request.headers.get(name));
      for (const [name, value] of request.headers)
        if (name.startsWith("statewire-")) headers.set(name, value);
      headers.set(
        "Authorization",
        `Bearer ${typeof cloud.credential === "function" ? await cloud.credential() : cloud.credential}`,
      );
      headers.set("Aui-Workspace-Id", cloud.workspaceId);
      if (cloud.url) headers.set("Aui-Backend-Url", cloud.url);
      if (cloud.userId) headers.set("Aui-User-Id", cloud.userId);
      const response = await fetcher(target, {
        method: request.method,
        headers,
        signal: request.signal,
        redirect: "error",
        ...(request.method === "POST" && {
          body: request.body,
          duplex: "half",
        }),
      });
      const outputHeaders = new Headers({ "cache-control": "no-store" });
      for (const name of ["content-type", "retry-after"])
        if (response.headers.has(name))
          outputHeaders.set(name, response.headers.get(name));
      for (const [name, value] of response.headers)
        if (name.startsWith("statewire-")) outputHeaders.set(name, value);
      return new Response(response.body, {
        status: response.status,
        headers: outputHeaders,
      });
    },
    async close() {
      client.dispose();
    },
  };
}
