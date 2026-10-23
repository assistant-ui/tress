import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createUIMessageStream } from "ai";
import { AISDKTransport } from "@harness-sdk/ai-sdk";
import { Harness } from "harness-sdk";
import { HARNESS_HOST_PROTOCOL } from "harness-sdk/host";
import { StatewireHttp } from "statewire";
import { statewireHost } from "statewire-node";

const binary = process.env.TRESS_BIN
  ? resolve(process.env.TRESS_BIN)
  : fileURLToPath(new URL("../../target/debug/tress", import.meta.url));
async function until(predicate, label) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

test(
  "native terminal joins an existing authorized Harness host without a Tress browser or server adapter",
  { timeout: 30_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "tress-direct-app-"));
    let host, server, browser;
    const terminals = [];
    t.after(async () => {
      for (const child of terminals)
        if (child.exitCode === null) child.kill("SIGTERM");
      browser?.dispose();
      await host?.close();
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
      }
      await rm(directory, { recursive: true, force: true });
    });
    let runs = 0;
    const agentInputs = [];
    const hostErrors = [];
    // This transport belongs to the application before a terminal attaches.
    // There is no Tress JS import, Tress agent, browser component, or access wrapper.
    const transport = {
      async sendMessages({ messages }) {
        runs++;
        agentInputs.push(messages);
        const prompt = messages
          .at(-1)
          .parts.filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        return createUIMessageStream({
          execute: async ({ writer }) => {
            writer.write({ type: "start", messageId: `app-reply-${runs}` });
            writer.write({ type: "text-start", id: "reply" });
            writer.write({
              type: "text-delta",
              id: "reply",
              delta: `Existing app agent: ${prompt}`,
            });
            writer.write({ type: "text-end", id: "reply" });
            writer.write({ type: "finish", finishReason: "stop" });
          },
        });
      },
      async reconnectToStream() {
        return null;
      },
    };
    host = statewireHost({
      key: ["existing"],
      protocol: HARNESS_HOST_PROTOCOL,
      onError: (error) => hostErrors.push(error),
      storage: {
        async load() {
          try {
            return JSON.parse(
              await readFile(join(directory, "thread.json"), "utf8"),
            );
          } catch (error) {
            if (error.code === "ENOENT") return undefined;
            throw error;
          }
        },
        save: (snapshot) =>
          writeFile(join(directory, "thread.json"), JSON.stringify(snapshot)),
      },
      transport: (restored) =>
        AISDKTransport({
          threadId: "existing",
          transport,
          ...(restored ? { initialState: restored } : {}),
        }),
    });
    let origin;
    server = createServer(async (incoming, outgoing) => {
      try {
        const url = new URL(incoming.url, origin);
        if (
          ![
            "/api/threads/existing/stream",
            "/api/threads/existing/frames",
          ].includes(url.pathname)
        ) {
          outgoing.writeHead(404).end();
          return;
        }
        // The application's normal request authorization protects every route.
        const allowed =
          incoming.headers.cookie === "app_session=fixture-browser" ||
          incoming.headers.authorization === "Bearer fixture-terminal";
        if (!allowed) {
          outgoing.writeHead(401).end("Application credential required");
          return;
        }
        const abort = new AbortController();
        outgoing.on("close", () => abort.abort());
        const request = new Request(url, {
          method: incoming.method,
          headers: incoming.headers,
          signal: abort.signal,
          ...(!["GET", "HEAD"].includes(incoming.method) && {
            body: Readable.toWeb(incoming),
            duplex: "half",
          }),
        });
        const response = await host.fetch(request);
        outgoing.writeHead(
          response.status,
          Object.fromEntries(response.headers),
        );
        if (response.body)
          Readable.fromWeb(response.body)
            .on("error", () => outgoing.destroy())
            .pipe(outgoing);
        else outgoing.end();
      } catch (error) {
        if (!outgoing.headersSent) outgoing.writeHead(500);
        outgoing.end(String(error));
      }
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${server.address().port}`;
    const endpoint = `${origin}/api/threads/existing`;
    browser = new Harness({
      transport: StatewireHttp({
        url: endpoint,
        fetch: (url, init = {}) => {
          const headers = new Headers(init.headers);
          headers.set("Cookie", "app_session=fixture-browser");
          return fetch(url, { ...init, headers });
        },
      }),
    });
    const transcript = () => JSON.stringify(browser.messages);
    await until(
      () => browser.transport.status === "connected",
      "existing browser connected",
    );
    await browser.sendMessage("browser history before terminal");
    await until(
      () =>
        !browser.isBusy &&
        transcript().includes(
          "Existing app agent: browser history before terminal",
        ),
      "browser history",
    );
    const headersFile = join(directory, "headers.json");
    await writeFile(
      headersFile,
      JSON.stringify({ Authorization: "Bearer fixture-terminal" }),
      { mode: 0o600 },
    );
    const terminal = (file, prompt) => {
      const child = spawn(
        binary,
        prompt
          ? ["ask", "--host", endpoint, "--headers-file", file, prompt]
          : ["attach", endpoint, "--headers-file", file],
        {
          env: { ...process.env, XDG_CONFIG_HOME: directory, NO_COLOR: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      terminals.push(child);
      return { child, output: () => output, exited: once(child, "exit") };
    };
    const attached = terminal(headersFile);
    await until(
      () =>
        attached
          .output()
          .includes("Existing app agent: browser history before terminal"),
      "terminal loads original history",
    );
    attached.child.stdin.write("from the native terminal\n");
    await until(
      () =>
        !browser.isBusy &&
        transcript().includes("Existing app agent: from the native terminal") &&
        attached
          .output()
          .includes("Existing app agent: from the native terminal"),
      "same agent reply in both clients",
    );
    assert.equal(runs, 2);
    assert.match(
      JSON.stringify(agentInputs[1]),
      /browser history before terminal/,
    );
    await browser.sendMessage("browser after terminal joined");
    await until(
      () =>
        !browser.isBusy &&
        attached
          .output()
          .includes("Existing app agent: browser after terminal joined"),
      "browser reply reaches native client",
    );
    assert.equal(runs, 3);
    attached.child.stdin.write("/exit\n");
    assert.equal((await attached.exited)[0], 0);
    const wrongFile = join(directory, "wrong.json");
    await writeFile(
      wrongFile,
      JSON.stringify({ Authorization: "Bearer wrong-app-credential" }),
      { mode: 0o600 },
    );
    const denied = terminal(wrongFile, "must not execute");
    assert.equal((await denied.exited)[0], 1);
    assert.doesNotMatch(denied.output(), /Existing app agent:/);
    assert.equal(runs, 3);
    await browser.sendMessage("browser continues after rejected terminal");
    await until(
      () =>
        !browser.isBusy &&
        transcript().includes(
          "Existing app agent: browser continues after rejected terminal",
        ),
      "original browser remains connected",
    );
    assert.equal(runs, 4);
    assert.deepEqual(hostErrors, []);
  },
);
