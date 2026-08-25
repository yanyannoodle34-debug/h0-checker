import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ESM-safe __dirname — `"type": "module"` in package.json means the
// CommonJS __dirname global is undefined. Recreate it from import.meta.url.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");

  // dist/public is created by `npm run build`. In bot-mode (Termux, no build)
  // the directory legitimately doesn't exist — degrade gracefully instead of
  // throwing, so the Telegram bot + API still come up.
  if (!fs.existsSync(distPath)) {
    console.warn(`[static] ${distPath} not found — web dashboard disabled (API + bot still work)`);
    app.use("/{*path}", (req, res, next) => {
      if (req.path.startsWith("/api")) return next();   // let API routes match
      res.status(404).type("text/plain").send(
        "Web dashboard is not available in this build.\n" +
        "The API and Telegram bot are running normally.\n" +
        "Build dist/public on a non-Termux machine to enable the UI."
      );
    });
    return;
  }

  app.use(express.static(distPath));
  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
