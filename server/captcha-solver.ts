/**
 * Captcha solver — 2captcha / anticaptcha integration.
 *
 * Supports the three challenge types we encounter in payment flows:
 *  - Cloudflare Turnstile (sitekey + pageurl)
 *  - hCaptcha (sitekey + pageurl)
 *  - Google reCAPTCHA v2 (sitekey + pageurl)
 *
 * Reference: 2captcha API docs. Anticaptcha uses a different envelope but
 * the task/result loop is conceptually identical, so we share the polling.
 */

import { dbg } from "./stripe-checker";

export type CaptchaProvider = "2captcha" | "anticaptcha";
export type CaptchaType = "turnstile" | "hcaptcha" | "recaptcha";

export interface SolveOpts {
  provider: CaptchaProvider;
  apiKey: string;
  type: CaptchaType;
  sitekey: string;
  pageurl: string;
  /** Turnstile only — the action param the site requires (rarely set). */
  action?: string;
  /** Polling: how long to wait for a solution before giving up (ms). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes — typical solve takes 15–45s
const POLL_INTERVAL_MS = 5_000;

/** Solve a captcha challenge. Returns the token string, or null on failure/timeout. */
export async function solveCaptcha(opts: SolveOpts): Promise<string | null> {
  if (!opts.apiKey || !opts.sitekey || !opts.pageurl) return null;
  try {
    if (opts.provider === "2captcha") return await solve2captcha(opts);
    if (opts.provider === "anticaptcha") return await solveAnticaptcha(opts);
  } catch (e: any) {
    dbg(`[captcha] solver failed: ${e?.message ?? e}`);
  }
  return null;
}

// ─── 2captcha ────────────────────────────────────────────────────────────────

async function solve2captcha(opts: SolveOpts): Promise<string | null> {
  const method = opts.type === "turnstile" ? "turnstile"
              : opts.type === "hcaptcha"  ? "hcaptcha"
              : "userrecaptcha";

  const submitParams = new URLSearchParams({
    key: opts.apiKey,
    method,
    sitekey: opts.sitekey,
    pageurl: opts.pageurl,
    json: "1",
  });
  if (opts.action) submitParams.set("action", opts.action);

  const submitResp = await fetch(`https://2captcha.com/in.php?${submitParams.toString()}`, {
    signal: AbortSignal.timeout(15_000),
  });
  const submitJson: any = await submitResp.json();
  if (submitJson.status !== 1) {
    dbg(`[captcha] 2captcha submit error: ${submitJson.request}`);
    return null;
  }
  const taskId = submitJson.request;
  return await poll(
    async () => {
      const r = await fetch(`https://2captcha.com/res.php?key=${opts.apiKey}&action=get&id=${taskId}&json=1`, {
        signal: AbortSignal.timeout(15_000),
      });
      const j: any = await r.json();
      if (j.status === 1) return j.request as string;
      if (j.request !== "CAPCHA_NOT_READY") throw new Error(j.request);
      return null;
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}

// ─── Anticaptcha ─────────────────────────────────────────────────────────────

async function solveAnticaptcha(opts: SolveOpts): Promise<string | null> {
  const taskType =
    opts.type === "turnstile" ? "TurnstileTaskProxyless" :
    opts.type === "hcaptcha"  ? "HCaptchaTaskProxyless"  :
                                 "RecaptchaV2TaskProxyless";

  const createResp = await fetch("https://api.anti-captcha.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: opts.apiKey,
      task: {
        type: taskType,
        websiteURL: opts.pageurl,
        websiteKey: opts.sitekey,
        ...(opts.action ? { action: opts.action } : {}),
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const createJson: any = await createResp.json();
  if (createJson.errorId !== 0) {
    dbg(`[captcha] anticaptcha create error: ${createJson.errorDescription}`);
    return null;
  }
  const taskId = createJson.taskId;
  return await poll(
    async () => {
      const r = await fetch("https://api.anti-captcha.com/getTaskResult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: opts.apiKey, taskId }),
        signal: AbortSignal.timeout(15_000),
      });
      const j: any = await r.json();
      if (j.errorId !== 0) throw new Error(j.errorDescription);
      if (j.status === "ready") return (j.solution?.token || j.solution?.gRecaptchaResponse) as string;
      return null;
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}

// ─── Shared polling ──────────────────────────────────────────────────────────

async function poll<T>(check: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  // Initial wait — captcha services need ~10s before the first result check.
  await new Promise(r => setTimeout(r, 8_000));
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (e: any) {
      dbg(`[captcha] poll error: ${e?.message ?? e}`);
      return null;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  dbg(`[captcha] solve timed out after ${timeoutMs}ms`);
  return null;
}
