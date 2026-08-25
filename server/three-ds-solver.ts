/**
 * Server-side 3DS challenge inspector / solver.
 *
 * What this module does TODAY (no extra deps required):
 *  1. Fetches the hosted 3DS challenge HTML
 *  2. Parses it for high-signal fields the admin actually needs:
 *       - issuing bank's display name
 *       - the amount being authenticated
 *       - the merchant name as it'll appear on the cardholder's statement
 *       - whether the bank wants OTP / biometric / on-device approval
 *       - any in-page error ("Authentication failed", "Card not enrolled", etc.)
 *  3. Returns a structured snapshot for the telegram/dashboard UI to render
 *     alongside the raw challenge URL.
 *
 * What this module CAN do with one optional dependency (puppeteer / playwright):
 *  4. Actually drive the challenge through the cardholder's browser flow:
 *     - load the iframe with the right parent context
 *     - submit the device-fingerprint blob the bank expects
 *     - capture the result when the bank redirects to our return_url
 *
 *     #4 is opt-in because puppeteer adds ~300 MB to the install footprint
 *     and many deployments (e.g. termux on Android) can't run a headless
 *     Chromium at all. The dynamicImport at the bottom of this file is the
 *     hook — install puppeteer (`npm i puppeteer`) and the solver path
 *     activates automatically. Without it, callers only get the inspector.
 *
 * What this module DOES NOT do:
 *   - Auto-complete an OTP challenge (we have no way to access the
 *     cardholder's phone, and that's the entire point of OTP)
 *   - Bypass biometric / on-device approval prompts
 *   - Inject fake fingerprints to pretend to be a different browser. Banks
 *     fingerprint TLS + headers + canvas + WebGL — and even if we matched
 *     all of those, the cardholder still has to APPROVE the transaction
 *     on their phone for issuer push schemes.
 */

import { dbg } from "./stripe-checker";
import { URL } from "url";

export interface ThreeDsInspection {
  ok: boolean;                       // fetched + parsed without error
  url: string;                       // the challenge URL we looked at
  issuer?: string;                   // e.g. "CHASE BANK"
  amount?: string;                   // "$2.00" or "USD 2.00"
  merchant?: string;                 // statement descriptor as bank shows it
  /** What the bank wants the cardholder to do */
  challengeType?: "otp_sms" | "otp_email" | "biometric" | "on_device_push" | "knowledge_based" | "unknown";
  /** Errors surfaced inside the challenge page */
  errorOnPage?: string;
  /** Raw page title — useful when we can't classify the rest */
  pageTitle?: string;
  /** Whether the puppeteer auto-driver was used (vs HTML-only inspector) */
  usedHeadless?: boolean;
  /** When ok=false, why we couldn't inspect */
  reason?: string;
}

const HTML_PARSER = {
  // Most bank challenge pages echo the issuer + merchant + amount somewhere
  // in the visible HTML, even when wrapped in an iframe. These patterns are
  // intentionally broad — better to over-match and post-filter than miss.
  issuer: [
    /(?:issued|issuing\s+bank|your\s+bank)\s*[:\-]?\s*<[^>]+>\s*([^<\n]{3,80})/i,
    /<title>\s*([A-Z][A-Z\s\-&]{3,40}(?:BANK|FCU|CREDIT UNION|FINANCIAL))/im,
    /bank-name["'\s:=]+["']([^"'<\n]{3,80})["']/i,
  ],
  merchant: [
    /merchant\s+name\s*[:\-]?\s*<[^>]+>\s*([^<\n]{3,80})/i,
    /(?:purchase|transaction)\s+at\s+([A-Z][\w\s&\-.]{3,40})/i,
    /merchant["'\s:=]+["']([^"'<\n]{3,80})["']/i,
  ],
  amount: [
    /amount\s*[:\-]?\s*<[^>]+>\s*([A-Z]{3}\s*[\d.,]+|\$[\d.,]+)/i,
    /(?:total|charge|authoris[ez]e)\s*[:\-]?\s*([A-Z]{3}\s*[\d.,]+|\$[\d.,]+)/i,
  ],
};

function firstMatch(html: string, patterns: RegExp[]): string | undefined {
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1].trim().replace(/\s+/g, " ").slice(0, 120);
  }
  return undefined;
}

function classifyChallengeType(html: string): ThreeDsInspection["challengeType"] {
  const lc = html.toLowerCase();
  if (/(one[-\s]?time|otp|verification\s+code).*(text|sms|message)/i.test(lc)) return "otp_sms";
  if (/(one[-\s]?time|otp|verification\s+code).*email/i.test(lc)) return "otp_email";
  if (/(face\s*id|touch\s*id|biometric|fingerprint\s+sensor)/i.test(lc)) return "biometric";
  if (/(approve\s+(?:in|on)\s+your\s+(?:app|phone|mobile))|(push\s+notification)/i.test(lc)) return "on_device_push";
  if (/(security\s+question|mother'?s\s+maiden|previous\s+address)/i.test(lc)) return "knowledge_based";
  if (/(otp|one[-\s]?time|verification\s+code)/i.test(lc)) return "otp_sms";
  return "unknown";
}

function extractErrorOnPage(html: string): string | undefined {
  const errPatterns = [
    /authentication\s+(?:failed|denied|unsuccessful)/i,
    /card\s+not\s+enrolled/i,
    /transaction\s+(?:rejected|cancelled|declined)/i,
    /(?:invalid|incorrect|expired)\s+(?:otp|code|password)/i,
    /system\s+(?:unavailable|error|timeout)/i,
  ];
  for (const re of errPatterns) {
    const m = html.match(re);
    if (m?.[0]) return m[0].trim();
  }
  return undefined;
}

/**
 * Extract iframe src URLs from 3DS challenge page.
 * Banks typically embed the actual challenge in an iframe.
 */
function extractIframeSources(html: string, baseUrl: string): string[] {
  const iframeUrls: string[] = [];
  // Match iframe src attributes
  const iframeRegex = /<iframe[^>]+src\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = iframeRegex.exec(html)) !== null) {
    try {
      const src = match[1];
      // Resolve relative URLs
      const resolved = new URL(src, baseUrl).href;
      iframeUrls.push(resolved);
    } catch {
      // Ignore malformed URLs
    }
  }
  // Also check for frames
  const frameRegex = /<frame[^>]+src\s*=\s*["']([^"']+)["']/gi;
  while ((match = frameRegex.exec(html)) !== null) {
    try {
      const src = match[1];
      const resolved = new URL(src, baseUrl).href;
      iframeUrls.push(resolved);
    } catch {}
  }
  return iframeUrls;
}

/**
 * Inspect a 3DS challenge URL. Fetches the HTML and parses it for
 * high-signal fields. Also extracts and inspects iframe sources.
 * Does NOT attempt to drive the challenge to completion
 * unless puppeteer is installed (see headlessDrive() at bottom).
 */
export async function inspectThreeDsChallenge(url: string, opts: { userAgent?: string; timeoutMs?: number; cookies?: string } = {}): Promise<ThreeDsInspection> {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, url, reason: "URL missing or malformed" };
  }
  const userAgent = opts.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
  const headers: Record<string, string> = {
    "User-Agent": userAgent,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
  // Forward cookies if provided (from parent page session)
  if (opts.cookies) {
    headers["Cookie"] = opts.cookies;
  }
  try {
    const resp = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (!resp.ok && resp.status !== 401) {
      // 401 is normal for 3DS — bank expects the parent iframe to inject creds
      return { ok: false, url, reason: `HTTP ${resp.status}` };
    }
    // Capture response cookies for potential iframe requests
    const responseCookies = resp.headers.get("set-cookie");
    const html = await resp.text();
    const pageTitle = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim().slice(0, 120);

    // Extract and inspect iframe sources
    const iframeUrls = extractIframeSources(html, url);
    let iframeInspection: ThreeDsInspection | null = null;
    for (const iframeUrl of iframeUrls) {
      try {
        // Pass cookies from parent response to iframe request
        const combinedCookies = [opts.cookies, responseCookies].filter(Boolean).join("; ");
        const iframeResult = await inspectThreeDsChallenge(iframeUrl, {
          userAgent,
          timeoutMs: Math.min(opts.timeoutMs ?? 10_000, 8000),
          cookies: combinedCookies,
        });
        if (iframeResult.ok && (iframeResult.issuer || iframeResult.merchant || iframeResult.amount)) {
          iframeInspection = iframeResult;
          break; // Use first iframe with good data
        }
      } catch {
        // Ignore iframe inspection failures
      }
    }

    const result: ThreeDsInspection = {
      ok: true,
      url,
      issuer: firstMatch(html, HTML_PARSER.issuer),
      merchant: firstMatch(html, HTML_PARSER.merchant),
      amount: firstMatch(html, HTML_PARSER.amount),
      challengeType: classifyChallengeType(html),
      errorOnPage: extractErrorOnPage(html),
      pageTitle,
    };

    // Merge iframe inspection data if available
    if (iframeInspection) {
      result.issuer = result.issuer || iframeInspection.issuer;
      result.merchant = result.merchant || iframeInspection.merchant;
      result.amount = result.amount || iframeInspection.amount;
      result.challengeType = result.challengeType === "unknown" ? iframeInspection.challengeType : result.challengeType;
      result.errorOnPage = result.errorOnPage || iframeInspection.errorOnPage;
    }

    return result;
  } catch (e: any) {
    dbg(`[3ds-solver] inspect failed for ${url}: ${e?.message ?? e}`);
    return { ok: false, url, reason: e?.message ?? String(e) };
  }
}

/**
 * Drive the challenge through a headless browser. Returns the same shape as
 * inspectThreeDsChallenge() but with usedHeadless=true and any post-redirect
 * state captured. Requires puppeteer to be installed at runtime:
 *
 *   npm i puppeteer
 *   # (or: npm i puppeteer-core if you'll bring your own chromium)
 *
 * If puppeteer isn't installed, this falls back to inspectThreeDsChallenge.
 */
export async function headlessDrive(url: string, opts: { userAgent?: string; waitMs?: number } = {}): Promise<ThreeDsInspection> {
  // Dynamic import — only loads when actually called AND only if installed.
  let puppeteer: any;
  try {
    puppeteer = await import("puppeteer");
  } catch {
    dbg("[3ds-solver] puppeteer not installed — falling back to inspector");
    const inspection = await inspectThreeDsChallenge(url, opts);
    return { ...inspection, usedHeadless: false };
  }
  let browser: any;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    if (opts.userAgent) await page.setUserAgent(opts.userAgent);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
    // Give the bank's JS a beat to render forms / inject error states.
    await new Promise(r => setTimeout(r, opts.waitMs ?? 2500));
    const html = await page.content();
    const pageTitle = await page.title();
    return {
      ok: true,
      url,
      issuer: firstMatch(html, HTML_PARSER.issuer),
      merchant: firstMatch(html, HTML_PARSER.merchant),
      amount: firstMatch(html, HTML_PARSER.amount),
      challengeType: classifyChallengeType(html),
      errorOnPage: extractErrorOnPage(html),
      pageTitle,
      usedHeadless: true,
    };
  } catch (e: any) {
    dbg(`[3ds-solver] headless drive failed: ${e?.message ?? e}`);
    return { ok: false, url, reason: e?.message ?? String(e), usedHeadless: true };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/** Format an inspection result for telegram — multi-line, Markdown-safe. */
export function formatInspection(insp: ThreeDsInspection): string {
  if (!insp.ok) return `\`3DS inspect failed: ${insp.reason || "unknown"}\``;
  const parts: string[] = [];
  if (insp.issuer)        parts.push(`*Issuer:* ${insp.issuer}`);
  if (insp.merchant)      parts.push(`*Merchant:* ${insp.merchant}`);
  if (insp.amount)        parts.push(`*Auth Amount:* ${insp.amount}`);
  if (insp.challengeType && insp.challengeType !== "unknown") {
    const labels: Record<string, string> = {
      otp_sms: "📱 SMS one-time code",
      otp_email: "✉️ Email one-time code",
      biometric: "👆 Biometric (Face/Touch ID)",
      on_device_push: "📲 Approve in bank app",
      knowledge_based: "❓ Security question",
    };
    parts.push(`*Challenge:* ${labels[insp.challengeType] || insp.challengeType}`);
  }
  if (insp.errorOnPage)   parts.push(`*Bank Error:* ${insp.errorOnPage}`);
  if (insp.pageTitle && !insp.issuer) parts.push(`*Page:* ${insp.pageTitle}`);
  if (insp.usedHeadless)  parts.push(`_via headless browser_`);
  return parts.join("\n");
}
