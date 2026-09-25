import { threadListRequest } from "../../../../server/thread-list";
export const POST = (request: Request) => threadListRequest(request);
export const PATCH = (request: Request) => threadListRequest(request);
