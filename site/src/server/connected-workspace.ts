import { randomUUID } from "node:crypto";
import type { FileEntry, Workspace } from "@tress/workspaces";
import {
  connectStore,
  deviceOnline,
  type ConnectStore,
  type Device,
  type DeviceJob,
} from "./connect-store";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const connectedDevice = async (
  threadId: string,
  store: ConnectStore = connectStore(),
) => store.device(threadId);

/** Keep each call on its original device; never redeliver leased mutations. */
export const connectedCall = async (
  threadId: string,
  operation: DeviceJob["operation"],
  path: string,
  content?: string,
  store: ConnectStore = connectStore(),
  expectedDeviceId?: string,
) => {
  if (path.length > 1024 || path.includes("\0"))
    throw new Error("Invalid connected file path.");
  if (content !== undefined && Buffer.byteLength(content, "utf8") > 1_048_576)
    throw new Error("Connected file content exceeds the 1 MB limit.");
  const id = randomUUID();
  const job: DeviceJob = { id, operation, path, ...(content !== undefined && { content }) };
  const deviceId = expectedDeviceId ?? (await store.device(threadId))?.id;
  if (!deviceId || !(await store.enqueue(threadId, job, deviceId)))
    throw new Error(
      operation === "write"
        ? "The connected folder is offline, read-only, or its connection changed."
        : "The connected folder is offline or its connection changed. Reconnect its native Tress process.",
    );
  try {
    const until = Date.now() + 60_000;
    let checkConnectionAt = 0;
    while (Date.now() < until) {
      const state = await store.result(id);
      if (state?.status === "done") {
        if (!state.result.ok)
          throw new Error(state.result.error ?? "The local operation failed.");
        return state.result.value;
      }
      if (Date.now() >= checkConnectionAt) {
        const device = await store.device(threadId);
        if (!device || device.id !== deviceId || !deviceOnline(device))
          throw new Error(
            operation === "write"
              ? "The folder disconnected or its connection changed during a write. Check the file before retrying."
              : "The connected folder disconnected or its connection changed. Start a new prompt after reconnecting.",
          );
        checkConnectionAt = Date.now() + 1000;
      }
      await pause(200);
    }
    throw new Error(
      "The local operation timed out. If it was a write, check the file before retrying.",
    );
  } finally {
    await store.forget(id);
  }
};

export const createConnectedWorkspace = (
  threadId: string,
  device: Device,
  store: ConnectStore = connectStore(),
): Workspace & { writable: boolean } => {
  if (!deviceOnline(device))
    throw new Error("The connected folder is offline. Start tress connect on that device.");
  return {
    kind: "connected-local",
    details: {
      environment: "device",
      access: "connected",
      storage: "filesystem",
      shell: "none",
      writable: device.writable,
      label: device.label,
    },
    writable: device.writable,
    async readFile(path) {
      const value = await connectedCall(threadId, "read", path, undefined, store, device.id);
      if (typeof value !== "string") throw new Error("Invalid local file response.");
      return value;
    },
    async writeFile(path, content) {
      if (!device.writable) throw new Error("This connected folder is read-only.");
      const value = await connectedCall(threadId, "write", path, content, store, device.id);
      if (typeof value !== "string") throw new Error("Invalid local write response.");
    },
    async listFiles(path = "") {
      const value = await connectedCall(threadId, "list", path, undefined, store, device.id);
      if (!Array.isArray(value)) throw new Error("Invalid local directory response.");
      return value as FileEntry[];
    },
  };
};
