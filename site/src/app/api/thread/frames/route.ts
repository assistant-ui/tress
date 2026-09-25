import { threadHost } from "../../../../server/thread";

export const POST = (request: Request) => threadHost.frames(request);
