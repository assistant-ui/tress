import { workspaceConfig } from "../../../server/workspace";
import { threadMode } from "../../../server/config";
import { managedGateway } from "../../../server/managed";

/** Tells the page which thread backend is in use. */
export const GET = async (request: Request) => {
  const workspace = workspaceConfig();
  const mode = threadMode(request.url);
  return Response.json({
    ...mode,
    ...(mode.kind === "cloud"
      ? { harness: (await managedGateway(mode)).info() }
      : {}),
    workspace: {
      mode: workspace.mode,
      writes: workspace.writes,
      localDemo: workspace.localDemo,
      ...(workspace.localDemo
        ? { root: process.env.TRESS_WORKSPACE_ROOT }
        : {}),
    },
    configured: Boolean(process.env.ANTHROPIC_API_KEY),
    model: process.env.TRESS_MODEL ?? "claude-sonnet-5",
  });
};
