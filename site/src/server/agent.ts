// Loads the agent engine for server-side use.
//
// The wasm module is resolved from this file's own directory, which is the
// one path that stays correct however routes are bundled.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type TressSession = {
  send: (prompt: string, onEvent: (raw: string) => void) => Promise<void>;
  files: () => Record<string, string>;
};

type Ctor = new (
  url: string,
  model: string,
  headers: Record<string, string>,
  files: Record<string, string>,
) => TressSession;

/** A session over `files`, talking to the Messages API with the server's key. */
export const openSession = (files: Record<string, string>): TressSession => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set on the server");
  const { TressSession } = require("./pkg-node/tress_wasm.js") as {
    TressSession: Ctor;
  };
  return new TressSession(
    "https://api.anthropic.com/v1/messages",
    process.env.TRESS_MODEL ?? "claude-sonnet-5",
    { "x-api-key": key, "anthropic-version": "2023-06-01" },
    files,
  );
};

export const SEED_FILES = (): Record<string, string> => ({
  "retry.js": `export async function retry(fn, attempts = 5) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`,
  "retry.test.js": `import { retry } from "./retry.js";

test("gives up at once on a client error", async () => {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    throw Object.assign(new Error("bad request"), { status: 400 });
  };
  await expect(retry(fn)).rejects.toThrow("bad request");
  expect(calls).toBe(1);
});

test("waits between attempts instead of hammering", async () => {
  const started = Date.now();
  let calls = 0;
  const fn = async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error("busy"), { status: 503 });
    return "ok";
  };
  await expect(retry(fn)).resolves.toBe("ok");
  expect(Date.now() - started).toBeGreaterThanOrEqual(20);
});
`,
});
