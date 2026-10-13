import * as net from "node:net";
import { createLogger } from "../logger.js";

const log = createLogger("git-relay");

export interface GitRelayOptions {
  targetIp: string;
  expectedHost: string;
  expectedPort: number;
}

const MAX_HEADER_SIZE = 4096;
const CONNECTION_TIMEOUT_MS = 10000;
const IDLE_TIMEOUT_MS = 60000;

export class GitRelay {
  private server: net.Server;
  private port: number = 0;
  private activeConnections = new Set<net.Socket>();
  private activeTargets = new Set<net.Socket>();
  private stopping = false;

  constructor(private options: GitRelayOptions) {
    if (!net.isIP(options.targetIp)) {
      throw new Error("GitRelay targetIp must be a literal IP address");
    }
    this.server = net.createServer(this.handleConnection.bind(this));
    this.server.maxConnections = 5;
  }

  public async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once("error", onError);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", onError);
        const address = this.server.address() as net.AddressInfo;
        this.port = address.port;
        resolve(this.port);
      });
    });
  }

  private stopPromise: Promise<void> | null = null;

  public async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.stopping) return Promise.resolve();
    this.stopping = true;

    for (const socket of this.activeConnections) {
      if (!socket.destroyed) socket.destroy();
    }
    this.activeConnections.clear();

    for (const target of this.activeTargets) {
      if (!target.destroyed) target.destroy();
    }
    this.activeTargets.clear();

    this.stopPromise = new Promise((resolve) => {
      this.server.close(() => resolve());
    });
    return this.stopPromise;
  }

  private handleConnection(clientSocket: net.Socket) {
    if (this.stopping) {
      clientSocket.destroy();
      return;
    }

    this.activeConnections.add(clientSocket);

    let deadlineReached = false;
    const deadlineTimer = setTimeout(() => {
      deadlineReached = true;
      log.warn("Git Relay: Fixed connect deadline exceeded");
      clientSocket.destroy();
    }, CONNECTION_TIMEOUT_MS);

    const cleanupClient = () => {
      clearTimeout(deadlineTimer);
      this.activeConnections.delete(clientSocket);
      if (!clientSocket.destroyed) clientSocket.destroy();
    };

    clientSocket.once("close", cleanupClient);
    clientSocket.once("error", cleanupClient);

    let buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      if (deadlineReached) return;

      if (buffer.length + chunk.length > MAX_HEADER_SIZE) {
        log.warn("Git Relay: Header size exceeded");
        clientSocket.removeListener("data", onData);
        clientSocket.end("HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n", () => {
          clientSocket.destroy();
        });
        return;
      }

      buffer = Buffer.concat([buffer, chunk]);

      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd !== -1) {
        clientSocket.removeListener("data", onData);
        clearTimeout(deadlineTimer);

        const headers = buffer.subarray(0, headerEnd).toString("ascii");
        const firstLine = headers.split("\r\n")[0];

        const parts = firstLine ? firstLine.split(" ") : [];
        if (parts.length !== 3 || parts[0] !== "CONNECT" || (parts[2] !== "HTTP/1.1" && parts[2] !== "HTTP/1.0")) {
          log.warn("Git Relay: Malformed CONNECT line");
          clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n", () => clientSocket.destroy());
          return;
        }

        const target = parts[1];
        if (!target) {
          clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n", () => clientSocket.destroy());
          return;
        }

        let host = "";
        let portStr = "";

        if (target.startsWith("[")) {
          const closeBracket = target.indexOf("]");
          if (closeBracket === -1) {
             clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n", () => clientSocket.destroy());
             return;
          }
          host = target.slice(1, closeBracket);
          const remainder = target.slice(closeBracket + 1);
          if (remainder) {
             if (remainder.startsWith(":") && remainder.length > 1) {
                portStr = remainder.slice(1);
             } else {
                log.warn("Git Relay: Malformed bracket remainder");
                clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n", () => clientSocket.destroy());
                return;
             }
          }
        } else {
          const split = target.split(":");
          if (split.length > 2 || (split.length === 2 && !split[1])) {
             log.warn("Git Relay: Malformed host port suffix");
             clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n", () => clientSocket.destroy());
             return;
          } else if (split.length === 2) {
             host = split[0]!;
             portStr = split[1]!;
          } else {
             host = target;
          }
        }

        if (portStr && !/^\d+$/.test(portStr)) {
          log.warn("Git Relay: Malformed port suffix");
          clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n", () => clientSocket.destroy());
          return;
        }

        const port = portStr ? parseInt(portStr, 10) : 443;
        if (port < 1 || port > 65535) {
          log.warn("Git Relay: Port out of range");
          clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n", () => clientSocket.destroy());
          return;
        }

        let cleanExpectedHost = this.options.expectedHost;
        if (cleanExpectedHost.startsWith("[") && cleanExpectedHost.endsWith("]")) {
           cleanExpectedHost = cleanExpectedHost.slice(1, -1);
        }

        if (host !== cleanExpectedHost || port !== this.options.expectedPort) {
          log.warn("Git Relay: Host/Port mismatch");
          clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n", () => clientSocket.destroy());
          return;
        }

        let targetDeadlineReached = false;
        const targetDeadlineTimer = setTimeout(() => {
          targetDeadlineReached = true;
          log.warn("Git Relay: Target connect deadline exceeded");
          if (targetSocket && !targetSocket.destroyed) targetSocket.destroy();
          clientSocket.destroy();
        }, CONNECTION_TIMEOUT_MS);

        const targetSocket = net.connect({
          host: this.options.targetIp,
          port: this.options.expectedPort,
        });

        this.activeTargets.add(targetSocket);

        const cleanupTarget = () => {
           clearTimeout(targetDeadlineTimer);
           this.activeTargets.delete(targetSocket);
           if (!targetSocket.destroyed) targetSocket.destroy();
           if (!clientSocket.destroyed) clientSocket.destroy();
        };

        targetSocket.once("close", cleanupTarget);
        targetSocket.once("error", () => {
          log.error("Git Relay: Target connection error");
          if (!clientSocket.destroyed) {
            clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n", cleanupTarget);
          } else {
            cleanupTarget();
          }
        });

        // Setup paired cleanup on the client socket if client closes first
        clientSocket.once("close", cleanupTarget);
        clientSocket.once("error", cleanupTarget);

        targetSocket.on("connect", () => {
          clearTimeout(targetDeadlineTimer);
          if (targetDeadlineReached) return;

          clientSocket.setTimeout(IDLE_TIMEOUT_MS);
          targetSocket.setTimeout(IDLE_TIMEOUT_MS);

          const onTimeout = () => {
            clientSocket.destroy();
            targetSocket.destroy();
          };
          clientSocket.once("timeout", onTimeout);
          targetSocket.once("timeout", onTimeout);

          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

          if (buffer.length > headerEnd + 4) {
            targetSocket.write(buffer.subarray(headerEnd + 4));
          }

          clientSocket.pipe(targetSocket);
          targetSocket.pipe(clientSocket);
        });
      }
    };

    clientSocket.on("data", onData);
  }
}
