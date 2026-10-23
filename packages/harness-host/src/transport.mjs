import { createUIMessageStream } from "ai";
import { createAgent } from "@tress/workspaces";

// Engine checkpoints are message data owned by Harness, not a second chat store.
export function engineContext(messages) {
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant") continue;
    const part = message.parts.findLast(
      (part) => part.type === "data-tress-context",
    );
    if (part) {
      if (!Array.isArray(part.data))
        throw new Error("Invalid Tress engine checkpoint.");
      return part.data;
    }
  }
  return [];
}

export function createTressTransport(options) {
  return {
    async reconnectToStream() {
      return null;
    },
    async sendMessages({ messages, abortSignal }) {
      const last = messages.at(-1);
      if (last?.role !== "user") throw new Error("Expected a user prompt.");
      const prompt = last.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (!prompt.trim()) throw new Error("A text prompt is required.");
      await options.beforeRun?.();
      if (abortSignal?.aborted)
        throw new Error("Run cancelled before execution.");
      return createUIMessageStream({
        onError: (error) =>
          error instanceof Error ? error.message : String(error),
        execute: async ({ writer }) => {
          let toolId;
          let textId;
          let sequence = 0;
          const session = createAgent({
            ...options,
            messages: engineContext(messages.slice(0, -1)),
            tools: {
              ...options.tools,
              authorize: async (call) => {
                if (abortSignal?.aborted) return false;
                return options.tools?.authorize
                  ? options.tools.authorize(call)
                  : true;
              },
              onToolResult: async (call, result) => {
                writer.write({
                  type: "tool-output-available",
                  toolCallId: toolId,
                  output: result,
                  providerExecuted: true,
                });
                await options.tools?.onToolResult?.(call, result);
              },
            },
          });
          const closeText = () => {
            if (textId) writer.write({ type: "text-end", id: textId });
            textId = undefined;
          };
          writer.write({ type: "start" });
          try {
            await session.send(prompt, (event) => {
              if (event.type === "text") {
                if (!textId) {
                  textId = `text-${++sequence}`;
                  writer.write({ type: "text-start", id: textId });
                }
                writer.write({
                  type: "text-delta",
                  id: textId,
                  delta: event.text,
                });
              } else if (event.type === "tool") {
                closeText();
                toolId = `tool-${++sequence}`;
                writer.write({
                  type: "tool-input-available",
                  toolCallId: toolId,
                  toolName: event.name,
                  input: { summary: event.summary },
                  providerExecuted: true,
                  dynamic: true,
                });
              }
            });
          } finally {
            closeText();
            writer.write({
              type: "data-tress-context",
              data: session.checkpoint(),
            });
            session.dispose();
          }
          writer.write({ type: "finish", finishReason: "stop" });
        },
      });
    },
  };
}
