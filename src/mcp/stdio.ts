import { createInterface } from "node:readline";
import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";
import { log } from "../log.js";

export interface StdioTransport {
  onMessage(handler: (msg: JsonRpcRequest) => void | Promise<void>): void;
  send(msg: unknown): void;
}

export function createStdioTransport(): StdioTransport {
  let handler: ((msg: JsonRpcRequest) => void | Promise<void>) | null = null;
  let pending = 0;
  let closing = false;

  function maybeExit(): void {
    if (closing && pending === 0) {
      log("zulip channel: shutting down");
      process.exit(0);
    }
  }

  const rl = createInterface({ input: process.stdin });

  rl.on("line", (line: string) => {
    if (!line.trim()) return;

    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(line) as JsonRpcRequest;
    } catch (err) {
      log(`json parse error: ${(err as Error).message}`);
      return;
    }

    if (handler) {
      pending++;
      const result = handler(parsed);
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>)
          .catch((e) => log(`handler error: ${e}`))
          .finally(() => {
            pending--;
            maybeExit();
          });
      } else {
        pending--;
        maybeExit();
      }
    }
  });

  rl.on("close", () => {
    closing = true;
    maybeExit();
  });

  return {
    onMessage(fn: (msg: JsonRpcRequest) => void | Promise<void>): void {
      handler = fn;
    },
    send(msg: unknown): void {
      process.stdout.write(JSON.stringify(msg) + "\n");
    },
  };
}
