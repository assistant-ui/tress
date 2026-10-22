import { Harness } from "harness-sdk";
import { StatewireHttp } from "statewire";

/** Structural types also accept an application's existing Harness instance. */
export interface TressMessage {
  id: string;
  role: string;
  parts: readonly {
    type: string;
    text?: string;
    toolName?: string;
    toolCallId?: string;
    input?: unknown;
    output?: unknown;
    state?: string;
    errorText?: string;
  }[];
}
export interface TressClient {
  readonly messages: readonly TressMessage[];
  readonly isLoading: boolean;
  readonly isBusy: boolean;
  readonly error?: { message: string };
  readonly transport: {
    readonly status: string;
    readonly error?: { message: string };
  };
  sendMessage(text: string): Promise<unknown>;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}
export interface TressConnectionOptions {
  /** Absolute URL in Node; same-origin relative paths also work in browsers. */
  url: string;
  /** Application-issued user credentials. Never put provider or Harness admin keys here. */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  fetch?: typeof globalThis.fetch;
}

/** Authenticate both the stream and command requests, including lease frames. */
export function createTressFetch(
  options: TressConnectionOptions,
): typeof globalThis.fetch {
  const endpoint = new URL(options.url, globalThis.location?.href);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      "Use an HTTP(S) thread endpoint without credentials, query, or fragment.",
    );
  const root = endpoint.href.replace(/\/$/, "");
  return async (input, init = {}) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      globalThis.location?.href,
    );
    if (!url.href.startsWith(root + "/"))
      throw new Error(
        "Tress credentials are restricted to the configured thread endpoint.",
      );
    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    new Headers(init.headers).forEach((value, name) =>
      headers.set(name, value),
    );
    const configured =
      typeof options.headers === "function"
        ? await options.headers()
        : options.headers;
    new Headers(configured).forEach((value, name) => headers.set(name, value));
    return (options.fetch ?? globalThis.fetch)(input, {
      ...init,
      headers,
      credentials: "same-origin",
      redirect: "error",
    });
  };
}

/** Connect an interface to its existing host; this creates no agent or thread store. */
export function createTressClient(
  options: TressConnectionOptions,
): TressClient {
  const url = new URL(options.url, globalThis.location?.href).href.replace(
    /\/$/,
    "",
  );
  return new Harness({
    transport: StatewireHttp({ url, fetch: createTressFetch(options) }),
  });
}
