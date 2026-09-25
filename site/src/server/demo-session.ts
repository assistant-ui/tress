import { createHash, randomBytes, randomUUID } from "node:crypto";
import { threadStore, type DemoThread, type ThreadStore } from "./thread-store";

const COOKIE = "tress_demo_session";
const validToken = (token: string) =>
  /^(?:[A-Za-z0-9_-]{12}|[A-Za-z0-9_-]{32})$/.test(token);
export const isolatedDemo = () => process.env.TRESS_DEMO_SHARED !== "1";
export const accessHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export type DemoSession = { token: string; thread: DemoThread; fresh: boolean };
export class SessionError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** A copied attach URL is a capability: knowing the thread's public id is not enough. */
export async function resolveDemoSession(
  request: Request,
  create = false,
  store: ThreadStore = threadStore(),
): Promise<DemoSession | undefined> {
  if (!isolatedDemo()) return undefined;
  const url = new URL(request.url);
  const routeToken = url.pathname.match(/^\/api\/sessions\/([^/]+)\//)?.[1];
  const explicit = routeToken ?? url.searchParams.get("session");
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  const token = explicit ?? cookie;
  if (token && validToken(token)) {
    const thread = await store.get(accessHash(token));
    if (thread) {
      // Upgrade the displayed ID, while keeping old commands and links valid.
      if (create && token.length === 32) {
        const short = createHash("sha256")
          .update(`tress.short-session.v1:${token}`)
          .digest("base64url")
          .slice(0, 12);
        await store.addAccess(thread.accessHash, accessHash(short));
        return { token: short, thread, fresh: explicit == null };
      }
      return { token, thread, fresh: false };
    }
  }
  if (explicit !== null && explicit !== undefined)
    throw new SessionError(
      "This session link is invalid or no longer available.",
      404,
    );
  if (!create)
    throw new SessionError(
      "Open the site and copy your thread's attach command.",
      401,
    );
  const next = randomBytes(9).toString("base64url");
  const id = randomUUID();
  const now = new Date().toISOString();
  const thread: DemoThread = {
    id,
    ownerId: randomUUID(),
    accessHash: accessHash(next),
    harnessThreadId: `tress-${id}`,
    createdAt: now,
    updatedAt: now,
  };
  await store.create(thread);
  return { token: next, thread, fresh: true };
}

export const sessionCookie = (session: DemoSession, request: Request) =>
  `${COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;

export const sessionResponse = (error: unknown) => {
  if (error instanceof SessionError)
    return Response.json(
      { error: error.message },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  throw error;
};
