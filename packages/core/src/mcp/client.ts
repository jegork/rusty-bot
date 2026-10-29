import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolSet } from "ai";
import type { McpServerConfig } from "./types.js";
import { McpServerConfigSchema } from "./types.js";
import { logger } from "../logger.js";

const DEFAULT_CONFIG_FILE = "mcp-servers.json";

type McpServerEntry = McpServerConfig[string];
type StdioServerEntry = Extract<McpServerEntry, { command: string }>;
type HttpServerEntry = Exclude<McpServerEntry, StdioServerEntry>;

function isStdio(entry: McpServerEntry): entry is StdioServerEntry {
  return typeof entry.command === "string";
}

function headersOf(entry: HttpServerEntry): Record<string, string> | undefined {
  const headers = entry.requestInit?.headers;
  if (headers === undefined) return undefined;
  return Object.fromEntries(
    new Headers(headers as ConstructorParameters<typeof Headers>[0]).entries(),
  );
}

// url entries try streamable http first and fall back to sse, so configs
// written against either transport keep working
async function createClient(entry: McpServerEntry): Promise<MCPClient> {
  if (isStdio(entry)) {
    return createMCPClient({
      transport: new Experimental_StdioMCPTransport({
        command: entry.command,
        ...(entry.args && { args: entry.args }),
        ...(entry.env && { env: entry.env }),
      }),
    });
  }
  const url = String(entry.url);
  const headers = headersOf(entry);
  try {
    return await createMCPClient({ transport: { type: "http", url, headers } });
  } catch (err) {
    logger.debug({ err, url }, "streamable http MCP connect failed; retrying over sse");
    return createMCPClient({ transport: { type: "sse", url, headers } });
  }
}

/**
 * Connects to the configured MCP servers, discovers their tools, and returns
 * them as an AI SDK tool set (named `<server>_<tool>`) plus a cleanup
 * function to close the connections.
 *
 * Each server is connected independently — if one server fails, the rest
 * still contribute their tools.
 */
export async function connectMcpServers(
  servers: McpServerConfig,
): Promise<{ tools: ToolSet; disconnect: () => Promise<void> }> {
  const names = Object.keys(servers);
  if (names.length === 0) {
    return { tools: {}, disconnect: () => Promise.resolve() };
  }

  const allTools: ToolSet = {};
  const connectedClients: MCPClient[] = [];

  for (const name of names) {
    let client: MCPClient | undefined;
    try {
      client = await createClient(servers[name]);
      const tools = await client.tools();
      for (const [toolName, tool] of Object.entries(tools)) {
        allTools[`${name}_${toolName}`] = tool;
      }
      connectedClients.push(client);
    } catch (err) {
      logger.warn({ err, server: name }, "failed to connect MCP server; skipping");
      try {
        await client?.close();
      } catch {
        // ignore cleanup errors for failed connections
      }
    }
  }

  const disconnect = async () => {
    await Promise.allSettled(connectedClients.map((c) => c.close()));
  };

  return { tools: allTools, disconnect };
}

/**
 * Loads MCP server configurations from a JSON file.
 * Returns an empty object if the file does not exist.
 *
 * The file should contain a JSON object keyed by server name:
 * ```json
 * {
 *   "docs": { "command": "npx", "args": ["-y", "@my/mcp-docs-server"] },
 *   "sentry": { "url": "https://mcp.sentry.io/sse" }
 * }
 * ```
 */
export async function loadMcpServerConfigs(filePath: string): Promise<McpServerConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${filePath}: invalid JSON in MCP servers config file`);
  }

  const result = McpServerConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`${filePath}: invalid MCP servers config:\n${issues}`);
  }

  return result.data;
}

/**
 * Convenience wrapper that resolves the config file path from the
 * RUSTY_MCP_CONFIG env var (falling back to ./mcp-servers.json) and
 * loads the config. Returns an empty object when no file is found.
 */
export async function loadMcpServerConfigsFromEnv(): Promise<McpServerConfig> {
  const filePath = process.env.RUSTY_MCP_CONFIG ?? join(process.cwd(), DEFAULT_CONFIG_FILE);
  return loadMcpServerConfigs(filePath);
}
