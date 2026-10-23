/** One bootstrap per document, including React effect cleanup/remounts. */
export const createDemoPage = (
  href: string,
  navigationType: string | undefined,
  fetcher: typeof fetch = globalThis.fetch,
) => {
  const session = new URL(href).searchParams.get("session");
  const token = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(9))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_");
  const url =
    session && navigationType !== "reload"
      ? `/api/mode?session=${encodeURIComponent(session)}`
      : `/api/mode?newSession=${token}`;
  let pending: Promise<Response> | undefined;
  const fetchConfig: typeof fetch = async (input, init) => {
    if (input !== url) return fetcher(input, init);
    // The shared bootstrap owns its timeout. Disposing one observer must not
    // cancel the request for the next observer or lose its owner cookie.
    pending ??= fetcher(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    })
      .then((response) => {
        if (!response.ok) pending = undefined;
        return response;
      })
      .catch((error) => {
        pending = undefined;
        throw error;
      });
    return (await pending).clone();
  };
  return { url, fetchConfig };
};

let page: ReturnType<typeof createDemoPage> | undefined;
export const demoPage = () =>
  (page ??= createDemoPage(
    window.location.href,
    (
      performance.getEntriesByType("navigation")[0] as
        | PerformanceNavigationTiming
        | undefined
    )?.type,
  ));
