import { threadMode } from "./config";
import { managedGateway } from "./managed";
import { resolveDemoSession, type DemoSession } from "./demo-session";
import { threadStore } from "./thread-store";

export const getThreadHost = async (request: Request) => {
  return (await getThreadBackend(request)).host;
};

export const getThreadBackend = async (
  request: Request,
  session?: DemoSession,
) => {
  session ??= await resolveDemoSession(request);
  const mode = threadMode(request.url);
  if (mode.kind === "cloud") {
    if (!session) return managedGateway(mode);
    const backendUrl = new URL(mode.backendUrl);
    backendUrl.searchParams.set("session", session.token);
    return managedGateway(
      { ...mode, backendUrl: backendUrl.href },
      {
        scope: session.thread.id,
        threadId: session.thread.harnessThreadId,
        selectThread: (id) =>
          threadStore().selectThread(session.thread.accessHash, id),
      },
    );
  }
  return (await import("./thread")).localThreadBackend(session?.thread.id);
};
