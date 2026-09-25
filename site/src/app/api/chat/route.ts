import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { openSession } from "../../../server/agent";
import {
  contextFrom,
  managedWorkspace,
  refreshManagedFiles,
} from "../../../server/managed-workspace";

/** Managed Harness calls this endpoint with its persisted conversation. */
export const POST = async (request: Request) => {
  const body = await request.json();
  const messages = body.messages as UIMessage[];
  if (
    !Array.isArray(messages) ||
    messages.some((m) => !m || !Array.isArray(m.parts)) ||
    messages.at(-1)?.role !== "user"
  )
    return Response.json(
      { error: "Expected a conversation ending with a user message." },
      { status: 400 },
    );
  const prompt = messages
    .at(-1)!
    .parts.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  if (!prompt)
    return Response.json(
      { error: "A text prompt is required." },
      { status: 400 },
    );
  if (!process.env.ANTHROPIC_API_KEY)
    return Response.json(
      { error: "ANTHROPIC_API_KEY is not configured." },
      { status: 503 },
    );
  if (typeof body.id !== "string" || !body.id)
    return Response.json(
      { error: "A managed thread id is required." },
      { status: 400 },
    );
  const threadId = body.id.split("~").at(-1)!;
  const history = messages.slice(0, -1);
  const stream = createUIMessageStream({
    onError: (error) =>
      `tress: ${error instanceof Error ? error.message : String(error)}`,
    execute: async ({ writer }) => {
      const workspace = await managedWorkspace(threadId, history);
      let toolId = "";
      let toolCount = 0;
      const session = await openSession(workspace, {
        messages: contextFrom(history),
        onToolResult: async (_call, result) => {
          writer.write({
            type: "tool-output-available",
            toolCallId: toolId,
            output: result,
            providerExecuted: true,
          });
          await refreshManagedFiles(threadId);
        },
      });
      writer.write({ type: "start" });
      let textId: string | undefined;
      let textCount = 0;
      const closeText = () => {
        if (textId) writer.write({ type: "text-end", id: textId });
        textId = undefined;
      };
      try {
        await session.send(prompt, (event) => {
          if (event.type === "text" && event.text) {
            if (!textId) {
              textId = `text-${++textCount}`;
              writer.write({ type: "text-start", id: textId });
            }
            writer.write({ type: "text-delta", id: textId, delta: event.text });
          } else if (event.type === "tool") {
            closeText();
            toolId = `tool-${++toolCount}`;
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
        closeText();
        writer.write({
          type: "data-tress-context",
          data: session.checkpoint(),
        });
        const files = await refreshManagedFiles(threadId);
        writer.write({ type: "data-files", data: files });
        writer.write({
          type: "finish",
          finishReason: "stop",
          messageMetadata: { provider: { tress: { files } } },
        });
      } finally {
        session.dispose();
      }
    },
  });
  return createUIMessageStreamResponse({ stream });
};
