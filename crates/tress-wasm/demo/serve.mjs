// Dev server for the demo: serves the page and proxies /v1/messages.
// With ANTHROPIC_API_KEY set it forwards to Anthropic; without one it
// replays a scripted stream so the demo runs offline.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const port = Number(process.argv[2] ?? 8080);
const root = import.meta.dirname;
const key = process.env.ANTHROPIC_API_KEY;

const types = {
  ".html": "text/html", ".js": "text/javascript",
  ".wasm": "application/wasm", ".ts": "text/plain",
};

const scripted = (prompt) => {
  const path = /\.py|python|greet/i.test(prompt) ? "greet.py" : "notes.md";
  const content = path.endsWith(".py")
    ? 'def greet(name):\n    return f"hello, {name}"\n'
    : `# notes\n\n${prompt}\n`;
  const events = [
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Writing ${path}.` } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "c1", name: "write", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path, content }) } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ];
  const done = [
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ` Done — ${path} is in the workspace.` } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ];
  return { events, done };
};

const seen = new Map();

createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");

  if (url.pathname === "/v1/messages" && request.method === "POST") {
    const body = await new Promise((resolve) => {
      let data = ""; request.on("data", (c) => (data += c)); request.on("end", () => resolve(data));
    });
    if (key) {
      const upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body,
      });
      response.writeHead(upstream.status, { "content-type": "text/event-stream" });
      for await (const chunk of upstream.body) response.write(chunk);
      response.end();
      return;
    }
    const parsed = JSON.parse(body);
    const prompt = parsed.messages[0]?.content ?? "";
    const turn = seen.get(prompt) ? "done" : "events";
    seen.set(prompt, true);
    const script = scripted(typeof prompt === "string" ? prompt : "");
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of script[turn]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
    return;
  }

  const file = join(root, normalize(url.pathname === "/" ? "/index.html" : url.pathname));
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end("not found");
  }
}).listen(port, () => console.log(`demo on http://127.0.0.1:${port}`));
