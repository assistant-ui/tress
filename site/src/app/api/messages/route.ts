// The demo's model endpoint.
//
// With ANTHROPIC_API_KEY set this forwards to Anthropic and the agent in the
// page is live. Without one it replays a recorded session, so the site works
// on a static deploy — the page says which mode it is in.

const SCRIPT_HEADER = "x-tress-mode";
import { resolveDemoSession, sessionResponse } from "../../../server/demo-session";

type Block =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; input: Record<string, unknown> };

const CART_FIXED = `export function cartTotal(items, discountPercent = 0) {
  const subtotal = items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0,
  );
  const discounted = subtotal * (1 - discountPercent / 100);
  return Math.round(discounted * 100) / 100;
}
`;

// One recorded session per prompt shape, as the turns the agent takes.
const RECORDED: { match: RegExp; turns: Block[][] }[] = [
  {
    match: /bug|fix|wrong|broken|total/i,
    turns: [
      [
        { kind: "text", text: "Let me look at the cart and its test." },
        { kind: "tool", name: "read", input: { path: "cart.js" } },
        { kind: "tool", name: "read", input: { path: "cart.test.js" } },
      ],
      [
        {
          kind: "text",
          text: "Found it. The discount is applied to each item's price and rounded to cents *before* multiplying by quantity, so the rounding error is multiplied too. On 7 items at 9.99 with 15% off that loses a cent: the test expects 59.44 and gets 59.43.\n\nApplying the discount to the subtotal and rounding once at the end:",
        },
        {
          kind: "tool",
          name: "write",
          input: { path: "cart.js", content: CART_FIXED },
        },
      ],
      [
        {
          kind: "text",
          text: "Fixed. The subtotal is summed first, the discount applies to it once, and the result is rounded a single time — so 7 × 9.99 at 15% off is 59.44, matching the test.",
        },
      ],
    ],
  },
  {
    match: /explain|what does|how does|understand/i,
    turns: [
      [
        { kind: "text", text: "Reading it now." },
        { kind: "tool", name: "read", input: { path: "cart.js" } },
      ],
      [
        {
          kind: "text",
          text: "`cartTotal(items, discountPercent)` walks the items, discounts each price, and adds up `price × quantity`, rounding to cents as it goes.\n\nOne thing worth flagging: each discounted price is rounded *before* the quantity multiply, so the rounding error scales with the quantity. On 7 items at 9.99 with 15% off it is already a cent low.",
        },
      ],
    ],
  },
  {
    match: /.*/,
    turns: [
      [
        { kind: "text", text: "Let me see what is here." },
        { kind: "tool", name: "ls", input: {} },
      ],
      [
        {
          kind: "text",
          text: "This workspace has `cart.js` and `cart.test.js`. Try asking me to find the bug in `cart.js` — there is a real one — or to explain what the code does.",
        },
      ],
    ],
  },
];

/** Whether the key is one the API will actually accept. */
async function keyState(key: string): Promise<"live" | "rejected"> {
  try {
    const probe = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    return probe.status === 401 || probe.status === 403 ? "rejected" : "live";
  } catch {
    return "rejected";
  }
}

/** Renders one turn as Messages API stream events. */
function streamFor(blocks: Block[]): string {
  const events: unknown[] = [{ type: "message_start" }];
  let index = 0;
  let stopReason = "end_turn";

  for (const block of blocks) {
    if (block.kind === "text") {
      events.push({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      // Split into words so the reply types out rather than appearing at once.
      for (const chunk of block.text.match(/\S+\s*/g) ?? []) {
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: chunk },
        });
      }
    } else {
      stopReason = "tool_use";
      events.push({
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: `call_${index}`,
          name: block.name,
          input: {},
        },
      });
      events.push({
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input),
        },
      });
    }
    events.push({ type: "content_block_stop", index });
    index += 1;
  }

  events.push({ type: "message_delta", delta: { stop_reason: stopReason } });
  events.push({ type: "message_stop" });
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

/** The first user message in the conversation, which picks the recording. */
function firstPrompt(messages: { role: string; content: unknown }[]): string {
  const first = messages.find((message) => message.role === "user");
  return typeof first?.content === "string" ? first.content : "";
}

/** How many assistant turns have already happened. */
function turnIndex(messages: { role: string }[]): number {
  return messages.filter((message) => message.role === "assistant").length;
}

export async function POST(request: Request) {
  try { await resolveDemoSession(request); }
  catch (error) { return sessionResponse(error); }
  const body = await request.text();
  const key = process.env.ANTHROPIC_API_KEY;
  const parsedBody = JSON.parse(body) as {
    messages: { role: string; content: unknown }[];
    probe?: boolean;
  };

  // The page asks once on load which mode it is in. A key that the API
  // rejects reports as rejected rather than live, so a bad key is visible
  // before a run rather than halfway through one.
  if (parsedBody.probe) {
    const mode = key ? await keyState(key) : "replay";
    return new Response(null, { headers: { [SCRIPT_HEADER]: mode } });
  }

  if (key) {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": "text/event-stream",
        [SCRIPT_HEADER]: "live",
      },
    });
  }

  const recording =
    RECORDED.find((entry) => entry.match.test(firstPrompt(parsedBody.messages))) ??
    RECORDED[RECORDED.length - 1];
  const turn =
    recording.turns[
      Math.min(turnIndex(parsedBody.messages), recording.turns.length - 1)
    ];

  // Paced so the recording reads like a session rather than a paste.
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const line of streamFor(turn).split(/(?<=\n\n)/)) {
        controller.enqueue(encoder.encode(line));
        await new Promise((resolve) => setTimeout(resolve, 18));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      [SCRIPT_HEADER]: "replay",
    },
  });
}
