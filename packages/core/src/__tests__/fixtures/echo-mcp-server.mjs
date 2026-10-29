// minimal stdio MCP server for the mcp client round-trip test. writes its pid
// to $ECHO_PID_FILE so the test can check the child exits on disconnect
import { writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

if (process.env.ECHO_PID_FILE) writeFileSync(process.env.ECHO_PID_FILE, String(process.pid));

const server = new McpServer({ name: "echo", version: "1.0.0" });
server.registerTool(
  "echo",
  { description: "echo the input back", inputSchema: { text: z.string() } },
  ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);
await server.connect(new StdioServerTransport());
