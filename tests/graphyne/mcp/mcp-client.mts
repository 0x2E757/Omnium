// Minimal stdio MCP client for the ported e2e suite. The prior suite drove the
// server through @modelcontextprotocol/sdk's Client; Omnium's dev harness is
// zero-dependency, so this ~80-line replacement speaks the same newline-
// delimited JSON-RPC 2.0 (initialize -> notifications/initialized ->
// tools/list / tools/call) and exposes the same three calls the tests use
// (listTools, callTool, close). Assertions in mcp.test.mts are untouched —
// only the transport plumbing changed.

import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class MiniMcpClient {
  private child: ChildProcess;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  private constructor(child: ChildProcess) {
    this.child = child;
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // not a frame — ignore
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      else waiter.resolve(msg.result);
    });
  }

  /** Spawn the server and complete the MCP handshake. */
  static async connect(command: string, args: string[], env: Record<string, string>): Promise<MiniMcpClient> {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "ignore"] });
    const client = new MiniMcpClient(child);
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    client.notify("notifications/initialized");
    return client;
  }

  private request(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    const frame: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) frame.params = params;
    this.child.stdin!.write(JSON.stringify(frame) + "\n");
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  private notify(method: string): void {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  async listTools(): Promise<{ tools: any[] }> {
    return this.request("tools/list");
  }

  async callTool(params: { name: string; arguments?: unknown }): Promise<unknown> {
    return this.request("tools/call", params);
  }

  async close(): Promise<void> {
    const exited = new Promise<void>((resolve) => this.child.once("close", () => resolve()));
    this.child.stdin!.end();
    await exited;
  }
}
