// Exercise the built gateway with a rejected managed connection, without cloud credentials.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatewireClient, StatewireHttp } from "statewire";

const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const root = await mkdtemp(join(tmpdir(), "tress-managed-boot-"));
const url = `http://127.0.0.1:${port}`;
const secret = "unusable-managed-test-key";
const host = spawn(process.execPath, [".farm/.output/server/index.mjs"], {
  cwd: new URL("../", import.meta.url),
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    HOST: "127.0.0.1",
    TRESS_THREAD_MODE: "cloud",
    TRESS_DEMO_SHARED: "1",
    TRESS_WORKSPACE: "memory",
    HARNESS_STATE_DIR: root,
    HARNESS_API_KEY: secret,
    HARNESS_ORIGIN: "http://managed.invalid",
    HARNESS_WORKSPACE: "tests",
    HARNESS_THREAD_ID: "boot-test",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let client;
host.stdout.on("data", (chunk) => (output += chunk));
host.stderr.on("data", (chunk) => (output += chunk));
const wait = async (condition) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (host.exitCode !== null) throw new Error(output);
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Managed production boot failed: ${output}`);
};
try {
  let mode;
  await wait(async () => {
    try {
      const response = await fetch(`${url}/api/mode`);
      if (!response.ok) return false;
      mode = await response.json();
      return true;
    } catch {
      return false;
    }
  });
  assert.equal(mode.kind, "cloud");
  assert.equal(mode.harness.threadId, "boot-test");
  assert(!JSON.stringify(mode).includes(secret));
  client = new StatewireClient({
    transport: StatewireHttp({ url: `${url}/api/thread` }),
  });
  await wait(() => client.state?.harness);
  assert.equal(client.state.harness.threadId, "boot-test");
  assert.equal(client.state.entries.length, 0);
  assert(!JSON.stringify(client.state).includes(secret));
  await assert.rejects(
    client.commands.send("A disconnected cloud must not run locally"),
  );
  console.log(
    "✓ production managed gateway boots, serves both client protocol routes, and keeps credentials server-side",
  );
} finally {
  client?.dispose();
  host.kill("SIGTERM");
  await once(host, "exit");
  await rm(root, { recursive: true, force: true });
}
