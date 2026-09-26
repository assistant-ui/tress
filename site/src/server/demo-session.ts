import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
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
  owner?: DemoOwner,
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
      if (create && owner?.id === thread.ownerId) {
        const selected = await ownedSession(thread, owner, store);
        return {
          ...selected,
          fresh: explicit == null && selected.token !== token,
        };
      }
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
  const id = randomUUID();
  const next = owner
    ? ownerThreadToken(owner, id)
    : randomBytes(9).toString("base64url");
  const now = new Date().toISOString();
  const thread: DemoThread = {
    id,
    ownerId: owner?.id ?? randomUUID(),
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

const OWNER_COOKIE = "tress_demo_owner";
export type DemoOwner = { id: string; token: string; fresh: boolean };
const cookieValue = (request: Request, name: string) =>
  request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);

export const resolveDemoOwner = async (
  request: Request,
  create = false,
  store: ThreadStore = threadStore(),
): Promise<DemoOwner | undefined> => {
  if (!isolatedDemo()) return undefined;
  const current = cookieValue(request, OWNER_COOKIE);
  if (current && /^[A-Za-z0-9_-]{32}$/.test(current)) {
    const id = await store.owner(accessHash(current));
    if (id) return { id, token: current, fresh: false };
  }
  if (!create) return undefined;
  const token = randomBytes(24).toString("base64url");
  // Only the original session cookie can adopt an unclaimed legacy thread.
  // Opening somebody else's explicit share link never adopts their ownership.
  const legacyToken = !new URL(request.url).searchParams.has("session")
    ? cookieValue(request, COOKIE)
    : undefined;
  const legacy =
    legacyToken && validToken(legacyToken)
      ? await store.get(accessHash(legacyToken))
      : undefined;
  return {
    token,
    id: await store.createOwner(accessHash(token), legacy?.ownerId),
    fresh: true,
  };
};

export const ownerCookie = (owner: DemoOwner, request: Request) =>
  `${OWNER_COOKIE}=${owner.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;

const ownerThreadToken = (owner: DemoOwner, id: string) =>
  createHmac("sha256", owner.token)
    .update(`tress.thread.v1:${id}`)
    .digest("base64url")
    .slice(0, 12);

export const ownedSession = async (
  thread: DemoThread,
  owner: DemoOwner,
  store: ThreadStore = threadStore(),
): Promise<DemoSession> => {
  if (thread.ownerId !== owner.id)
    throw new SessionError("Thread not found.", 404);
  const token = ownerThreadToken(owner, thread.id);
  await store.addAccess(thread.accessHash, accessHash(token));
  return { token, thread, fresh: true };
};

export const sessionInfo = (session: DemoSession) => ({
  id: session.thread.id,
  attachId: session.token,
  clientUrl: `/api/sessions/${session.token}`,
  browserUrl: `/?session=${session.token}`,
});
