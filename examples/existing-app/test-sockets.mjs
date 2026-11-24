// Test helper: dial Statewire WebSockets from Node with the headers a browser
// would send.
import { WebSocket } from "ws";

/** A WebSocket constructor that sends `headers` (e.g. a cookie) on the upgrade. */
export const socketWith = (headers) =>
  class extends WebSocket {
    constructor(url, protocols) { super(url, protocols, { headers }); }
  };
