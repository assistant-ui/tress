/** The state shared by the browser, terminal, and thread host. */
export type Entry = {
  id: string;
  role: "user" | "agent";
  text: string;
  tools: string[];
  error?: boolean;
};

export type ThreadState = {
  entries: Entry[];
  status: "idle" | "running";
  files: Record<string, string>;
  runs: number;
  clients: {
    id: string;
    kind: "browser" | "terminal" | "api";
    label: string;
  }[];
  harness?: {
    threadId: string;
    origin: string;
    workspaceId: string;
    connection: string;
    error?: string;
  };
};

export type ThreadCommands = {
  send: (prompt: string) => Promise<unknown>;
  reset: () => Promise<unknown>;
};
