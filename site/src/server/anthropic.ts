/** Server-owned authentication for both workspace keys and personal keys. */
export const anthropicHeaders = (key: string): Record<string, string> => {
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID?.trim();
  return {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    ...(workspace ? { "anthropic-workspace-id": workspace } : {}),
  };
};
