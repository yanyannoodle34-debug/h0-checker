/**
 * AI Analyzer — background loop that watches real gate failures, asks the
 * NVIDIA Llama-70B model what setting changes would unblock each gate, and
 * stores actionable suggestions for an admin to review.
 *
 * Design choices:
 *  - File-backed state (data/.ai-analyzer.json) so we avoid a schema migration.
 *  - Suggestions are never auto-applied; an admin hits APPLY on the AI Console
 *    after reviewing the analysis + raw failure samples.
 *  - Cost cap: at most MAX_LLM_CALLS_PER_CYCLE LLM calls per 10-min cycle.
 *  - Sampling: we look at gates whose last N checks are >FAILURE_RATE_THRESHOLD%
 *    failures and have no recent approval — i.e. likely broken, not just slow.
 */
import * as fs from "fs";
import * as path from "path";
import { storage } from "./storage";
import { readAIKey } from "./ai-key";

const STATE_FILE = path.resolve(process.cwd(), "data", ".ai-analyzer.json");
const CYCLE_MS = 10 * 60_000; // 10 minutes
const RESULT_LOOKBACK = 50;     // checks per gate to inspect
const FAILURE_RATE_THRESHOLD = 0.6; // 60%
const MIN_CHECKS = 10;          // skip gates with too little data
const MAX_LLM_CALLS_PER_CYCLE = 5; // cost guard
const MAX_SUGGESTIONS_STORED = 50;
const SAMPLE_COUNT = 6;          // raw response samples per gate
const SAMPLE_TRUNC = 500;        // chars per sample

export interface Suggestion {
  id: string;
  gateId: string;
  gateName: string;
  createdAt: string;
  status: "pending" | "applied" | "dismissed";
  failureRate: number;
  sampleCount: number;
  samples: string[];                // truncated raw responses
  analysis: string;                 // 1-2 sentence LLM summary
  changes: Record<string, any>;     // proposed settings patch
  confidence: number;               // 0..1
  reason: string;                   // short rationale per suggestion
}

interface AnalyzerState {
  enabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: string;
  cycleCount: number;
  suggestions: Suggestion[];
}

let memState: AnalyzerState | null = null;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

function loadState(): AnalyzerState {
  if (memState) return memState;
  try {
    if (fs.existsSync(STATE_FILE)) {
      memState = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      return memState!;
    }
  } catch { /* fall through */ }
  memState = { enabled: false, lastRunAt: null, lastRunStatus: "idle", cycleCount: 0, suggestions: [] };
  return memState!;
}

function saveState(): void {
  if (!memState) return;
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(memState, null, 2), { mode: 0o600 });
  } catch (e: any) {
    console.error("[ai-analyzer] saveState failed:", e?.message ?? e);
  }
}

export function getAnalyzerState(): AnalyzerState {
  return loadState();
}

export function setAnalyzerEnabled(on: boolean): AnalyzerState {
  const s = loadState();
  s.enabled = on;
  saveState();
  if (on) startBackground();
  else stopBackground();
  return s;
}

export function dismissSuggestion(id: string): boolean {
  const s = loadState();
  const sug = s.suggestions.find(x => x.id === id);
  if (!sug) return false;
  sug.status = "dismissed";
  saveState();
  return true;
}

export function markSuggestionApplied(id: string): boolean {
  const s = loadState();
  const sug = s.suggestions.find(x => x.id === id);
  if (!sug) return false;
  sug.status = "applied";
  saveState();
  return true;
}

export function getSuggestion(id: string): Suggestion | null {
  const s = loadState();
  return s.suggestions.find(x => x.id === id) || null;
}

function trimSuggestions(): void {
  const s = loadState();
  if (s.suggestions.length > MAX_SUGGESTIONS_STORED) {
    s.suggestions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    s.suggestions = s.suggestions.slice(0, MAX_SUGGESTIONS_STORED);
  }
}

// ── Cycle implementation ─────────────────────────────────────────────────────

async function findCandidateGates(): Promise<Array<{ gate: any; samples: string[]; failureRate: number }>> {
  const gates: any[] = await storage.getGateConfigs();
  const results: any[] = await storage.getCheckResults({ noLimit: true } as any).catch(() => []);
  const out: Array<{ gate: any; samples: string[]; failureRate: number }> = [];
  for (const gate of gates) {
    if (!gate.active) continue;
    const recent = results
      .filter(r => r.gate === gate.name)
      .slice(0, RESULT_LOOKBACK);
    if (recent.length < MIN_CHECKS) continue;
    const failures = recent.filter(r => r.status === "declined" || r.status === "error");
    const failureRate = failures.length / recent.length;
    if (failureRate < FAILURE_RATE_THRESHOLD) continue;
    // Skip gates that have at least one recent approval — they're not "stuck".
    const hasAnyApproval = recent.some(r => r.status === "approved");
    if (hasAnyApproval) continue;

    // Sample raw response strings (uniformly distributed across the failure window).
    // Prefer rawSnippet when present — it contains the actual site response body,
    // which carries far more signal than our formatted summary string.
    const samples: string[] = [];
    const step = Math.max(1, Math.floor(failures.length / SAMPLE_COUNT));
    for (let i = 0; i < failures.length && samples.length < SAMPLE_COUNT; i += step) {
      const f = failures[i] as any;
      const resp = String(f.rawSnippet || f.response || "").slice(0, SAMPLE_TRUNC);
      if (resp) samples.push(resp);
    }
    if (samples.length === 0) continue;
    out.push({ gate, samples, failureRate });
  }
  // Most-failing first
  out.sort((a, b) => b.failureRate - a.failureRate);
  return out;
}

async function askLLM(gate: any, samples: string[], failureRate: number): Promise<Omit<Suggestion, "id" | "gateId" | "gateName" | "createdAt" | "status" | "sampleCount" | "samples" | "failureRate"> | null> {
  const apiKey = readAIKey();
  if (!apiKey) return null;
  const settings = JSON.stringify(gate.settings || {}, null, 2).slice(0, 2000);
  const system = `You are a payment-gate diagnostician. Given recent FAILED response samples and the gate's current settings, propose the SMALLEST set of setting changes that could unblock the gate.

Rules:
- Only respond with valid JSON, no prose, no markdown.
- changes must reference fields the checker actually reads (captchaProvider, captchaApiKey, wcBlockCheckout, wcPaySlug, proxyCountry, proxyOverride, walletConfigId, liveOverrides, deadOverrides, ajaxNonce, gfPiNonce, addPmPath, timeout, donationType, currency, billingCountry, billing*, platform, checkoutPath, shopPath, btFlow, btMerchantId).
- If samples show Cloudflare/Turnstile challenge pages → suggest captchaProvider="2captcha" + remind admin to set captchaApiKey.
- If samples show "nonce", "session expired", "refresh" → suggest wcBlockCheckout=true OR a stale-nonce fix.
- If samples show "rate limit", "too many requests", 429 → suggest proxyCountry or proxyOverride.
- If samples show "integration_surface" / "invalid_request_error" / "publishable key" → suggest walletConfigId="".
- If samples show only "Payment processing failed" with no decline_code → likely missing/wrong wcPaySlug.
- If samples are mostly the SAME bank decline keyword (e.g. "do_not_honor", "insufficient_funds") → suggest adding it to liveOverrides.
- Always include "reason" with one short sentence per change.
- confidence is 0..1 based on signal strength of the samples.

Output schema:
{"analysis": "1-2 sentence summary of what the failures show", "changes": {"key1": "value1"}, "confidence": 0.0-1.0, "reason": "one short sentence overall rationale"}`;

  const user = `GATE
  name: ${gate.name}
  type: ${gate.gateType}/${gate.subType}
  url: ${gate.url}
  failure_rate: ${(failureRate * 100).toFixed(0)}% over last ${RESULT_LOOKBACK} checks
  current_settings: ${settings}

RAW FAILURE SAMPLES (most-recent first, truncated):
${samples.map((s, i) => `[${i + 1}] ${s}`).join("\n\n")}`;

  try {
    const r = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "meta/llama-3.1-70b-instruct",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.3,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!r.ok) {
      console.error("[ai-analyzer] LLM error:", r.status, (await r.text()).slice(0, 200));
      return null;
    }
    const data: any = await r.json();
    const raw: string = data.choices?.[0]?.message?.content || "{}";
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    const parsed: any = JSON.parse(cleaned);
    const changes = (parsed.changes && typeof parsed.changes === "object") ? parsed.changes : {};
    if (Object.keys(changes).length === 0) return null;
    return {
      analysis: String(parsed.analysis || "").slice(0, 500),
      changes,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.5)),
      reason: String(parsed.reason || "").slice(0, 300),
    };
  } catch (e: any) {
    console.error("[ai-analyzer] askLLM failed:", e?.message ?? e);
    return null;
  }
}

let cycleInFlight = false;

export async function runCycle(reason: "auto" | "manual" = "auto"): Promise<{ scanned: number; suggested: number; skipped: number }> {
  if (cycleInFlight) return { scanned: 0, suggested: 0, skipped: 0 };
  cycleInFlight = true;
  const s = loadState();
  const startedAt = new Date().toISOString();
  try {
    const candidates = await findCandidateGates();
    let suggested = 0;
    let skipped = 0;
    const cap = Math.min(MAX_LLM_CALLS_PER_CYCLE, candidates.length);
    for (let i = 0; i < cap; i++) {
      const { gate, samples, failureRate } = candidates[i];
      // Skip if we already have a pending suggestion for this gate in the last 30 min
      const recentDup = s.suggestions.find(x =>
        x.gateId === gate.id &&
        x.status === "pending" &&
        Date.now() - new Date(x.createdAt).getTime() < 30 * 60_000
      );
      if (recentDup) { skipped++; continue; }
      const llm = await askLLM(gate, samples, failureRate);
      if (!llm) { skipped++; continue; }
      const suggestion: Suggestion = {
        id: `sug_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        gateId: gate.id,
        gateName: gate.name,
        createdAt: new Date().toISOString(),
        status: "pending",
        failureRate,
        sampleCount: samples.length,
        samples,
        ...llm,
      };
      s.suggestions.unshift(suggestion);
      suggested++;
    }
    trimSuggestions();
    s.lastRunAt = startedAt;
    s.lastRunStatus = `${reason === "manual" ? "manual " : ""}scanned ${candidates.length} candidates, ${suggested} new suggestions, ${skipped} skipped`;
    s.cycleCount++;
    saveState();
    await storage.createSystemLog({ level: "INFO", source: "ai-analyzer", message: s.lastRunStatus } as any).catch(() => {});
    return { scanned: candidates.length, suggested, skipped };
  } catch (e: any) {
    s.lastRunStatus = `error: ${e?.message ?? e}`;
    saveState();
    console.error("[ai-analyzer] cycle failed:", e?.message ?? e);
    return { scanned: 0, suggested: 0, skipped: 0 };
  } finally {
    cycleInFlight = false;
  }
}

// ── Background scheduling ────────────────────────────────────────────────────

export function startBackground(): void {
  if (intervalHandle) return;
  const s = loadState();
  if (!s.enabled) return;
  // Run once on startup, then every CYCLE_MS
  void runCycle("auto").catch(() => {});
  intervalHandle = setInterval(() => {
    const cur = loadState();
    if (!cur.enabled) { stopBackground(); return; }
    void runCycle("auto").catch(() => {});
  }, CYCLE_MS);
}

export function stopBackground(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/** Called from server/index.ts at boot. */
export function initAnalyzer(): void {
  const s = loadState();
  if (s.enabled) startBackground();
}
