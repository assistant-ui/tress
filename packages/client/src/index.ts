import { Harness } from "harness-sdk";
import { StatewireWebsocket } from "statewire";

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
  /** HTTP(S) thread endpoint; the client dials its `/ws` WebSocket. Absolute URL in Node; same-origin relative paths also work in browsers. */
  url: string;
  /**
   * Application-issued user credentials. Never put provider or Harness admin keys here.
   * They travel in the first WebSocket message of every attach, never in the URL.
   * A function runs on every attach; `staleAuth` is true after the host refused the last ones.
   */
  headers?:
    | HeadersInit
    | ((context: {
        staleAuth: boolean;
      }) => HeadersInit | Promise<HeadersInit>);
  /** WebSocket constructor; defaults to the global one (browsers, Node 22+). */
  webSocket?: new (url: string, protocols?: string | string[]) => WebSocket;
}

/** Connect an interface to its existing host; this creates no agent or thread store. */
export function createTressClient(
  options: TressConnectionOptions,
): TressClient {
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
  const { headers, webSocket } = options;
  return new Harness({
    transport: StatewireWebsocket({
      url: endpoint.href.replace(/\/$/, ""),
      ...(headers !== undefined && { headers }),
      ...(webSocket !== undefined && { webSocket }),
    }),
  });
}
