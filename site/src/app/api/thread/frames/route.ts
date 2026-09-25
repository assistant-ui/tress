import { getThreadHost } from "../../../../server/thread-backend";

export const POST = async (request: Request) =>
  (await getThreadHost(request)).frames(request);
