import { threadMode } from "../../../server/config";

/** Tells the page which thread backend is in use. */
export const GET = () => Response.json(threadMode());
