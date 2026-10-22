"use client";
import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createTressClient,
  type TressClient,
  type TressConnectionOptions,
  type TressMessage,
} from "./index.js";
import { Markdown } from "./generated/Markdown";
import { CopyButton } from "./generated/CopyButton";
import { TressWordmark } from "./generated/TressWordmark";
import { Badge } from "./generated/terminal/Badge";
import { Spinner } from "./generated/terminal/Spinner";
import { ToolCall } from "./generated/terminal/ToolCall";
import { TerminalIcon } from "./generated/terminal/TerminalIcon";
import { KeyboardShortcuts } from "./generated/terminal/KeyboardShortcuts";
import { FilesPane } from "./workspace.js";
export type { TressWorkspace } from "./workspace.js";
import type { TressWorkspace } from "./workspace.js";

export interface TressThreadProps {
  /** Reuse your existing Harness instance, or supply url to create a client. */
  client?: TressClient;
  url?: string;
  headers?: TressConnectionOptions["headers"];
  fetch?: TressConnectionOptions["fetch"];
  title?: string;
  model?: string;
  /** Safe command supplied by the app. Credentials belong in a private file. */
  attachCommand?: string;
  workspace?: TressWorkspace;
  toolbar?: ReactNode;
  className?: string;
}
interface Snapshot {
  messages: readonly TressMessage[];
  busy: boolean;
  loading: boolean;
  connected: boolean;
  error?: string;
}
const EMPTY: Snapshot = {
  messages: [],
  busy: false,
  loading: true,
  connected: false,
};
const COMMANDS = [
  { name: "/help", description: "show available commands" },
  { name: "/files", description: "browse host workspace files" },
  { name: "/pwd", description: "show workspace details" },
  { name: "/status", description: "show connection status" },
  { name: "/attach", description: "connect your terminal" },
];

/** A client-only view; mounting it never creates an agent or moves workspace files. */
export function TressThread({
  client: supplied,
  url,
  headers,
  fetch: fetcher,
  title,
  model,
  attachCommand,
  workspace,
  toolbar,
  className = "",
}: TressThreadProps) {
  const [owned, setOwned] = useState<TressClient>();
  const [connectionError, setConnectionError] = useState("");
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (supplied) {
      setConnectionError("");
      return;
    }
    if (!url) {
      setConnectionError("Provide your Harness client or thread endpoint.");
      return;
    }
    setConnectionError("");
    try {
      const current = createTressClient({ url, headers, fetch: fetcher });
      setOwned(current);
      return () => {
        current.dispose();
        setOwned(undefined);
      };
    } catch (error) {
      setConnectionError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }, [supplied, url, headers, fetcher, generation]);
  const client = supplied ?? owned;
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  useEffect(() => {
    if (!client) {
      setSnapshot(EMPTY);
      return;
    }
    const sync = () =>
      setSnapshot({
        messages: client.messages,
        busy: client.isBusy,
        loading: client.isLoading,
        connected: client.transport.status === "connected",
        error: client.error?.message ?? client.transport.error?.message,
      });
    const unsubscribe = client.subscribe(sync);
    sync();
    return unsubscribe;
  }, [client]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<ReactNode>();
  const [showFiles, setShowFiles] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const attachRef = useRef<HTMLDetailsElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const submitting = useRef(false);
  const identity = useId();
  const busy = snapshot.busy || pending;
  const canSend = snapshot.connected && !busy;
  const commands = COMMANDS.filter(
    (command) =>
      (workspace || !["/files", "/pwd"].includes(command.name)) &&
      (attachCommand || command.name !== "/attach"),
  );
  const matches = commands.filter((command) =>
    command.name.startsWith(input.trim().toLowerCase()),
  );
  const selected = Math.min(active, Math.max(0, matches.length - 1));
  const menu = focused && !dismissed && input.trim().startsWith("/");
  const status = snapshot.connected
    ? busy
      ? "agent working"
      : "connected"
    : snapshot.loading && !connectionError
      ? "connecting…"
      : "disconnected";
  useEffect(() => {
    if (following.current)
      log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [snapshot.messages, notice, showHelp]);

  async function send(value: string) {
    const prompt = value.trim();
    if (!prompt) return;
    setError("");
    setNotice(undefined);
    following.current = true;
    if (prompt.startsWith("/")) {
      setInput("");
      if (prompt === "/help" || prompt === "/") setShowHelp(true);
      else if (prompt === "/files" && workspace)
        setShowFiles((value) => !value);
      else if (prompt === "/pwd" && workspace)
        setNotice(workspace.description ?? workspace.label);
      else if (prompt === "/status")
        setNotice(
          `Browser client · ${status}. Conversation and execution belong to the host.`,
        );
      else if (prompt === "/attach" && attachRef.current) {
        attachRef.current.open = true;
        attachRef.current.scrollIntoView({ block: "nearest" });
      } else
        setNotice(
          `Command unavailable. Type /help to see this host's available controls.`,
        );
      return;
    }
    if (!client || !canSend || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setInput("");
    try {
      await client.sendMessage(prompt);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      setInput(prompt);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  const failure = error || connectionError || snapshot.error;
  return (
    <div className={`tress-ui ${className}`}>
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
              <TressWordmark />
              {title ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="terminal-session" title={title}>
                    {title}
                  </span>
                </>
              ) : null}
            </span>
            {workspace ? (
              <button
                type="button"
                className="files-toggle"
                aria-label={showFiles ? "Hide files" : "Show files"}
                aria-expanded={showFiles}
                aria-controls={`${identity}-files`}
                onClick={() => setShowFiles(!showFiles)}
              >
                <TerminalIcon name="files" />
                <span>files</span>
              </button>
            ) : (
              <span />
            )}
          </div>
          {attachCommand ? (
            <details className="terminal-attach" ref={attachRef} open>
              <summary>attach your terminal</summary>
              <div className="attach-command">
                <span aria-hidden="true">$</span>
                <code>{attachCommand}</code>
                <CopyButton
                  text={attachCommand}
                  label="Copy terminal attach command"
                  compact
                />
              </div>
              <p>
                Same thread, live in both clients. Add <code>--ui</code> for the
                full terminal interface.
              </p>
            </details>
          ) : null}
          <div className="workspace-summary">
            {workspace ? (
              <button
                type="button"
                className="workspace-indicator"
                title={workspace.description}
                onClick={() =>
                  setNotice(workspace.description ?? workspace.label)
                }
              >
                <Badge>{workspace.label}</Badge>
                <kbd>/pwd</kbd>
              </button>
            ) : (
              <span className="workspace-unconnected">
                Host-owned conversation
              </span>
            )}
            <span className="connection-status" role="status">
              <Badge
                bordered={false}
                variant={snapshot.connected ? "success" : "warning"}
              >
                {busy || (snapshot.loading && !failure) ? (
                  <Spinner />
                ) : (
                  <span className="status-dot" aria-hidden="true" />
                )}
                {status}
              </Badge>
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
                following.current =
                  element.scrollHeight -
                    element.scrollTop -
                    element.clientHeight <
                  60;
            }}
          >
            <div className="session-heading">
              <strong>tress</strong>
              <span> · </span>
              <button type="button" onClick={() => setShowHelp(!showHelp)}>
                /help
              </button>
              <span> for commands</span>
            </div>
            {snapshot.messages.length === 0 ? (
              <div className="empty-state">
                {snapshot.loading && !failure ? (
                  <Spinner label="Connecting to your thread…" />
                ) : (
                  <>
                    <p>
                      {workspace
                        ? "Your host workspace is available. Browse the files or ask Tress to explore the project."
                        : "Continue your conversation here. Your agent and tools stay on the host."}
                    </p>
                    {workspace ? (
                      <div className="suggestions">
                        <span>try</span>
                        <button
                          type="button"
                          disabled={!canSend}
                          onClick={() =>
                            void send(
                              "List the workspace and explain its structure. Do not change any files.",
                            )
                          }
                        >
                          explore workspace <span aria-hidden="true">↗</span>
                        </button>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
            {snapshot.messages.map((message) => {
              const text = message.parts
                .filter((part) => part.type === "text")
                .map((part) => part.text ?? "")
                .join("");
              const tools = message.parts.filter(
                (part) =>
                  part.type === "dynamic-tool" || part.type.startsWith("tool-"),
              );
              return (
                <div
                  key={message.id}
                  className={`entry entry-${message.role === "user" ? "user" : "assistant"}`}
                >
                  {message.role === "user" ? (
                    <div className="entry-prompt">
                      <span aria-hidden="true">❯</span>
                      <span>{text}</span>
                    </div>
                  ) : (
                    <>
                      {tools.length ? (
                        <ToolCall
                          name={`${tools.length} ${tools.length === 1 ? "tool call" : "tool calls"}`}
                          isRunning={
                            snapshot.busy &&
                            message.id === snapshot.messages.at(-1)?.id
                          }
                        >
                          <ul>
                            {tools.map((part, index) => (
                              <li key={part.toolCallId ?? index}>
                                <span>
                                  {part.toolName ?? part.type.slice(5)}
                                </span>
                                <code>
                                  {part.errorText ??
                                    (part.input &&
                                    typeof part.input === "object" &&
                                    "summary" in part.input
                                      ? String(part.input.summary)
                                      : "")}
                                </code>
                              </li>
                            ))}
                          </ul>
                        </ToolCall>
                      ) : null}
                      {text ? (
                        <Markdown text={text} />
                      ) : snapshot.busy &&
                        message.id === snapshot.messages.at(-1)?.id ? (
                        <Spinner label="Working…" />
                      ) : null}
                    </>
                  )}
                </div>
              );
            })}
            {showHelp ? (
              <div className="command-help" aria-label="Terminal commands">
                <div>
                  <strong>Commands</strong>
                  <button
                    type="button"
                    aria-label="Close command help"
                    onClick={() => setShowHelp(false)}
                  >
                    ×
                  </button>
                </div>
                <dl>
                  {commands.map((command) => (
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
          </div>
          {failure ? (
            <div className="inline-error" role="alert">
              {failure}
              {!supplied ? (
                <button
                  type="button"
                  className="config-retry"
                  onClick={() => setGeneration((value) => value + 1)}
                >
                  Reconnect
                </button>
              ) : null}
            </div>
          ) : null}
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send(input);
            }}
          >
            {menu ? (
              <div className="command-menu">
                <div className="command-menu-heading">
                  <span id={`${identity}-label`}>Commands</span>
                  <KeyboardShortcuts
                    shortcuts={[
                      { key: "↑↓", description: "select" },
                      { key: "↵", description: "run" },
                      { key: "esc", description: "close" },
                    ]}
                  />
                </div>
                <div
                  className="command-options"
                  id={`${identity}-commands`}
                  role="listbox"
                  aria-labelledby={`${identity}-label`}
                >
                  {matches.map((command, index) => (
                    <div
                      key={command.name}
                      id={`${identity}-command-${index}`}
                      className="command-option"
                      role="option"
                      aria-selected={index === selected}
                      onPointerMove={() => setActive(index)}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => {
                        void send(command.name);
                        inputRef.current?.focus();
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
                {!matches.length ? (
                  <p className="command-empty">No matching command.</p>
                ) : null}
              </div>
            ) : null}
            <div className="composer-input">
              <span className="prompt-mark" aria-hidden="true">
                ❯
              </span>
              <input
                ref={inputRef}
                value={input}
                placeholder={
                  busy
                    ? "Working… you can leave the host running"
                    : "Ask anything… or / for commands"
                }
                onChange={(event) => {
                  setInput(event.target.value);
                  setActive(0);
                  setDismissed(false);
                }}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) {
                    if (event.key === "Enter") event.preventDefault();
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setDismissed(true);
                    setShowHelp(false);
                  } else if (menu && matches.length) {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      setActive(
                        (selected +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          matches.length) %
                          matches.length,
                      );
                    } else if (event.key === "Tab" && !event.shiftKey) {
                      event.preventDefault();
                      setInput(matches[selected].name);
                      setActive(0);
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      void send(matches[selected].name);
                    }
                  }
                }}
                role="combobox"
                aria-label="Ask tress"
                aria-autocomplete="list"
                aria-expanded={menu}
                aria-controls={menu ? `${identity}-commands` : undefined}
                aria-activedescendant={
                  menu && matches.length
                    ? `${identity}-command-${selected}`
                    : undefined
                }
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
              <span>{model ?? "host model"}</span>
              <KeyboardShortcuts
                shortcuts={[
                  { key: "/", description: "commands" },
                  { key: "↵", description: "send" },
                ]}
              />
            </div>
          </form>
          {showFiles && workspace ? (
            <div id={`${identity}-files`} className="workspace">
              <div className="workspace-capabilities">
                <span>{workspace.writable ? "Read + edit" : "Read only"}</span>
                <span>
                  {workspace.shell ? "Host shell available" : "No shell access"}
                </span>
                <span>Files stay on the host</span>
              </div>
              <FilesPane
                workspace={workspace}
                onAsk={(prompt) => {
                  setInput(prompt);
                  inputRef.current?.focus();
                }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
