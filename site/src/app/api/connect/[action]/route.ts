import { connectRequest } from "../../../../server/connect-api";

const handle = (request: Request) =>
  connectRequest(
    request,
    new URL(request.url).pathname.match(/^\/api\/connect\/([^/]+)$/)?.[1] ?? "",
  );

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
