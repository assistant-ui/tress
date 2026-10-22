import { Harness } from "harness-sdk";
import { StatewireHttp } from "statewire";
const token = location.hash.slice(1);
const $ = (id) => document.getElementById(id);
const authenticatedFetch = (url, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
};
const report = (error) => {
  $("error").textContent = error.message;
};
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
async function start() {
  const info = await authenticatedFetch("/api/info");
  if (!info.ok)
    throw new Error("Open the private workspace URL printed by Tress.");
  const workspace = await info.json();
  $("workspace").textContent =
    `${workspace.root} · ${workspace.mode === "managed" ? "Managed Harness" : "Harness on this machine"} · ${workspace.allowWrite ? "File edits enabled" : "Read only"}${workspace.allowExec ? " · Native shell enabled" : ""}`;
  $("attach").textContent =
    `tress attach ${location.origin}/api/threads/main --headers-file ${quote(workspace.headersFile)}`;
  const harness = new Harness({
    transport: StatewireHttp({
      url: `${location.origin}/api/threads/main`,
      fetch: authenticatedFetch,
    }),
  });
  function render() {
    $("status").textContent = harness.isBusy
      ? "Working"
      : harness.isLoading
        ? "Connecting…"
        : "Ready";
    $("error").textContent =
      harness.error?.message ?? harness.transport.error?.message ?? "";
    $("messages").replaceChildren(
      ...harness.messages.map((message) => {
        const article = document.createElement("article");
        const name = document.createElement("strong");
        name.textContent = message.role === "user" ? "You" : "Tress";
        const text = document.createElement("pre");
        text.textContent = message.parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("");
        article.append(name, text);
        return article;
      }),
    );
  }
  harness.subscribe(render);
  render();
  $("composer").onsubmit = async (event) => {
    event.preventDefault();
    const prompt = $("prompt").value;
    try {
      await harness.sendMessage(prompt);
      $("prompt").value = "";
    } catch (error) {
      $("error").textContent = error.message;
    }
  };
  async function files(path = "") {
    const response = await authenticatedFetch(
      `/api/files?path=${encodeURIComponent(path)}`,
    );
    if (!response.ok) throw new Error("Could not load files");
    const entries = await response.json();
    $("files").replaceChildren();
    if (path) {
      const back = document.createElement("button");
      back.textContent = "← Parent folder";
      back.onclick = () =>
        files(path.split("/").slice(0, -1).join("/")).catch(report);
      $("files").append(back);
    }
    for (const entry of entries) {
      const button = document.createElement("button");
      button.textContent = entry.name + (entry.type === "directory" ? "/" : "");
      button.onclick = () =>
        (async () => {
          const target = [path, entry.name].filter(Boolean).join("/");
          if (entry.type === "directory") return files(target);
          const response = await authenticatedFetch(
            `/api/file?path=${encodeURIComponent(target)}`,
          );
          if (!response.ok) {
            $("error").textContent = "File unavailable";
            return;
          }
          const url = URL.createObjectURL(await response.blob());
          const a = document.createElement("a");
          a.href = url;
          a.download = entry.name;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        })().catch(report);
      $("files").append(button);
    }
  }
  $("refresh").onclick = () => files().catch(report);
}
start().catch((error) => {
  report(error);
  $("status").textContent = "Connection failed";
});
