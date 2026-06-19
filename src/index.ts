import cors from "cors";
import express from "express";
import { config } from "./config";
import { logger } from "./logger";
import { requireApiKey } from "./middleware/auth";
import { sessionsRouter } from "./routes/sessions";

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/sessions", requireApiKey, sessionsRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, "unhandled error");
  res.status(500).json({ error: "Internal server error" });
});

app.listen(config.port, () => {
  logger.info(`api-barleys listening on port ${config.port}`);
});
