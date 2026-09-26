import { threadListRequest } from "../../../server/thread-list";
export const GET = (request: Request) => threadListRequest(request);
export const POST = (request: Request) => threadListRequest(request);
