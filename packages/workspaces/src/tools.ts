import { filePath, workspacePath } from "./paths.js";
import type {
  ToolCall,
  ToolDefinition,
  ToolResult,
  Workspace,
} from "./types.js";

export const WORKSPACE_TOOLS = ["read", "ls", "write", "edit", "bash"] as const;
export type WorkspaceToolName = (typeof WORKSPACE_TOOLS)[number];
export interface CustomTool extends ToolDefinition {
  /** Validate custom input here; input_schema describes it to the model. */
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}
export interface WorkspaceToolsOptions {
  /** Default: read and ls. Opt in to mutations and shell explicitly. */
  include?: readonly WorkspaceToolName[];
  custom?: readonly CustomTool[];
  /** Called before every exposed tool, including custom tools. False denies it. */
  authorize?: (call: ToolCall) => boolean | Promise<boolean>;
  maxOutputChars?: number;
  maxWriteChars?: number;
  /** Observers do not change tool results; errors go to onObserverError. */
  onToolResult?: (call: ToolCall, result: ToolResult) => void | Promise<void>;
  onObserverError?: (error: unknown) => void;
}

const schema = (
  name: string,
  description: string,
  fields: string[],
  required = fields,
): ToolDefinition => ({
  name,
  description,
  input_schema: {
    type: "object",
    properties: Object.fromEntries(
      fields.map((key) => [key, { type: "string" }]),
    ),
    required,
    additionalProperties: false,
  },
});
const definitions = [
  schema("read", "Read a UTF-8 file relative to the workspace root.", ["path"]),
  schema(
    "ls",
    "List a directory relative to the workspace root.",
    ["path"],
    [],
  ),
  schema("write", "Create or overwrite a UTF-8 file.", ["path", "content"]),
  schema(
    "edit",
    "Replace an exact string that occurs once. Include context to disambiguate.",
    ["path", "old", "new"],
  ),
  schema(
    "bash",
    "Run a command using the workspace's shell. Check its capabilities before choosing commands.",
    ["command"],
  ),
];
const errorResult = (error: unknown): ToolResult => ({
  content: error instanceof Error ? error.message : String(error),
  is_error: true,
});

export function createWorkspaceTools(
  workspace: Workspace,
  options: WorkspaceToolsOptions = {},
) {
  const include = options.include ?? ["read", "ls"];
  for (const name of include) {
    if (!(WORKSPACE_TOOLS as readonly string[]).includes(name))
      throw new Error(`Unknown workspace tool: ${name}`);
    if (name === "bash" && !workspace.exec)
      throw new Error("This workspace has no shell.");
  }
  const schemas = definitions.filter((tool) =>
    include.includes(tool.name as WorkspaceToolName),
  );
  const custom = new Map<string, CustomTool>();
  for (const tool of options.custom ?? []) {
    if (
      custom.has(tool.name) ||
      (WORKSPACE_TOOLS as readonly string[]).includes(tool.name)
    )
      throw new Error(`Duplicate or reserved tool name: ${tool.name}`);
    custom.set(tool.name, tool);
    schemas.push({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    });
  }
  const names = new Set(schemas.map((tool) => tool.name));
  const maxOutput = options.maxOutputChars ?? 30_000;
  const maxWrite = options.maxWriteChars ?? 1_048_576;
  if (
    !Number.isSafeInteger(maxOutput) ||
    maxOutput < 1 ||
    !Number.isSafeInteger(maxWrite) ||
    maxWrite < 1
  )
    throw new Error("Tool limits must be positive integers.");
  const string = (input: Record<string, unknown>, key: string): string => {
    if (typeof input[key] !== "string")
      throw new Error(`${key} must be a string.`);
    return input[key];
  };
  const write = async (path: string, content: string) => {
    if (content.length > maxWrite)
      throw new Error("File exceeds the write limit.");
    await workspace.writeFile(path, content);
    return { content: `Wrote ${path}`, is_error: false };
  };
  return {
    schemas,
    async execute(
      name: string,
      input: Record<string, unknown>,
    ): Promise<ToolResult> {
      let result: ToolResult;
      const call = { name, input };
      try {
        if (!names.has(name)) throw new Error(`Tool is not enabled: ${name}`);
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new Error("Tool input must be an object.");
        if (options.authorize && (await options.authorize(call)) !== true)
          throw new Error("The host denied this tool call.");
        const tool = custom.get(name);
        if (tool) result = await tool.execute(input);
        else
          switch (name) {
            case "read":
              result = {
                content: await workspace.readFile(
                  filePath(string(input, "path")),
                ),
                is_error: false,
              };
              break;
            case "ls":
              result = {
                content:
                  (
                    await workspace.listFiles(
                      workspacePath(
                        input.path === undefined ? "" : string(input, "path"),
                      ),
                    )
                  )
                    .map(
                      (file) =>
                        `${file.name}${file.type === "directory" ? "/" : ""}`,
                    )
                    .join("\n") || "(empty directory)",
                is_error: false,
              };
              break;
            case "write":
              result = await write(
                filePath(string(input, "path")),
                string(input, "content"),
              );
              break;
            case "edit": {
              const path = filePath(string(input, "path"));
              const old = string(input, "old");
              const replacement = string(input, "new");
              if (!old) throw new Error("old must not be empty.");
              const content = await workspace.readFile(path);
              const first = content.indexOf(old);
              if (first < 0 || content.indexOf(old, first + 1) >= 0)
                throw new Error(
                  "old must occur exactly once; include more context.",
                );
              result = await write(
                path,
                content.slice(0, first) +
                  replacement +
                  content.slice(first + old.length),
              );
              break;
            }
            case "bash": {
              const command = string(input, "command");
              if (!command.trim())
                throw new Error("command must not be empty.");
              const output = await workspace.exec!(command);
              result = {
                content: `${output.stdout}${output.stderr ? `\n[stderr]\n${output.stderr}` : ""}\n[exit ${output.exitCode}]`,
                is_error: output.exitCode !== 0,
              };
              break;
            }
            default:
              throw new Error(`Unknown tool: ${name}`);
          }
        if (
          typeof result?.content !== "string" ||
          typeof result?.is_error !== "boolean"
        )
          throw new Error("Invalid custom tool result.");
      } catch (error) {
        result = errorResult(error);
      }
      if (result.content.length > maxOutput)
        result = {
          ...result,
          content: result.content.slice(0, maxOutput) + "\n[output truncated]",
        };
      try {
        await options.onToolResult?.(call, result);
      } catch (error) {
        try {
          options.onObserverError?.(error);
        } catch {
          /* Observer failures must not suggest retrying a completed write. */
        }
      }
      return result;
    },
  };
}
