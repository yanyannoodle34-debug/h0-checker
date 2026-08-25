import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { initAnalyzer } from "./ai-analyzer";
import { startBot } from "./telegram-bot";
import { storage } from "./storage";

const app = express();
const httpServer = createServer(app);

// Last-resort safety net — log and keep the process alive on any
// uncaught error from third-party callbacks (telegram bot, undici fetch,
// etc.) so one stray promise rejection can't tank a long-running gate run.
process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error("[unhandledRejection]", msg);
});
process.on("uncaughtException", (err: Error) => {
  console.error("[uncaughtException]", err.stack || err.message);
});

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    // Raised from the 100kb default so gate-import uploads (.py scripts and
    // multi-MB HAR network captures, sent as a JSON string field) fit. The
    // /api/gates/import route enforces its own 5 MB content cap on top of this.
    limit: "8mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      // Suppress high-frequency polling endpoints from the log
      const silentPolling = ["/api/dashboard/stats", "/api/system/stats"];
      if (silentPolling.includes(path) && (res.statusCode === 200 || res.statusCode === 304)) return;
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse && path === "/api/checks") {
        const brief = Array.isArray(capturedJsonResponse)
          ? capturedJsonResponse.map((r: any) => `${r.status}|${r.response?.substring(0, 50)}`).join("; ")
          : JSON.stringify(capturedJsonResponse).substring(0, 120);
        logLine += ` :: ${brief}`;
      }
      log(logLine);
    }
  });

  next();
});

(async () => {
  // Sync DB schema — prefer local binary over npx to avoid npm cache overhead
  try {
    const { execSync } = await import("child_process");
    const fs = await import("fs");
    const localDrizzle = "./node_modules/.bin/drizzle-kit";
    const drizzleCmd = fs.existsSync(localDrizzle)
      ? `${localDrizzle} push --force`
      : "npx drizzle-kit push --force";
    execSync(drizzleCmd, { stdio: "pipe" });
    log("Database schema synchronized", "db");
  } catch (e: any) {
    log(`Database schema sync warning: ${e.message}`, "db");
  }

  await registerRoutes(httpServer, app);

  // Start the AI analyzer background loop if it was left enabled on the last shutdown.
  try { initAnalyzer(); } catch (e: any) { console.error("[ai-analyzer] init failed:", e?.message ?? e); }

  // Bootstrap bot config from env vars — required for Termux bot-mode where
  // there's no dashboard to set them. Env-supplied values ALWAYS overwrite
  // the stored value: start.py only exports BOT_TOKEN / OWNER_ID when the
  // user passed them on this run (via --bot-token / env / interactive prompt),
  // so a non-empty env var is an explicit "use this token now" signal.
  // Earlier we only wrote when the DB field was empty, which silently ignored
  // a freshly typed token whenever the DB still had a stale one — leaving
  // the user with a working --bot-token flag but a bot that polled the old key.
  try {
    const envToken = process.env.BOT_TOKEN?.trim();
    const envOwner = process.env.OWNER_ID?.trim();
    if (envToken || envOwner) {
      const cur = await storage.getBotSettings();
      const updates: Record<string, string> = {};
      if (envToken && envToken !== cur.botToken) {
        updates.botToken = envToken;
        const oldHint = cur.botToken ? `${cur.botToken.slice(0, 8)}…` : "(empty)";
        log(`bot token updated from env: ${oldHint} → ${envToken.slice(0, 8)}…`, "telegram");
      }
      if (envOwner && envOwner !== cur.ownerId) {
        updates.ownerId = envOwner;
        log(`owner id updated from env: ${cur.ownerId || "(empty)"} → ${envOwner}`, "telegram");
      }
      if (Object.keys(updates).length > 0) {
        await storage.updateBotSettings(updates as any);
      }
    }
  } catch (e: any) {
    console.error("[bot-bootstrap] failed:", e?.message ?? e);
  }

  // Auto-start the Telegram bot when H0_AUTO_START_BOT=true. start.py sets this
  // for --bot-mode so the bot polls immediately without the user needing to
  // hit POST /api/telegram/start from the (unreachable) web dashboard.
  if (process.env.H0_AUTO_START_BOT === "true") {
    try {
      // Inspect DB state BEFORE calling startBot so we can give an accurate
      // log message — the old "skipped (no botToken in DB)" line fired even
      // when the real reason was a 404/401 from Telegram, which was both
      // factually wrong and obscured the earlier "token rejected" error.
      const pre = await storage.getBotSettings();
      const ok = await startBot();
      if (ok) {
        log("bot auto-started (H0_AUTO_START_BOT)", "telegram");
      } else if (!pre.botToken) {
        log("bot auto-start skipped — no token configured. Re-run with --bot-token <TOKEN>.", "telegram");
      } else {
        // startBot already logged the specific reason (404, 401, network, etc.)
        log("bot auto-start failed — see the [telegram] error above for the cause.", "telegram");
      }
    } catch (e: any) {
      console.error("[bot-autostart] failed:", e?.message ?? e);
    }
  }

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);

  // Some Android kernels don't support SO_REUSEPORT — fall back gracefully
  const tryListen = (opts: object, fallback?: object) => {
    httpServer.listen(opts, () => log(`serving on port ${port}`));
    httpServer.once("error", (err: any) => {
      if (err.code === "ERR_SOCKET_BAD_PORT" || err.code === "ENOTSUP") {
        if (fallback) {
          httpServer.removeAllListeners("error");
          tryListen(fallback);
        } else {
          log(`Listen error: ${err.message}`, "express");
        }
      }
    });
  };

  tryListen(
    { port, host: "0.0.0.0", reusePort: true },
    { port, host: "0.0.0.0" },
  );
})();
