"use client";

import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { StatewireClient, StatewireHttp } from "statewire";
import type { ThreadCommands, ThreadState } from "../lib/thread";
import { observeDemoConfig, type DemoConfig } from "../lib/demo-config";
import { describeWorkspace } from "../lib/workspace-info";
import { CopyButton } from "./CopyButton";
import { SourcePane } from "./SourcePane";
import { Markdown } from "./Markdown";
import { ModelBadge } from "./ModelBadge";
import { Badge } from "./terminal/Badge";
import { Spinner } from "./terminal/Spinner";
import { KeyboardShortcuts } from "./terminal/KeyboardShortcuts";
import { ToolCall } from "./terminal/ToolCall";
import { TerminalIcon } from "./terminal/TerminalIcon";

const EMPTY: ThreadState = {
  entries: [],
  status: "idle",
  files: {},
  runs: 0,
  clients: [],
};
const COMMANDS = [
  {
    name: "/help",
    description: "show available commands",
  },
  {
    name: "/files",
    description: "browse workspace files",
  },
  {
    name: "/pwd",
    description: "show the local workspace path",
  },
  {
    name: "/status",
    description: "connection, clients, workspace, and runs",
  },
  {
    name: "/attach",
    description: "connect your terminal",
  },
  {
    name: "/disconnect",
    description: "leave the host running",
  },
  {
    name: "/reconnect",
    description: "rejoin the live thread",
  },
  {
    name: "/clear",
    description: "clear the shared conversation",
  },
];
const TOOL_LABELS: Record<string, string> = {
  ls: "List workspace files",
  read: "Read file",
  write: "Write file",
  edit: "Edit file",
  bash: "Run shell command",
};
const SUGGESTIONS = [
  {
    label: "Fix the retry bug",
    prompt: "retry.js hammers the server on failure — fix it so the tests pass",
  },
  {
    label: "Explain this workspace",
    prompt:
      "Read retry.js and retry.test.js and explain what is wrong. Do not edit the files yet.",
  },
];
const LOCAL_SUGGESTIONS = [
  {
    label: "Make a disk edit",
    prompt:
      "Read notes.md and append a new bullet saying 'Local files work.' Then run cat notes.md to verify the file was saved. Leave the existing notes intact.",
  },
  {
    label: "Explore these files",
    prompt:
      "Read README.md and notes.md and briefly explain this local workspace. Do not edit any files.",
  },
];
type Client = StatewireClient<ThreadState | undefined, ThreadCommands>;

export function Thread({
  session: selectedSession,
  onReady,
  onActivity,
  toolbar,
  drafts,
}: {
  session?: string;
  onReady?: (config: DemoConfig) => void;
  onActivity?: (id: string, running: boolean, prompt?: string) => void;
  toolbar?: ReactNode;
  drafts?: Map<string, string>;
} = {}) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState("retry.js");
  const [showFiles, setShowFiles] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const promptInput = useRef<HTMLInputElement>(null);
  const commandMenu = useRef<HTMLDivElement>(null);
  const commandOptions = useRef<HTMLDivElement>(null);
  const commandListId = useId();
  const attachDetails = useRef<HTMLDetailsElement>(null);
  const [state, setState] = useState<ThreadState>(EMPTY);
  const [connection, setConnection] = useState("connecting");
  const [attached, setAttached] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ReactNode>("");
  const [origin, setOrigin] = useState("");
  const [config, setConfig] = useState<DemoConfig | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const [configLoading, setConfigLoading] = useState(true);
  const configRequest = useRef<ReturnType<typeof observeDemoConfig> | null>(
    null,
  );
  const workspaceInitialized = useRef(false);
  const pinnedConfigUrl = useRef<string | undefined>(undefined);
  const draft = useRef(input);
  draft.current = input;
  const log = useRef<HTMLDivElement>(null);
  const client = useRef<Client | null>(null);
  const submitting = useRef(false);
  const follow = useRef(true);
  const wasDetached = useRef(false);

  useEffect(() => {
    setOrigin(window.location.origin);
    const session =
      selectedSession ??
      new URL(window.location.href).searchParams.get("session");
    const request = observeDemoConfig(
      (result) => {
        setConfigLoading(result.status === "loading");
        if (result.status === "error") setConfigFailed(true);
        if (result.status === "ready") {
          setConfig(result.config);
          if (result.config.session)
            pinnedConfigUrl.current = `/api/mode?session=${encodeURIComponent(result.config.session.attachId)}`;
          onReady?.(result.config);
          setConfigFailed(false);
          if (
            !workspaceInitialized.current &&
            result.config.workspace?.localDemo
          ) {
            setShowFiles(true);
            setOpen("notes.md");
          }
          workspaceInitialized.current = true;
        }
      },
      (url, init) => fetch(pinnedConfigUrl.current ?? url, init),
      session
        ? `/api/mode?session=${encodeURIComponent(session)}`
        : "/api/mode",
    );
    configRequest.current = request;
    window.addEventListener("online", request.retryIfNeeded);
    window.addEventListener("focus", request.retryIfNeeded);
    return () => {
      window.removeEventListener("online", request.retryIfNeeded);
      window.removeEventListener("focus", request.retryIfNeeded);
      configRequest.current = null;
      request.dispose();
    };
  }, [selectedSession, onReady]);

  useEffect(() => {
    if (connection === "connected") void configRequest.current?.retry();
  }, [connection]);

  const clientUrl = config
    ? (config.session?.clientUrl ?? "/api/thread")
    : undefined;
  useEffect(() => {
    if (!attached || !clientUrl) return;
    setConnection("connecting");
    const current = new StatewireClient<
      ThreadState | undefined,
      ThreadCommands
    >({
      transport: StatewireHttp({ url: clientUrl }),
    });
    client.current = current;
    const sync = () => {
      if (current.state) setState(current.state);
      setConnection(current.connection.status);
      if (current.connection.status === "connected" && wasDetached.current) {
        setNotice("Reattached. You’re seeing the latest thread and files.");
        wasDetached.current = false;
      }
    };
    const unsubscribe = current.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
      client.current = null;
      current.dispose();
      submitting.current = false;
      setPending(false);
    };
  }, [attached, generation, clientUrl]);

  useEffect(() => {
    if (follow.current)
      log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [state.entries, notice, attached, showHelp]);

  useEffect(() => {
    const id = config?.session?.id;
    if (!id || !drafts) return;
    setInput(drafts.get(id) ?? "");
    return () => {
      drafts.set(id, draft.current);
    };
  }, [config?.session?.id, drafts]);

  const firstPrompt = state.entries.find(
    (entry) => entry.role === "user",
  )?.text;
  useEffect(() => {
    if (config?.session)
      onActivity?.(config.session.id, state.status === "running", firstPrompt);
  }, [config?.session?.id, state.status, firstPrompt, onActivity]);

  const demo = !config?.workspace || config.workspace.mode === "memory";
  const localDemo = config?.workspace?.localDemo === true;
  const workspace = state.workspace ?? config?.workspace;
  const workspaceDescription = workspace && describeWorkspace(workspace.mode);
  const suggestions =
    localDemo && config?.workspace?.writes
      ? LOCAL_SUGGESTIONS
      : demo
        ? SUGGESTIONS
        : [
            {
              label: "Explore this workspace",
              prompt:
                "List the workspace and explain its structure. Do not change any files.",
            },
          ];
  const connected =
    attached &&
    connection === "connected" &&
    (!state.harness || state.harness.connection === "connected");
  const running = state.status === "running";
  const clients = state.clients ?? [];
  const busy = running || pending;
  const canSend = connected && !busy && config?.configured === true;
  const attachCommand = `tress attach ${origin || "<this-host>"}${config?.session ? ` -s ${config.session.attachId}` : ""}`;
  const matches = COMMANDS.filter((command) =>
    command.name.startsWith(input.trim().toLowerCase()),
  );
  const menuOpen =
    inputFocused && !menuDismissed && input.trim().startsWith("/");
  const activeIndex = Math.min(commandIndex, matches.length - 1);
  const activeCommand = matches[activeIndex];

  useEffect(() => {
    if (menuOpen) commandMenu.current?.scrollIntoView({ block: "nearest" });
  }, [menuOpen]);

  useEffect(() => {
    const menu = commandOptions.current;
    const option = menu?.querySelector('[aria-selected="true"]');
    if (!menu || !option) return;
    if (activeIndex === 0) {
      menu.scrollTop = 0;
      return;
    }
    const bounds = menu.getBoundingClientRect();
    const selected = option.getBoundingClientRect();
    if (selected.top < bounds.top)
      menu.scrollTop += selected.top - bounds.top - 5;
    if (selected.bottom > bounds.bottom)
      menu.scrollTop += selected.bottom - bounds.bottom + 5;
  }, [menuOpen, activeIndex]);

  const invoke = useCallback(
    async (command: "send" | "reset", prompt?: string) => {
      const current = client.current;
      if (
        !current ||
        current.connection.status !== "connected" ||
        current.state?.status === "running" ||
        submitting.current
      )
        return;
      submitting.current = true;
      setPending(true);
      setError(null);
      setNotice("");
      follow.current = true;
      try {
        if (command === "send") {
          setInput("");
          await current.commands.send(prompt!.trim());
        } else {
          await current.commands.reset();
        }
      } catch (cause) {
        if (client.current === current) {
          setError(
            cause instanceof Error
              ? cause.message
              : "The command could not be sent. Reconnect and try again.",
          );
          if (command === "send") setInput(prompt ?? "");
        }
      } finally {
        if (client.current === current) {
          submitting.current = false;
          setPending(false);
        }
      }
    },
    [],
  );

  const toggleConnection = () => {
    if (attached) {
      wasDetached.current = true;
      setNotice("");
    }
    setError(null);
    follow.current = true;
    setAttached(!attached);
  };

  const connecting =
    attached && !connected && connection !== "stopped" &&
    state.harness?.connection !== "stopped";
  const status = !attached
    ? "Disconnected"
    : !connected
      ? connection === "stopped" || state.harness?.connection === "stopped"
        ? "Connection lost"
        : "Connecting…"
      : running
        ? "Agent working"
        : pending
          ? "Sending…"
          : state.harness
            ? "Cloud connected"
            : "Connected";

  const showWorkspaceInfo = () => {
    follow.current = true;
    if (workspace?.mode === "local" && workspace.root) {
      const root = workspace.root;
      setNotice(
        <>
          Local workspace on the host
          <div className="workspace-path-notice">
            <code>{root}</code>
            <CopyButton text={root} label="Copy local workspace path" />
          </div>
        </>,
      );
    } else {
      setNotice(
        workspace?.mode === "local"
          ? "The host has not provided its local workspace path."
          : workspaceDescription?.description ??
              "Waiting for workspace information. Reconnect and try /pwd again.",
      );
    }
  };

  const send = (prompt: string) => {
    const value = prompt.trim();
    if (!value) return;
    if (value.startsWith("/")) {
      setInput("");
      setNotice("");
      setError(null);
      follow.current = true;
      switch (value.toLowerCase()) {
        case "/":
        case "/help":
          setShowHelp(true);
          break;
        case "/files":
          setShowFiles((visible) => !visible);
          break;
        case "/pwd":
          showWorkspaceInfo();
          break;
        case "/attach":
          if (attachDetails.current) {
            attachDetails.current.open = true;
            attachDetails.current.scrollIntoView({ block: "nearest" });
          }
          break;
        case "/status": {
          const clientNoun = clients.length === 1 ? "client" : "clients";
          const clientList = clients
            .map((client) => `${client.label} [${client.id.slice(0, 6)}]`)
            .join(", ");
          setNotice(
            `${status}.${state.harness ? ` Thread: ${state.harness.threadId}.` : ""} ${state.runs} completed ${state.runs === 1 ? "run" : "runs"}. ${Object.keys(state.files).length} workspace files. ${clients.length} ${connected ? "connected" : "last known"} ${clientNoun}${clientList ? `: ${clientList}.` : "."}${!connected ? " Use /reconnect to sync." : ""}`,
          );
          break;
        }
        case "/clear":
          if (busy || !connected)
            setNotice(
              "Reconnect and wait for the current run before clearing the thread.",
            );
          else void invoke("reset");
          break;
        case "/disconnect":
          if (attached) toggleConnection();
          break;
        case "/reconnect":
          if (!attached) toggleConnection();
          else setGeneration((value) => value + 1);
          break;
        default:
          setNotice(`Unknown command: ${value}. Type /help for commands.`);
      }
      return;
    }
    if (canSend) void invoke("send", value);
  };

  return (
    <div className="playground">
      <div className="terminal-window">
        <div className="terminal-titlebar">
          {toolbar ?? (
            <div className="window-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          )}
          <span className="terminal-title">
            <span>tress{config?.session ? " ·" : ""}</span>
            {config?.session ? (
              <span className="terminal-session">
                <code title={config.session.attachId}>
                  {config.session.attachId}
                </code>
                <CopyButton
                  text={config.session.attachId}
                  label="Copy session ID"
                  compact
                />
              </span>
            ) : null}
          </span>
          <button
            type="button"
            className="files-toggle"
            aria-label={showFiles ? "Hide files" : "Show files"}
            aria-expanded={showFiles}
            aria-controls="workspace"
            onClick={() => setShowFiles((visible) => !visible)}
          >
            <TerminalIcon name="files" /> <span>files</span>
          </button>
        </div>

        <details className="terminal-attach" ref={attachDetails} open>
          <summary>attach your terminal</summary>
          <div className="attach-command">
            <span aria-hidden="true">$</span>
            <code>{attachCommand}</code>
            <CopyButton
              text={attachCommand}
              label="Copy terminal attach command"
              disabled={!origin || !config}
              compact
            />
          </div>
          <p>
            Same thread, live in both clients. Add <code>--ui</code> for the
            full terminal interface.
          </p>
        </details>

        <div className="workspace-summary">
          {workspaceDescription ? (
            <button
              type="button"
              className="workspace-indicator"
              title={workspaceDescription.description}
              aria-label={`${workspaceDescription.label} workspace: show details`}
              onClick={showWorkspaceInfo}
            >
              <Badge>{workspaceDescription.label}</Badge> <kbd>/pwd</kbd>
            </button>
          ) : (
            <Badge>workspace</Badge>
          )}
          <span className="connection-status" role="status">
            <Badge
              bordered={false}
              variant={connected ? "success" : "warning"}
            >
              {connecting || (connected && busy) ? <Spinner /> : (
                <span className="status-dot" aria-hidden="true" />
              )}
              {status.toLowerCase()}
            </Badge>
            {connected ? (
              <span className="client-count">
                {clients.length} {clients.length === 1 ? "client" : "clients"}
              </span>
            ) : null}
          </span>
        </div>

        <div
          className="conversation-log"
          ref={log}
          tabIndex={0}
          role="region"
          aria-label="Thread transcript"
          onScroll={() => {
            const element = log.current;
            if (element)
              follow.current =
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <
                60;
          }}
        >
          <div className="session-heading">
            <strong>tress</strong> <span>v0.1.0 · </span>
            <button
              type="button"
              onClick={() => setShowHelp((visible) => !visible)}
            >
              /help
            </button>
            <span> for commands</span>
          </div>
          {!config ? (
            <div className="empty-state">
              <Spinner label="Loading your workspace…" />
            </div>
          ) : state.entries.length === 0 ? (
            <div className="empty-state">
              {localDemo ? (
                <p>
                  Try editing{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setOpen("notes.md");
                      setShowFiles(true);
                    }}
                  >
                    notes.md
                  </button>
                  . Open this folder in your editor to follow along.
                </p>
              ) : demo ? (
                <p>
                  A shared workspace with a bug in{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setOpen("retry.js");
                      setShowFiles(true);
                    }}
                  >
                    retry.js
                  </button>
                  .
                </p>
              ) : (
                <p>
                  A shared {config?.workspace?.mode} workspace ·{" "}
                  {config?.workspace?.writes ? "editing enabled" : "read only"}.
                </p>
              )}
              <div className="suggestions">
                <span>try</span>
                {suggestions.map(({ label, prompt }) => (
                  <button
                    key={label}
                    type="button"
                    disabled={!canSend}
                    onClick={() => {
                      if (localDemo) {
                        setOpen("notes.md");
                        setShowFiles(true);
                      }
                      send(prompt);
                    }}
                  >
                    {label.toLowerCase()} <span aria-hidden="true">↗</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {state.entries.map((entry) => (
            <div
              key={entry.id}
              className={`entry entry-${entry.role}${entry.error ? " entry-error" : ""}`}
            >
              {entry.role === "user" ? (
                <div className="entry-prompt">
                  <span aria-hidden="true">❯</span>
                  <span>{entry.text}</span>
                </div>
              ) : (
                <>
                  {entry.tools.length > 0 ? (
                    <ToolCall
                      name={`${entry.tools.length} ${entry.tools.length === 1 ? "tool call" : "tool calls"}`}
                      isRunning={running && entry.id === state.entries.at(-1)?.id}
                    >
                      <ul>
                        {entry.tools.map((tool, index) => {
                          const [name, ...parts] = tool.split(" ");
                          const detail = parts.join(" ");
                          return (
                            <li key={index} title={tool}>
                              <span title={TOOL_LABELS[name] ?? name}>{name}</span>
                              {detail ? <code>{detail}</code> : null}
                            </li>
                          );
                        })}
                      </ul>
                    </ToolCall>
                  ) : null}
                  {entry.error ? (
                    <div className="entry-error-label">run failed</div>
                  ) : null}
                  {entry.text ? (
                    <Markdown text={entry.text} />
                  ) : running ? (
                    <Spinner label="Working…" />
                  ) : null}
                </>
              )}
            </div>
          ))}
          {showHelp ? (
            <div className="command-help" aria-label="Terminal commands">
              <div>
                <strong>Commands</strong>
                <button
                  type="button"
                  onClick={() => setShowHelp(false)}
                  aria-label="Close command help"
                >
                  ×
                </button>
              </div>
              <dl>
                {COMMANDS.map((command) => (
                  <Fragment key={command.name}>
                    <dt>{command.name}</dt>
                    <dd>{command.description}</dd>
                  </Fragment>
                ))}
              </dl>
            </div>
          ) : null}
          {notice ? (
            <div className="thread-notice" role="status">
              ↳ {notice}
            </div>
          ) : null}
          {!attached ? (
            <div className="disconnect-notice" role="status">
              Disconnected. The host keeps working.
              <br />
              Use /reconnect to pick up the thread.
            </div>
          ) : null}
        </div>

        {config?.configured === false ? (
          <div className="inline-error" role="status">
            Set ANTHROPIC_API_KEY in site/.env.local and restart to run the
            agent.
          </div>
        ) : null}
        {configFailed ? (
          <div className="inline-error" role="alert">
            Couldn’t load the model configuration. Retrying automatically.{" "}
            <button
              type="button"
              className="config-retry"
              disabled={configLoading}
              onClick={() => void configRequest.current?.retry()}
            >
              {configLoading ? "Retrying…" : "Retry now"}
            </button>
          </div>
        ) : null}
        {state.harness?.error ? (
          <div className="inline-error" role="alert">
            Managed Harness: {state.harness.error}
          </div>
        ) : null}
        {error ? (
          <div className="inline-error" role="alert">
            {error}
          </div>
        ) : null}

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            send(input);
          }}
        >
          {menuOpen ? (
            <div className="command-menu" ref={commandMenu}>
              <div className="command-menu-heading">
                <span id={`${commandListId}-label`}>Commands</span>
                <KeyboardShortcuts
                  shortcuts={[
                    { key: "↑↓", description: "select" },
                    { key: "↵", description: "run" },
                    { key: "esc", description: "close" },
                  ]}
                />
              </div>
              <div
                id={commandListId}
                ref={commandOptions}
                className="command-options"
                role="listbox"
                aria-labelledby={`${commandListId}-label`}
              >
                {matches.map((command, index) => (
                  <div
                    key={command.name}
                    id={`${commandListId}-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    className="command-option"
                    onPointerMove={() => setCommandIndex(index)}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => {
                      send(command.name);
                      promptInput.current?.focus();
                    }}
                  >
                    <span className="command-copy">
                      <span className="command-name">{command.name}</span>
                      <span className="command-description">
                        {command.description}
                      </span>
                    </span>
                    <span className="command-return" aria-hidden="true">
                      ↵
                    </span>
                  </div>
                ))}
              </div>
              {matches.length === 0 ? (
                <p className="command-empty" role="status">
                  No matching command. Type /help to see all commands.
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="composer-input">
            <span className="prompt-mark" aria-hidden="true">
              ❯
            </span>
            <input
              ref={promptInput}
              value={input}
              placeholder={
                !attached
                  ? "/reconnect to continue"
                  : running
                    ? "Working… /disconnect to leave the host running"
                    : "Ask anything… or / for commands"
              }
              onChange={(event) => {
                setInput(event.target.value);
                setCommandIndex(0);
                setMenuDismissed(false);
              }}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  setMenuDismissed(true);
                  setShowHelp(false);
                } else if (menuOpen && matches.length > 0) {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setCommandIndex(
                      (activeIndex +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        matches.length) %
                        matches.length,
                    );
                  } else if (event.key === "Tab" && !event.shiftKey) {
                    event.preventDefault();
                    setInput(activeCommand.name);
                    setCommandIndex(0);
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    send(activeCommand.name);
                  }
                }
              }}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? commandListId : undefined}
              aria-activedescendant={
                menuOpen && activeCommand
                  ? `${commandListId}-${activeIndex}`
                  : undefined
              }
              aria-label="Ask tress"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="submit"
              aria-label="Send prompt"
              disabled={
                !input.trim() || (!input.trim().startsWith("/") && !canSend)
              }
            >
              <TerminalIcon name="enter" />
            </button>
          </div>
          <div className="composer-hint">
            <ModelBadge model={config?.model} />
            <KeyboardShortcuts
              shortcuts={[
                { key: "/", description: "commands" },
                { key: "↵", description: "send" },
              ]}
            />
          </div>
        </form>

        {showFiles ? (
          <div id="workspace" className="workspace">
            <SourcePane files={state.files} open={open} onOpen={setOpen} />
          </div>
        ) : null}
      </div>

      <div className="session-controls">
        <div>
          <button type="button" onClick={toggleConnection}>
            {attached ? "disconnect" : "reconnect"}
          </button>
          <a
            href={config?.session?.browserUrl ?? "/"}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open the same thread in a second browser tab"
          >
            new tab ↗
          </a>
          {state.entries.length > 0 ? (
            <button
              type="button"
              disabled={busy || !connected}
              title={
                state.harness
                  ? "Start a new cloud thread; keep the previous conversation in Harness"
                  : demo
                    ? "Clear the conversation and restore example files"
                    : "Clear the conversation; keep workspace files"
              }
              onClick={() => void invoke("reset")}
            >
              {demo ? "reset" : "clear chat"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
