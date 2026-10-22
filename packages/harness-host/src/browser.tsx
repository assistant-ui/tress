import React from "react";
import { createRoot } from "react-dom/client";
import { TressThread, type TressWorkspace } from "@tress/client/react";

const token = location.hash.slice(1);
const headers = { Authorization: `Bearer ${token}` };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function request(path: string, signal?: AbortSignal) {
  const response = await fetch(path, { headers, signal, redirect: "error" });
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "Open the private workspace URL printed by Tress."
        : `Host request failed (${response.status}).`,
    );
  return response;
}
const root = createRoot(document.getElementById("root")!);
root.render(
  <main className="host-page">
    <TressThread url="/api/threads/main" headers={headers} />
  </main>,
);
try {
  const info = await (await request("/api/info")).json();
  const workspace: TressWorkspace = {
    label: info.mode === "managed" ? "managed" : "local",
    description: info.root,
    writable: info.allowWrite,
    shell: info.allowExec,
    list: async (path, signal) =>
      (
        await request(`/api/files?path=${encodeURIComponent(path)}`, signal)
      ).json(),
    read: async (path, signal) =>
      (
        await request(`/api/file?path=${encodeURIComponent(path)}`, signal)
      ).blob(),
  };
  root.render(
    <main className="host-page">
      <TressThread
        url="/api/threads/main"
        headers={headers}
        workspace={workspace}
        title={info.root.split(/[\\/]/).at(-1)}
        model={info.model}
        attachCommand={`tress attach ${location.origin}/api/threads/main --headers-file ${quote(info.headersFile)}`}
      />
    </main>,
  );
} catch (error) {
  root.render(
    <main className="host-page tress-ui">
      <div className="terminal-window">
        <div className="inline-error" role="alert">
          {error instanceof Error ? error.message : String(error)}
        </div>
      </div>
    </main>,
  );
}
