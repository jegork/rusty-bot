import { z } from "zod";

const StdioServerSchema = z
  .object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .loose();

const HttpServerSchema = z
  .object({
    url: z.string().or(z.instanceof(URL)),
    requestInit: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

const ServerEntrySchema = z.union([StdioServerSchema, HttpServerSchema]);

export const McpServerConfigSchema = z.record(z.string(), ServerEntrySchema);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
