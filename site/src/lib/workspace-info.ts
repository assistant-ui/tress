const WORKSPACES: Record<string, { label: string; description: string }> = {
  local: {
    label: "local",
    description: "Files are saved on the host. Use /pwd to see the folder.",
  },
  vercel: {
    label: "sandbox",
    description: "Files live in a remote sandbox, not on this host.",
  },
  memory: {
    label: "memory",
    description: "Virtual files in memory; there is no local disk path.",
  },
  overlay: {
    label: "overlay",
    description: "Reads local files; edits stay in memory. There is no writable local folder.",
  },
};

export const describeWorkspace = (mode: string) =>
  WORKSPACES[mode] ?? {
    label: mode,
    description: "This workspace does not expose a local disk path.",
  };
