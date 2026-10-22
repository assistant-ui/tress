const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get("session");
const endpoint = `/api/sessions/${encodeURIComponent(token || "")}`;
const version = "2026-09-13";
let lease,
  sequence = 0,
  connected = false,
  state = {},
  directory = "",
  selected = "",
  imageUrl;
let fileRequest = 0,
  renderSignature = "",
  pendingApproval;
const pending = new Map();

function error(message, id = "error") {
  $(id).textContent = message;
  $(id).hidden = !message;
}
function url(path, params = {}) {
  return `${path}?${new URLSearchParams({ session: token, ...params })}`;
}
async function json(path) {
  const response = await fetch(path, { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      data.error ||
        `Request failed (${response.status}). Open the private URL printed by the host.`,
    );
  return data;
}
function controls() {
  $("send").disabled =
    !connected || state.status === "running" || Boolean(state.storageError);
  $("clear").disabled = $("send").disabled;
  $("activity").textContent =
    state.storageError ||
    (!connected
      ? "Host disconnected · your draft is kept here"
      : state.approval
        ? "Waiting for your approval"
        : state.status === "running"
          ? "Working on the host…"
          : "Saved on the host · Enter to send · Shift+Enter for a new line");
}
function render(value) {
  const previousRuns = state.runs;
  state = value;
  controls();
  $("workspace").textContent =
    `${state.workspace?.root || "Workspace"} · ${state.workspace?.writable ? "file edits enabled" : "read-only file tools"} · ${state.workspace?.shell ? "shell with approval" : "shell disabled"}`;
  if (state.storageError) error(state.storageError);
  const signature = JSON.stringify(state.entries);
  if (signature !== renderSignature) {
    renderSignature = signature;
    const box = $("messages"),
      atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
    if (state.entries?.length) {
      box.replaceChildren(
        ...state.entries.map((entry) => {
          const node = document.createElement("article");
          node.className = `message ${entry.role}`;
          const role = document.createElement("span");
          role.className = "role";
          role.textContent = entry.role === "user" ? "you" : "tress";
          const text = document.createElement("p");
          text.textContent = entry.text;
          const tools = document.createElement("div");
          tools.className = "tools";
          tools.textContent = (entry.tools || [])
            .map((tool) => `· ${tool}`)
            .join("\n");
          node.append(role, tools, text);
          return node;
        }),
      );
    } else {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent =
        "Ask about the project or create an output. Files stay on this machine.";
      box.replaceChildren(empty);
    }
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
  $("approval").hidden = !state.approval;
  if (state.approval) {
    $("command").textContent = state.approval.summary;
    $("allow").disabled = $("deny").disabled =
      !connected || pendingApproval === state.approval.id;
  }
  if (previousRuns !== undefined && previousRuns !== state.runs) {
    void browse(directory);
    if (selected) void preview(selected);
  }
}
function packet(value) {
  for (const operation of value.ops || []) {
    if (operation.op === "mount" || operation.op === "replace")
      render(operation.value);
  }
  for (const answer of value.cmd || []) {
    const waiting = pending.get(answer.seq);
    if (!waiting || !answer.type || answer.type === "applied") continue;
    pending.delete(answer.seq);
    clearTimeout(waiting.timer);
    if (answer.type === "result") waiting.resolve();
    else
      waiting.reject(
        new Error(answer.message || "The host rejected this command."),
      );
  }
}
async function command(method, params = []) {
  if (!connected)
    throw new Error("The host is disconnected. Reconnect before sending.");
  const seq = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(seq);
      reject(
        new Error(
          "No confirmation from the host. Check the conversation before retrying.",
        ),
      );
    }, 30000);
    pending.set(seq, { resolve, reject, timer });
    fetch(`${endpoint}/frames`, {
      method: "POST",
      headers: { "content-type": "application/json", "Statewire-Lease": lease },
      body: JSON.stringify({
        cmd: [{ seq, protocol: "default", method, params }],
      }),
    })
      .then((response) => {
        if (!response.ok)
          throw new Error(
            `The host could not confirm the command (${response.status}). Check the conversation before retrying.`,
          );
      })
      .catch((cause) => {
        clearTimeout(timer);
        pending.delete(seq);
        reject(cause);
      });
  });
}
async function connect() {
  if (!token) {
    error("Open the private browser URL printed by tress serve.");
    $("connection").textContent = "Session required";
    return;
  }
  for (;;) {
    try {
      const response = await fetch(`${endpoint}/stream`, {
        headers: {
          "Statewire-Version": `"${version}"`,
          "Statewire-Protocol": `default; version="${version}"`,
          "Statewire-Client-Id": crypto.randomUUID(),
        },
        cache: "no-store",
      });
      if ([401, 403, 400].includes(response.status)) {
        connected = false;
        controls();
        $("connection").textContent = "Connection refused";
        error(
          `Connection refused (${response.status}). Open the current browser URL printed by the host.`,
        );
        return;
      }
      if (!response.ok || !response.body) throw new Error("Host unavailable");
      lease = response.headers.get("statewire-lease");
      sequence = 0;
      connected = true;
      $("connection").textContent = "Connected to machine";
      error("");
      controls();
      void browse(directory);
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) packet(JSON.parse(data));
        }
      }
    } catch {
      /* Reattach to read state; never resend commands automatically. */
    }
    connected = false;
    controls();
    $("connection").textContent = "Host offline · reconnecting…";
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(
        new Error(
          "Connection interrupted. The run may continue; check its state before retrying.",
        ),
      );
    }
    pending.clear();
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}
async function browse(path) {
  const request = ++fileRequest;
  if (directory !== path) {
    selected = "";
    $("preview-panel").hidden = true;
  }
  directory = path;
  $("directory").textContent = path || "Project folder";
  $("parent").disabled = !path;
  $("refresh").disabled = true;
  error("", "file-error");
  try {
    const data = await json(url("/api/files", { path }));
    if (request !== fileRequest) return;
    const entries = data.entries.sort(
      (a, b) =>
        (a.type === b.type ? 0 : a.type === "directory" ? -1 : 1) ||
        a.name.localeCompare(b.name),
    );
    $("files").replaceChildren(
      ...entries.map((entry) => {
        const button = document.createElement("button"),
          name = document.createElement("span"),
          size = document.createElement("small");
        const child = path ? `${path}/${entry.name}` : entry.name;
        button.type = "button";
        button.dataset.path = child;
        button.setAttribute("aria-pressed", String(selected === child));
        name.textContent = entry.name + (entry.type === "directory" ? "/" : "");
        size.textContent =
          entry.type === "file"
            ? `${Math.ceil(entry.size / 1024)} KB`
            : "folder";
        button.append(name, size);
        button.onclick = () =>
          entry.type === "directory" ? browse(child) : preview(child);
        return button;
      }),
    );
    if (!entries.length) $("files").textContent = "This folder is empty.";
  } catch (cause) {
    if (request === fileRequest) {
      $("files").replaceChildren();
      error(cause.message, "file-error");
    }
  } finally {
    if (request === fileRequest) $("refresh").disabled = false;
  }
}
async function preview(path) {
  selected = path;
  for (const button of $("files").querySelectorAll("button"))
    button.setAttribute("aria-pressed", String(button.dataset.path === path));
  $("preview-panel").hidden = false;
  $("filename").textContent = path;
  $("download").href = url("/api/file", { path });
  $("download").download = path.split("/").pop();
  $("preview").textContent = "Loading from the host…";
  $("preview").hidden = false;
  $("image").hidden = true;
  if (imageUrl) {
    URL.revokeObjectURL(imageUrl);
    imageUrl = undefined;
  }
  try {
    const extension = path.split(".").pop().toLowerCase();
    const types = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    };
    if (types[extension]) {
      const response = await fetch(url("/api/file", { path }));
      if (!response.ok)
        throw new Error("Could not preview this image. Try downloading it.");
      const bytes = await response.arrayBuffer();
      if (selected !== path) return;
      imageUrl = URL.createObjectURL(
        new Blob([bytes], { type: types[extension] }),
      );
      $("image").src = imageUrl;
      $("image").hidden = false;
      $("preview").hidden = true;
    } else {
      const data = await json(url("/api/file", { path, preview: "true" }));
      if (selected === path) $("preview").textContent = data.content;
    }
  } catch (cause) {
    if (selected === path) $("preview").textContent = cause.message;
  }
}
$("composer").onsubmit = async (event) => {
  event.preventDefault();
  const prompt = $("prompt").value.trim();
  if (!prompt || $("send").disabled) return;
  $("send").disabled = true;
  error("");
  try {
    await command("send", [prompt]);
    if ($("prompt").value.trim() === prompt) $("prompt").value = "";
  } catch (cause) {
    error(cause.message);
  } finally {
    controls();
    $("prompt").focus();
  }
};
$("prompt").onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
};
$("clear").onclick = async () => {
  if (
    !confirm("Clear this shared conversation? Files on the host will be kept.")
  )
    return;
  try {
    await command("reset");
  } catch (cause) {
    error(cause.message);
  }
};
for (const [button, allow] of [
  ["allow", true],
  ["deny", false],
])
  $(button).onclick = async () => {
    const id = state.approval?.id;
    if (!id) return;
    pendingApproval = id;
    $("allow").disabled = $("deny").disabled = true;
    try {
      await command("approve", [id, allow]);
    } catch (cause) {
      error(cause.message);
    } finally {
      pendingApproval = undefined;
      render(state);
    }
  };
$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(
      `tress attach ${location.origin} -s ${token} --chat-only`,
    );
    $("copy").textContent = "Copied";
    setTimeout(() => ($("copy").textContent = "Copy terminal command"), 1500);
  } catch {
    error(
      "Clipboard unavailable. Copy the terminal command printed by the host.",
    );
  }
};
$("refresh").onclick = () => {
  void browse(directory);
  if (selected) void preview(selected);
};
$("parent").onclick = () => {
  selected = "";
  $("preview-panel").hidden = true;
  void browse(directory.split("/").slice(0, -1).join("/"));
};
void connect();
