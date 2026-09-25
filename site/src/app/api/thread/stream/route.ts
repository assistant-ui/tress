import { trackStreamPresence } from "../../../../server/presence";
import { getThreadBackend } from "../../../../server/thread-backend";

const stream = async (request: Request) => {
  const backend = await getThreadBackend(request);
  return trackStreamPresence(
    request,
    await backend.host.stream(request),
    backend.presence,
  );
};

export const GET = stream;
export const POST = GET;
