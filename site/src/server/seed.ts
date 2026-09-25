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
