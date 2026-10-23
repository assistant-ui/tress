import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { startMachineHost } from "./server.mjs";
const require = createRequire(import.meta.url);
if (Number(process.versions.node.split(".")[0]) < 22)
  throw new Error("The Harness host requires Node.js 22 or newer.");
if (!process.env.ANTHROPIC_API_KEY)
  throw new Error("Set ANTHROPIC_API_KEY on the host machine.");
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    "state-dir": { type: "string" },
    "allow-write": { type: "boolean" },
    "allow-exec": { type: "boolean" },
    port: { type: "string" },
    managed: { type: "boolean" },
  },
});
if (!values.root || !values["state-dir"])
  throw new Error("Pass --root and --state-dir.");
const cloud = values.managed
  ? {
      origin: process.env.HARNESS_ORIGIN,
      workspaceId: process.env.HARNESS_WORKSPACE,
      threadId: process.env.HARNESS_THREAD_ID,
      credential: () => Promise.resolve(process.env.HARNESS_API_KEY),
    }
  : undefined;
if (
  cloud &&
  (!cloud.origin ||
    !cloud.workspaceId ||
    !cloud.threadId ||
    !process.env.HARNESS_API_KEY)
)
  throw new Error(
    "Managed mode needs HARNESS_ORIGIN, HARNESS_WORKSPACE, HARNESS_THREAD_ID, and HARNESS_API_KEY on this machine.",
  );
const { TressHostSession } = require("./wasm/tress_wasm.js");
const anthropicWorkspace = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
const host = await startMachineHost({
  root: values.root,
  stateDir: values["state-dir"],
  allowWrite: values["allow-write"],
  allowExec: values["allow-exec"],
  port: values.port ? Number(values.port) : undefined,
  Session: TressHostSession,
  browserJs: await readFile(new URL("./browser.js", import.meta.url), "utf8"),
  browserCss: await readFile(new URL("./browser.css", import.meta.url), "utf8"),
  cloud,
  maxSteps: Number(process.env.TRESS_MAX_STEPS ?? 64),
  model: process.env.TRESS_MODEL ?? "claude-sonnet-5",
  modelUrl: `${(process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`,
  modelHeaders: {
    "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
    "anthropic-version": "2023-06-01",
    ...(anthropicWorkspace && { "anthropic-workspace-id": anthropicWorkspace }),
  },
  onError: (error) => console.error(`tress host: ${error.message}`),
});
console.log(JSON.stringify(host));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.once(signal, async () => {
    await host.close();
    process.exit();
  });
