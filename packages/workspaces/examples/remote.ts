// Uses an existing caller-owned sandbox. No implicit create or stop.
import { Sandbox } from "@vercel/sandbox";
import { createVercelWorkspace } from "../src/vercel.js";
import { createWorkspaceTools, WORKSPACE_TOOLS } from "../src/index.js";

const name = process.env.TRESS_SANDBOX_NAME;
if (!name)
  throw new Error(
    "Set TRESS_SANDBOX_NAME and configure Vercel SDK credentials.",
  );
const sandbox = await Sandbox.get({ name });
const workspace = await createVercelWorkspace({
  sandbox,
  root: "/vercel/sandbox",
  timeoutMs: 30_000,
});
// Pass this same workspace to createAgent() as in local.ts, or embed only tools.
const tools = createWorkspaceTools(workspace, { include: WORKSPACE_TOOLS });
console.log(await tools.execute("ls", {}));
console.log(await tools.execute("bash", { command: "node --version" }));
