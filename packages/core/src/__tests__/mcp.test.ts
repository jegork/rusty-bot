import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { loadMcpServerConfigs, connectMcpServers } from "../mcp/client.js";

const TMP_DIR = join(import.meta.dirname, ".tmp-mcp-test");

describe("loadMcpServerConfigs", () => {
  beforeAll(() => mkdir(TMP_DIR, { recursive: true }));
  afterAll(() => rm(TMP_DIR, { recursive: true, force: true }));

  it("returns empty object when file does not exist", async () => {
    const result = await loadMcpServerConfigs("/nonexistent/path/mcp-servers.json");
    expect(result).toEqual({});
  });

  it("parses valid config file", async () => {
    const filePath = join(TMP_DIR, "valid.json");
    const config = {
      docs: { command: "npx", args: ["-y", "@my/mcp-docs"] },
      sentry: { url: "https://mcp.sentry.io/sse" },
    };
    await writeFile(filePath, JSON.stringify(config));

    const result = await loadMcpServerConfigs(filePath);
    expect(result).toEqual(config);
  });

  it("throws with file path on invalid JSON", async () => {
    const filePath = join(TMP_DIR, "invalid.json");
    await writeFile(filePath, "not json {{{");

    await expect(loadMcpServerConfigs(filePath)).rejects.toThrow(filePath);
  });

  it("throws when file contains a JSON array", async () => {
    const filePath = join(TMP_DIR, "array.json");
    await writeFile(filePath, "[]");

    await expect(loadMcpServerConfigs(filePath)).rejects.toThrow("invalid MCP servers config");
  });

  it("throws when file contains a non-object value", async () => {
    const filePath = join(TMP_DIR, "string.json");
    await writeFile(filePath, '"hello"');

    await expect(loadMcpServerConfigs(filePath)).rejects.toThrow("invalid MCP servers config");
  });

  it("throws when a server entry is not an object", async () => {
    const filePath = join(TMP_DIR, "bad-entry.json");
    await writeFile(filePath, JSON.stringify({ docs: 42 }));

    await expect(loadMcpServerConfigs(filePath)).rejects.toThrow("invalid MCP servers config");
  });

  it("throws when a server entry has neither command nor url", async () => {
    const filePath = join(TMP_DIR, "no-transport.json");
    await writeFile(filePath, JSON.stringify({ docs: { args: ["--help"] } }));

    await expect(loadMcpServerConfigs(filePath)).rejects.toThrow("invalid MCP servers config");
  });
});

describe("connectMcpServers", () => {
  it("returns empty tools and a noop disconnect for empty config", async () => {
    const result = await connectMcpServers({});
    expect(result.tools).toEqual({});
    expect(typeof result.disconnect).toBe("function");
    await result.disconnect(); // should not throw
  });
});

const ECHO_SERVER = join(import.meta.dirname, "fixtures", "echo-mcp-server.mjs");
const toolCallOptions = { toolCallId: "call-1", messages: [] };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

describe("connectMcpServers over stdio", () => {
  beforeAll(() => mkdir(TMP_DIR, { recursive: true }));
  afterAll(() => rm(TMP_DIR, { recursive: true, force: true }));

  it("discovers and runs a tool, then closes the child on disconnect", async () => {
    const pidFile = join(TMP_DIR, "echo.pid");
    const mcp = await connectMcpServers({
      local: { command: process.execPath, args: [ECHO_SERVER], env: { ECHO_PID_FILE: pidFile } },
    });

    // tools are exposed as <server>_<tool>, the names existing configs rely on
    expect(Object.keys(mcp.tools)).toEqual(["local_echo"]);
    const result = await mcp.tools.local_echo.execute?.({ text: "hi" }, toolCallOptions);
    expect(result).toMatchObject({ content: [{ type: "text", text: "echo: hi" }] });

    const pid = Number(await readFile(pidFile, "utf-8"));
    expect(isAlive(pid)).toBe(true);
    await expect(mcp.disconnect()).resolves.toBeUndefined();
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
  });

  it("namespaces tools per server so two servers with the same tool do not collide", async () => {
    const mcp = await connectMcpServers({
      a: { command: process.execPath, args: [ECHO_SERVER] },
      b: { command: process.execPath, args: [ECHO_SERVER] },
    });
    try {
      expect(Object.keys(mcp.tools).sort()).toEqual(["a_echo", "b_echo"]);
    } finally {
      await mcp.disconnect();
    }
  });

  it("skips a server that fails to start and keeps the others", async () => {
    const mcp = await connectMcpServers({
      broken: { command: join(TMP_DIR, "does-not-exist") },
      dead: { url: "http://127.0.0.1:1/mcp" },
      local: { command: process.execPath, args: [ECHO_SERVER] },
    });
    try {
      expect(Object.keys(mcp.tools)).toEqual(["local_echo"]);
    } finally {
      await mcp.disconnect();
    }
  });

  it("returns no tools when every server fails", async () => {
    const mcp = await connectMcpServers({ dead: { url: "http://127.0.0.1:1/mcp" } });
    expect(mcp.tools).toEqual({});
    await expect(mcp.disconnect()).resolves.toBeUndefined();
  });
});

describe("connectMcpServers over http", () => {
  let httpServer: Server;
  let baseUrl: string;
  const seenAuth: (string | undefined)[] = [];

  // an sse-only server: streamable http POSTs to /sse are rejected, so the
  // client has to fall back to the sse transport
  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see import
    const transports = new Map<string, SSEServerTransport>();
    httpServer = createServer((req, res) => {
      seenAuth.push(req.headers.authorization);
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/sse") {
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- see import
        const transport = new SSEServerTransport("/messages", res);
        transports.set(transport.sessionId, transport);
        const server = new McpServer({ name: "sse-echo", version: "1.0.0" });
        server.registerTool("ping", { inputSchema: { n: z.number() } }, ({ n }) => ({
          content: [{ type: "text", text: `pong ${n}` }],
        }));
        void server.connect(transport);
        return;
      }
      if (req.method === "POST" && url.pathname === "/messages") {
        const transport = transports.get(url.searchParams.get("sessionId") ?? "");
        if (transport) {
          void transport.handlePostMessage(req, res);
          return;
        }
      }
      res.writeHead(405).end();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    httpServer.closeAllConnections();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  it("falls back to sse when streamable http is rejected, forwarding requestInit headers", async () => {
    seenAuth.length = 0;
    const mcp = await connectMcpServers({
      remote: { url: `${baseUrl}/sse`, requestInit: { headers: { Authorization: "Bearer t" } } },
    });
    try {
      expect(Object.keys(mcp.tools)).toEqual(["remote_ping"]);
      const result = await mcp.tools.remote_ping.execute?.({ n: 3 }, toolCallOptions);
      expect(result).toMatchObject({ content: [{ type: "text", text: "pong 3" }] });
      expect(seenAuth.length).toBeGreaterThan(0);
      expect(seenAuth.every((h) => h === "Bearer t")).toBe(true);
    } finally {
      await mcp.disconnect();
    }
  });
});
