import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { authMiddleware } from "./middlewares/authMiddleware";

const app: Express = express();

// We run behind Replit's proxy; trust the first hop so req.ip reflects the
// real client address (used for rate limiting) without honoring arbitrary
// client-spoofed X-Forwarded-For chains.
app.set("trust proxy", 1);

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
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
// Voice-note transcription posts base64 audio (up to ~5MB raw, ~7MB as
// base64 JSON); everything else keeps the conservative default limit.
app.use(
  "/api/v1/public/concierge/transcriptions",
  express.json({ limit: "8mb" }),
);
// CSV lead imports post the raw file contents as a JSON string (up to 5MB
// of CSV, ~6MB with JSON escaping); the route re-enforces the 5MB CSV cap.
app.use("/api/v1/lead-imports", express.json({ limit: "8mb" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(authMiddleware);

app.use("/api", router);

export default app;
