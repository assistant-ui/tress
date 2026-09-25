import { getThreadBackend } from "./thread-backend";
import { sessionResponse } from "./demo-session";
import { trackStreamPresence } from "./presence";

export const stream = async (request: Request) => {
  try {
    if (process.env.TRESS_SERVERLESS === "1")
      return await (
        await import("./serverless-relay")
      ).serverlessStream(request);
    const backend = await getThreadBackend(request);
    const response = trackStreamPresence(
      request,
      await backend.host.stream(request),
      backend.presence,
    );
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return sessionResponse(error);
  }
};

export const frames = async (request: Request) => {
  try {
    if (process.env.TRESS_SERVERLESS === "1")
      return await (
        await import("./serverless-relay")
      ).serverlessFrames(request);
    return await (await getThreadBackend(request)).host.frames(request);
  } catch (error) {
    return sessionResponse(error);
  }
};
