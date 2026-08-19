import type { AdapterLogger } from "./types.js";

interface OpenCodeLogClient {
  app: {
    log(input: {
      body: {
        service: string;
        level: "debug" | "info" | "warn" | "error";
        message: string;
      };
    }): Promise<unknown>;
  };
}

export function createOpenCodeLogger(client: OpenCodeLogClient): AdapterLogger {
  const write = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ): void => {
    void client.app
      .log({
        body: {
          service: "memory-tencentdb-opencode",
          level,
          message,
        },
      })
      .catch(() => undefined);
  };

  return {
    debug: (message) => write("debug", message),
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
  };
}
