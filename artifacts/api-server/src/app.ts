import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

// After bundling, import.meta.url points at dist/index.mjs, so this
// resolves to artifacts/motel-refuge/dist/public regardless of cwd.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "..", "motel-refuge", "dist", "public");

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);
// Anything under /api that wasn't matched above is a 404, not the SPA shell.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use(express.static(publicDir));
app.get("/*splat", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

export default app;
