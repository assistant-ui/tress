// Run from this package: npx tsx examples/local.ts /absolute/project "your prompt"
// First: npm run build && npm --prefix ../../site run wasm:node
import { createRequire } from "node:module";
import {
  createAgent,
  WORKSPACE_TOOLS,
  type HostSessionConstructor,
} from "../src/index.js";
import { createLocalWorkspace } from "../src/local.js";

const root = process.argv[2];
const prompt = process.argv[3];
const key = process.env.ANTHROPIC_API_KEY;
if (!root || !prompt || !key)
  throw new Error("Provide a directory, prompt, and ANTHROPIC_API_KEY.");
const { TressHostSession } = createRequire(import.meta.url)(
  "../../../site/src/server/pkg-node/tress_wasm.js",
) as { TressHostSession: HostSessionConstructor };
const workspace = await createLocalWorkspace({ root, mode: "overlay" });
const agent = createAgent({
  Session: TressHostSession,
  workspace,
  url: "https://api.anthropic.com/v1/messages",
  model: process.env.TRESS_MODEL ?? "claude-sonnet-5",
  headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  system:
    "Help with the requested task. Tools operate on a local directory with edits kept in memory. Bash is simulated; node, npm and native binaries are unavailable. Report only verification you actually performed.",
  tools: { include: WORKSPACE_TOOLS },
});
try {
  await agent.send(prompt, (event) => {
    if (event.type === "text") process.stdout.write(event.text);
    if (event.type === "tool") process.stdout.write(`\n· ${event.summary}\n`);
  });
  process.stdout.write("\n");
} finally {
  agent.dispose();
}
