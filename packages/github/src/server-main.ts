import { serve } from "@hono/node-server";
import { configureGlobalHttp, logger } from "@rusty-bot/core";
import { app } from "./server.js";

const log = logger.child({ package: "github" });

configureGlobalHttp();
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
log.info({ port }, "server listening");
