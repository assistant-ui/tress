import { threadHost } from "../../../../server/thread";

export const GET = (request: Request) => threadHost.stream(request);
export const POST = (request: Request) => threadHost.stream(request);
