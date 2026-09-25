import {
  resolveDemoOwner,
  resolveDemoSession,
  ownedSession,
  sessionInfo,
  sessionCookie,
  SessionError,
  sessionResponse,
} from "./demo-session";
import { threadStore, type DemoThread, type ThreadStore } from "./thread-store";

const summary = (thread: DemoThread) => ({
  id: thread.id,
  title: thread.title ?? null,
  archivedAt: thread.archivedAt ?? null,
  createdAt: thread.createdAt,
  updatedAt: thread.updatedAt,
});

/** Owner-only metadata; an attach capability never grants access to this list. */
export const threadListRequest = async (
  request: Request,
  store: ThreadStore = threadStore(),
) => {
  try {
    if (request.method !== "GET") {
      const origin = request.headers.get("origin");
      if (
        (origin && origin !== new URL(request.url).origin) ||
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        throw new SessionError("Use this site's thread controls.", 403);
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        throw new SessionError("Expected JSON.", 415);
    }
    const owner = await resolveDemoOwner(request, false, store);
    if (!owner)
      throw new SessionError("Open the demo to load your threads.", 401);
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    });
    const id = new URL(request.url).pathname.match(
      /^\/api\/threads\/([^/]+)$/,
    )?.[1];
    if (!id && request.method === "GET")
      return Response.json(
        { threads: (await store.list(owner.id)).map(summary) },
        { headers },
      );
    if (!id && request.method === "POST") {
      // A new session never inherits the currently selected session cookie.
      const freshRequest = new Request(new URL("/api/mode", request.url));
      const session = await resolveDemoSession(
        freshRequest,
        true,
        store,
        owner,
      );
      if (!session)
        throw new SessionError(
          "Threads are disabled in shared demo mode.",
          400,
        );
      headers.append("Set-Cookie", sessionCookie(session, request));
      return Response.json(
        { session: sessionInfo(session) },
        { status: 201, headers },
      );
    }
    if (!id || !/^[a-f0-9-]{36}$/.test(id))
      throw new SessionError("Thread not found.", 404);
    const thread = (await store.list(owner.id)).find(
      (thread) => thread.id === id,
    );
    if (!thread) throw new SessionError("Thread not found.", 404);
    if (request.method === "POST") {
      const session = await ownedSession(thread, owner, store);
      headers.append("Set-Cookie", sessionCookie(session, request));
      return Response.json({ session: sessionInfo(session) }, { headers });
    }
    if (request.method !== "PATCH")
      throw new SessionError("Unsupported method.", 405);
    const text = await request.text();
    if (text.length > 2048)
      throw new SessionError("Thread update is too large.", 413);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new SessionError("Invalid JSON.", 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new SessionError("Invalid thread update.", 400);
    const patch: { title?: string; archivedAt?: string | null } = {};
    if (body.title !== undefined) {
      if (
        typeof body.title !== "string" ||
        !body.title.trim() ||
        body.title.trim().length > 80
      )
        throw new SessionError("Use a title between 1 and 80 characters.", 400);
      patch.title = body.title.trim();
    }
    if (body.archived !== undefined) {
      if (typeof body.archived !== "boolean")
        throw new SessionError("Invalid archive value.", 400);
      patch.archivedAt = body.archived ? new Date().toISOString() : null;
    }
    if (!Object.keys(patch).length)
      throw new SessionError("Nothing to update.", 400);
    const updated = await store.update(
      owner.id,
      id,
      patch,
      body.ifUntitled === true,
    );
    if (!updated) throw new SessionError("Thread not found.", 404);
    return Response.json({ thread: summary(updated) }, { headers });
  } catch (error) {
    return sessionResponse(error);
  }
};
