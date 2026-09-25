// The AI SDK endpoint a harness runs against.
//
// assistant-ui cloud owns the thread and calls this endpoint for each turn.
// The turn is executed by the same Rust engine the binary runs, loaded here
// as a Node wasm module, and its output is written out as AI SDK stream
// parts so the cloud can store and replicate it.

import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { UIMessage } from "ai";
import { openSession, SEED_FILES } from "../../../server/agent";

/** The text of a UI message, whatever part shape it arrived in. */
const textOf = (message: UIMessage | undefined): string =>
  (message?.parts ?? [])
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();

/**
 * Rebuilds the workspace from the transcript.
 *
 * The cloud owns thread history, not this endpoint, so each turn replays the
 * files recorded on earlier turns rather than keeping state in this process.
 */
const workspaceFrom = (messages: UIMessage[]): Record<string, string> => {
  let files = SEED_FILES();
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (
        part.type === "data-files" &&
        part.data &&
        typeof part.data === "object"
      ) {
        files = part.data as Record<string, string>;
      }
    }
  }
  return files;
};

export const POST = async (request: Request) => {
  const { messages } = (await request.json()) as { messages: UIMessage[] };
  const prompt = textOf(messages.filter((m) => m.role === "user").at(-1));
  const key = process.env.ANTHROPIC_API_KEY;

  const stream = createUIMessageStream({
    onError: (error) => `tress: ${error instanceof Error ? error.message : String(error)}`,
    execute: async ({ writer }) => {
      if (!key) {
        writer.write({
          type: "text-start",
          id: "t0",
        });
        writer.write({
          type: "text-delta",
          id: "t0",
          delta: "The server has no ANTHROPIC_API_KEY, so this turn cannot run.",
        });
        writer.write({ type: "text-end", id: "t0" });
        return;
      }

      const session = openSession(workspaceFrom(messages));

      const id = "t0";
      let open = false;
      await session.send(prompt, (raw: string) => {
        const event = JSON.parse(raw) as {
          type: string;
          text?: string;
          summary?: string;
        };
        if (event.type === "text" && event.text) {
          if (!open) {
            writer.write({ type: "text-start", id });
            open = true;
          }
          writer.write({ type: "text-delta", id, delta: event.text });
        } else if (event.type === "tool" && event.summary) {
          // Tool activity rides as transient data so it shows while the run
          // streams without becoming part of the stored transcript.
          writer.write({
            type: "data-tool",
            data: { summary: event.summary },
            transient: true,
          });
        }
      });
      if (open) writer.write({ type: "text-end", id });

      // The resulting workspace is recorded on the turn, which is what the
      // next turn replays.
      writer.write({ type: "data-files", data: session.files() });
    },
  });

  return createUIMessageStreamResponse({ stream });
};
