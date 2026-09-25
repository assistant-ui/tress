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
  "cart.js": `export function cartTotal(items, discountPercent = 0) {
  return items.reduce((sum, item) => {
    const price = item.price * (1 - discountPercent / 100);
    return sum + Math.round(price * 100) / 100 * item.quantity;
  }, 0);
}
`,
  "cart.test.js": `import { cartTotal } from "./cart.js";

test("applies a discount to the whole cart", () => {
  const items = [{ price: 9.99, quantity: 7 }];
  expect(cartTotal(items, 15)).toBe(59.44);
});
`,
});
