import { workspaceConfig } from "../../../server/workspace";
import { threadMode } from "../../../server/config";
import { getThreadBackend } from "../../../server/thread-backend";
import {
  resolveDemoSession,
  sessionCookie,
  sessionResponse,
} from "../../../server/demo-session";

/** Tells the page which thread backend is in use. */
export const GET = async (request: Request) => {
  try {
    const session = await resolveDemoSession(request, true);
    const workspace = workspaceConfig(session?.thread.id);
    const mode = threadMode(request.url);
    const backend = process.env.TRESS_SERVERLESS === "1"
      ? undefined
      : await getThreadBackend(request, session);
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    });
    if (session?.fresh)
      headers.set("Set-Cookie", sessionCookie(session, request));
    return Response.json(
      {
        ...mode,
        ...(session
          ? {
              session: {
                id: session.thread.id,
                attachId: session.token,
                clientUrl: `/api/sessions/${session.token}`,
                browserUrl: `/?session=${session.token}`,
              },
            }
          : {}),
        ...(mode.kind === "cloud"
          ? { harness: backend && "info" in backend ? backend.info() : undefined }
          : {}),
        workspace: {
          mode: workspace.mode,
          writes: workspace.writes,
          localDemo: workspace.localDemo,
          ...(workspace.localDemo ? { root: workspace.root } : {}),
        },
        configured: Boolean(process.env.ANTHROPIC_API_KEY),
        model: process.env.TRESS_MODEL ?? "claude-sonnet-5",
      },
      { headers },
    );
  } catch (error) {
    return sessionResponse(error);
  }
};
