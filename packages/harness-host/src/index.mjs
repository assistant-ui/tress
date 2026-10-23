import { resource, useResource } from "@assistant-ui/tap";
import { AISDKTransport } from "@harness-sdk/ai-sdk";
import { HARNESS_HOST_PROTOCOL } from "harness-sdk/host";
import { statewireHost } from "statewire-node";
export { createTressTransport } from "./transport.mjs";

/** Mount the actual Harness state machine with application-owned storage. */
export function createLocalHarnessHost({
  threadId,
  transport,
  storage,
  onError = console.error,
}) {
  let instance;
  let storageError;
  let pending = Promise.resolve();
  const save = (snapshot) => {
    // The SDK may have queued older snapshots. Write the newest state when
    // this operation reaches the disk queue so it cannot roll back a flush.
    const next = pending.then(() =>
      storage.save(instance ? instance.snapshot() : snapshot),
    );
    pending = next.catch((error) => {
      storageError = error;
      onError(error);
    });
    return next;
  };
  const flush = async () => {
    await pending;
    if (storageError)
      throw new Error(`Harness storage failed: ${storageError.message}`);
    if (instance) await save(instance.snapshot());
  };
  const Captured = resource(({ restored }) => {
    instance = useResource(
      AISDKTransport({
        threadId,
        transport: {
          reconnectToStream: (options) => transport.reconnectToStream(options),
          async sendMessages(options) {
            // Persist the accepted user message before the engine may call a tool.
            await flush();
            return transport.sendMessages(options);
          },
        },
        ...(restored !== undefined && { initialState: restored }),
      }),
    );
    return instance;
  });
  const host = statewireHost({
    key: [threadId],
    protocol: HARNESS_HOST_PROTOCOL,
    transport: (restored) => Captured({ restored }),
    storage: { load: storage.load, save },
    persistDebounceMs: 0,
    onError: (error) => {
      storageError = error;
      onError(error);
    },
  });
  return {
    async fetch(request) {
      if (storageError && request.method === "POST")
        return new Response(
          "Harness storage unavailable; restart after repairing storage.",
          { status: 503 },
        );
      return host.fetch(request);
    },
    flush,
    async close() {
      try {
        await flush();
      } finally {
        await host.close();
        await pending;
      }
    },
  };
}
