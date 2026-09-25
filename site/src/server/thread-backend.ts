import { threadMode } from "./config";
import { managedGateway } from "./managed";

export const getThreadHost = async (request: Request) => {
  return (await getThreadBackend(request)).host;
};

export const getThreadBackend = async (request: Request) => {
  const mode = threadMode(request.url);
  if (mode.kind === "cloud") return managedGateway(mode);
  return (await import("./thread")).threadBackend;
};
