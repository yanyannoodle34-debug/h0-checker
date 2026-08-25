/**
 * Gate importer — turn an uploaded reference artifact into a gate config.
 *
 * Two input shapes are understood:
 *
 *   1. Python checker scripts (.py) — the kind shared in the scene: a module
 *      with classification key arrays (success_keys, declined_keys, …), a
 *      requests.Session() flow, a Stripe pk_ key, WordPress admin-ajax actions,
 *      charge/donate amounts, billing headers, etc.
 *
 *   2. Network captures (.json / .har) — a browser DevTools "Save all as HAR"
 *      export, or a raw JSON dump of requests. We walk the entries, find the
 *      payment-relevant calls (api.stripe.com, admin-ajax.php, paypal, …) and
 *      reconstruct the same fields.
 *
 * The output is a normalized {@link ParsedGate} preview that maps 1:1 onto the
 * gate_configs row shape ({ name, gateType, subType, url, settings }). The
 * dashboard shows it for review before the admin commits it.
 *
 * Pure parsing — no DB, no fetch, no side effects. Best-effort and defensive:
 * anything it can't determine is left undefined and noted in `warnings`.
 */

export interface ParsedGate {
  name: string;
  gateType: string;   // stripe | braintree | paypal | payeezy | unknown
  subType: string;
  url: string;
  settings: Record<string, any>;
  source: "python" | "har" | "json";
  confidence: number; // 0..1 — how sure we are this is usable as-is
  warnings: string[];
  /** Raw classification keys grouped by bucket, surfaced for the admin to review. */
  classification?: Record<string, string[]>;
}

// Hosts that are payment-processor infrastructure, never the merchant site.
const PROCESSOR_HOSTS = [
  "stripe.com", "js.stripe.com", "api.stripe.com", "m.stripe.com",
  "paypal.com", "paypalobjects.com", "braintreegateway.com", "braintree-api.com",
  "googleapis.com", "gstatic.com", "google.com", "googletagmanager.com",
  "google-analytics.com", "doubleclick.net", "facebook.com", "facebook.net",
  "cloudflare.com", "cloudflareinsights.com", "recaptcha.net", "hcaptcha.com",
  "cdn.jsdelivr.net", "jquery.com", "fontawesome.com", "fonts.googleapis.com",
  "payeezy.com", "firstdata.com", "firstdataglobalgateway.com",
];

function hostname(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

function isProcessorHost(host: string): boolean {
  return PROCESSOR_HOSTS.some(p => host === p || host.endsWith("." + p));
}

function stripUrl(u: string): string {
  return u.replace(/\/+$/, "");
}

/** Pull a `pk_live_…` / `pk_test_…` Stripe publishable key from any text blob. */
function findStripeKey(text: string): string | undefined {
  const m = text.match(/pk_(?:live|test)_[A-Za-z0-9]{20,}/);
  return m ? m[0] : undefined;
}

/** First non-processor https origin we can find — that's the merchant site. */
function findSiteUrl(urls: string[]): string | undefined {
  for (const u of urls) {
    const h = hostname(u);
    if (h && !isProcessorHost(h)) {
      return stripUrl(`https://${h}`);
    }
  }
  return undefined;
}

/** Extract every absolute https URL from a text blob. */
function findUrls(text: string): string[] {
  const out: string[] = [];
  const re = /https?:\/\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+/g;
  for (const m of text.matchAll(re)) {
    // The char class is permissive enough to swallow the trailing quote/comma/
    // paren/brace that surrounds a URL in source code (e.g. 'https://x.com',).
    // Trim those so the hostname parses cleanly and processor-host detection
    // (endsWith "stripe.com") isn't defeated by a stray "'," suffix.
    const cleaned = m[0].replace(/['"`),;}\]>]+$/, "");
    if (cleaned) out.push(cleaned);
  }
  return out;
}

/** Parse a Python list literal `name = ["a", "b", ...]` into string[]. */
function parsePyList(text: string, varName: string): string[] {
  // Match `varName = [ ... ]` allowing single or double quotes, multi-line.
  const re = new RegExp(`${varName}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m");
  const m = text.match(re);
  if (!m) return [];
  const body = m[1];
  const items: string[] = [];
  const itemRe = /(['"])((?:\\.|(?!\1).)*)\1/g;
  for (const im of body.matchAll(itemRe)) {
    const v = im[2].replace(/\\(['"\\])/g, "$1").trim();
    if (v) items.push(v);
  }
  return items;
}

const CLASS_KEY_VARS = [
  "success_keys", "ccn_keys", "cvv_keys", "otp_keys", "insufficient_keys",
  "expired_keys", "declined_keys", "invalid_keys", "incorrect_keys",
  "payment_failed_keys", "manycc_keys", "riskcc_keys", "cap_keys",
  "exceed_keys", "proxyfailed_keys",
];

// admin-ajax action → (gateType, subType) inference table.
function subTypeFromAction(action: string, paymentMode: string, hasStripe: boolean): { gateType: string; subType: string } {
  const a = action.toLowerCase();
  const pm = paymentMode.toLowerCase();
  if (pm.includes("paypal") || a.includes("paypal_commerce")) {
    // Detect GiveWP PayPal Commerce vs generic PayPal Commerce
    if (a.includes("give_paypal_commerce")) return { gateType: "paypal", subType: "givewp_commerce" };
    return { gateType: "paypal", subType: "paypal_commerce" };
  }
  if (a.includes("wp_full_stripe") || a.includes("inline_payment_charge") || a.includes("inline_donation_charge")) return { gateType: "stripe", subType: "wp_full_stripe" };
  if (a.includes("gfstripe") || a.includes("gravity")) return { gateType: "stripe", subType: "gravityforms" };
  if (a.includes("give_process_donation") || a.includes("give_recurring") || a.includes("give_")) {
    return { gateType: "stripe", subType: "givewp" };
  }
  if (a.includes("charitable")) return { gateType: "stripe", subType: "charitable" };
  if (a.includes("create_setup_intent") || a.includes("confirm_setup_intent") || a.includes("wc_stripe")) {
    return { gateType: "stripe", subType: "standard" };
  }
  if (hasStripe) return { gateType: "stripe", subType: "charges" };
  return { gateType: "unknown", subType: "standard" };
}

/** Look for the admin-ajax `action=` parameter in a script / payload blob. */
function findAjaxAction(text: string): string {
  // Form-encoded `action=foo` or python dict `'action': 'foo'`.
  const m1 = text.match(/['"]action['"]\s*:\s*['"]([a-z0-9_]+)['"]/i);
  if (m1) return m1[1];
  const m2 = text.match(/[?&]action=([a-z0-9_]+)/i);
  if (m2) return m2[1];
  const m3 = text.match(/action=([a-z0-9_%]+)/i);
  if (m3) return decodeURIComponent(m3[1]);
  return "";
}

function findPaymentMode(text: string): string {
  // Python dict / URL param with quotes (py scripts)
  const m = text.match(/payment-mode['"]?\s*[:=]\s*\(?\s*(?:None\s*,\s*)?['"]([a-z0-9_-]+)['"]/i)
        || text.match(/give-gateway['"]?\s*[:=]\s*\(?\s*(?:None\s*,\s*)?['"]([a-z0-9_-]+)['"]/i)
        // URL-encoded POST body captured in HAR (no quotes)
        || text.match(/(?:^|&|\?)payment-mode=([a-z0-9_-]+)/i)
        || text.match(/(?:^|&|\?)give-gateway=([a-z0-9_-]+)/i);
  return m ? m[1] : "";
}

/** Sniff a charge/donation amount from common field names. */
function findAmount(text: string): string | undefined {
  const patterns = [
    /custom-amount-unique[=:'\s"]+\$?([0-9]+\.[0-9]{2})/i,
    /give-amount['"]?\s*[:=]\s*\(?\s*(?:None\s*,\s*)?['"]?\$?([0-9]+\.[0-9]{2})/i,
    /charge_amount\s*=\s*['"]\$?([0-9]+\.[0-9]{2})/i,
    /\bamount['"]?\s*[:=]\s*['"]?\$?([0-9]+\.[0-9]{2})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return undefined;
}

function findGiveFormId(text: string): string | undefined {
  const m = text.match(/give-form-id['"]?\s*[:=]\s*\(?\s*(?:None\s*,\s*)?['"]?([0-9]+)/i)
        || text.match(/give-price-id['"]?\s*[:=]\s*\(?\s*(?:None\s*,\s*)?['"]?([0-9]+)/i);
  return m ? m[1] : undefined;
}

function detectProcessor(text: string): string {
  if (/braintreegateway|braintree-api|braintree-sdk|btClientToken|client_token/i.test(text)) {
    // PayPal Commerce uses braintree assets but is really paypal — only call it
    // braintree if there's no paypal-commerce signal.
    if (!/paypal[-_]commerce|cors\.api\.paypal\.com/i.test(text)) return "braintree";
  }
  if (/paypal[-_]commerce|cors\.api\.paypal\.com|paypal\.com\/v2\/checkout/i.test(text)) return "paypal";
  if (/payeezy|firstdata|globalgateway/i.test(text)) return "payeezy";
  if (/api\.stripe\.com|pk_(?:live|test)_|js\.stripe\.com/i.test(text)) return "stripe";
  return "unknown";
}

// ── Python script parser ─────────────────────────────────────────────────────

function parsePython(filename: string, content: string): ParsedGate {
  const warnings: string[] = [];

  // Classification keys
  const classification: Record<string, string[]> = {};
  for (const v of CLASS_KEY_VARS) {
    const list = parsePyList(content, v);
    if (list.length) classification[v] = list;
  }

  const urls = findUrls(content);
  const siteUrl = findSiteUrl(urls);
  if (!siteUrl) warnings.push("Could not determine the merchant site URL — set it manually.");

  const publicKey = findStripeKey(content);
  const action = findAjaxAction(content);
  const paymentMode = findPaymentMode(content);
  const processor = detectProcessor(content);

  let { gateType, subType } = subTypeFromAction(action, paymentMode, !!publicKey);
  if (processor !== "unknown" && gateType === "unknown") gateType = processor;
  // A paypal-commerce / braintree processor signal overrides a stripe guess
  // that came purely from a leftover js.stripe.com asset reference.
  if (processor === "paypal") { gateType = "paypal"; subType = subType === "standard" ? "paypal_commerce" : subType; }
  if (processor === "braintree") { gateType = "braintree"; subType = "standard"; }
  if (processor === "payeezy") { gateType = "payeezy"; subType = "standard"; }

  if (gateType === "stripe" && !publicKey) {
    warnings.push("Stripe gate but no pk_ publishable key found — the Stripe flow needs one.");
  }

  const amount = findAmount(content);
  const giveFormId = findGiveFormId(content);

  // Map classification buckets onto the override fields the checker consumes.
  const liveOverrides = [...(classification.success_keys || [])];
  const deadOverrides = [
    ...(classification.declined_keys || []),
    ...(classification.expired_keys || []),
    ...(classification.invalid_keys || []),
    ...(classification.incorrect_keys || []),
    ...(classification.payment_failed_keys || []),
  ];

  const settings: Record<string, any> = {
    siteUrl,
    autoDetected: true,
    importedFrom: filename,
    importedAt: new Date().toISOString(),
  };
  if (publicKey) settings.publicKey = publicKey;
  if (amount) {
    settings.chargeAmount = amount;
    if (subType === "givewp" || subType === "charitable") settings.donateAmount = amount;
  }
  if (giveFormId) settings.giveFormId = giveFormId;
  if (action) settings.ajaxAction = action;
  if (paymentMode) settings.paymentMode = paymentMode;
  if (liveOverrides.length) settings.liveOverrides = liveOverrides;
  if (deadOverrides.length) settings.deadOverrides = deadOverrides;
  // Stash the full classification map for reference / future tuning.
  if (Object.keys(classification).length) settings.classificationKeys = classification;

  // Confidence: we want a site URL + a gate type + (a key OR a paypal/processor flow).
  let confidence = 0;
  if (siteUrl) confidence += 0.4;
  if (gateType !== "unknown") confidence += 0.3;
  if (publicKey || gateType === "paypal" || gateType === "payeezy") confidence += 0.2;
  if (Object.keys(classification).length) confidence += 0.1;

  const name = siteUrl
    ? `${gateType.toUpperCase()}-${hostname(siteUrl).replace(/^www\./, "").toUpperCase()}`
    : (filename.replace(/\.py$/i, "").toUpperCase() || "IMPORTED-GATE");

  return {
    name, gateType, subType,
    url: siteUrl || "",
    settings,
    source: "python",
    confidence: Math.min(1, Math.round(confidence * 100) / 100),
    warnings,
    classification,
  };
}

// ── Network capture (HAR / JSON) parser ──────────────────────────────────────

interface HarEntry {
  request?: { method?: string; url?: string; headers?: { name: string; value: string }[]; postData?: { text?: string; params?: { name: string; value: string }[] }; cookies?: { name: string; value: string }[] };
  response?: { content?: { text?: string }; status?: number };
}

function harEntries(parsed: any): HarEntry[] {
  if (parsed?.log?.entries && Array.isArray(parsed.log.entries)) return parsed.log.entries;
  if (Array.isArray(parsed?.entries)) return parsed.entries;
  if (Array.isArray(parsed)) return parsed; // bare array of request objects
  return [];
}

function headerVal(entry: HarEntry, name: string): string | undefined {
  const h = entry.request?.headers?.find(x => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value;
}

function parseNetworkCapture(filename: string, content: string): ParsedGate {
  const warnings: string[] = [];
  let parsed: any;
  try { parsed = JSON.parse(content); }
  catch {
    warnings.push("File is not valid JSON — falling back to raw text scan.");
    return rawTextFallback(filename, content, warnings);
  }

  const entries = harEntries(parsed);
  if (!entries.length) {
    warnings.push("No HAR entries found — scanning the raw JSON text instead.");
    return rawTextFallback(filename, content, warnings);
  }

  // Collect all URLs + a combined text blob of payment-relevant request bodies.
  const allUrls: string[] = [];
  let publicKey: string | undefined;
  let action = "";
  let paymentMode = "";
  let amount: string | undefined;
  let giveFormId: string | undefined;
  const cookieNames = new Set<string>();
  const extraHeaders: Record<string, string> = {};
  let bodyBlob = "";
  const origins: string[] = [];

  for (const e of entries) {
    const url = e.request?.url || "";
    if (url) allUrls.push(url);
    const host = hostname(url);
    const isPaymentCall =
      host.includes("stripe.com") || host.includes("paypal.com") ||
      host.includes("braintree") || url.includes("admin-ajax.php") ||
      url.includes("/wc-ajax") || url.includes("checkout") || url.includes("payeezy");

    const origin = headerVal(e, "origin") || headerVal(e, "referer");
    if (origin) origins.push(origin);

    if (!isPaymentCall) continue;

    const postText = e.request?.postData?.text
      || (e.request?.postData?.params || []).map(p => `${p.name}=${p.value}`).join("&")
      || "";
    if (postText) bodyBlob += "\n" + postText;

    if (!publicKey) publicKey = findStripeKey(postText) || findStripeKey(url);
    if (!action) action = findAjaxAction(postText) || findAjaxAction(url);
    if (!paymentMode) paymentMode = findPaymentMode(postText);
    if (!amount) amount = findAmount(postText);
    if (!giveFormId) giveFormId = findGiveFormId(postText);

    for (const c of e.request?.cookies || []) if (c.name) cookieNames.add(c.name);
    // Capture a couple of non-default headers that gates sometimes need.
    for (const hn of ["x-wp-nonce", "x-requested-with"]) {
      const v = headerVal(e, hn);
      if (v) extraHeaders[hn] = v;
    }
  }

  // Site URL: prefer a non-processor origin header, else any non-processor URL.
  const siteUrl = findSiteUrl(origins) || findSiteUrl(allUrls);
  if (!siteUrl) warnings.push("Could not determine the merchant site URL — set it manually.");

  const combinedText = bodyBlob + "\n" + allUrls.join("\n") + "\n" + origins.join("\n");
  const processor = detectProcessor(combinedText);
  let { gateType, subType } = subTypeFromAction(action, paymentMode, !!publicKey);
  if (processor !== "unknown" && gateType === "unknown") gateType = processor;
  if (processor === "paypal") { gateType = "paypal"; subType = subType === "standard" ? "paypal_commerce" : subType; }
  if (processor === "braintree") { gateType = "braintree"; subType = "standard"; }
  if (processor === "payeezy") { gateType = "payeezy"; subType = "standard"; }

  const settings: Record<string, any> = {
    siteUrl,
    autoDetected: true,
    importedFrom: filename,
    importedAt: new Date().toISOString(),
  };
  if (publicKey) settings.publicKey = publicKey;
  if (amount) {
    settings.chargeAmount = amount;
    if (subType === "givewp" || subType === "charitable") settings.donateAmount = amount;
  }
  if (giveFormId) settings.giveFormId = giveFormId;
  if (action) settings.ajaxAction = action;
  if (paymentMode) settings.paymentMode = paymentMode;
  if (cookieNames.size) settings.observedCookies = [...cookieNames];
  if (Object.keys(extraHeaders).length) settings.observedHeaders = extraHeaders;

  let confidence = 0;
  if (siteUrl) confidence += 0.4;
  if (gateType !== "unknown") confidence += 0.3;
  if (publicKey || gateType === "paypal" || gateType === "payeezy") confidence += 0.2;
  if (amount) confidence += 0.1;
  if (gateType === "stripe" && !publicKey) {
    warnings.push("Stripe flow detected but no pk_ key was captured — add the publishable key manually.");
  }

  const name = siteUrl
    ? `${gateType.toUpperCase()}-${hostname(siteUrl).replace(/^www\./, "").toUpperCase()}`
    : (filename.replace(/\.(har|json)$/i, "").toUpperCase() || "IMPORTED-GATE");

  return {
    name, gateType, subType,
    url: siteUrl || "",
    settings,
    source: filename.toLowerCase().endsWith(".har") ? "har" : "json",
    confidence: Math.min(1, Math.round(confidence * 100) / 100),
    warnings,
  };
}

/** When JSON structure is unusable, treat the file as one big text blob. */
function rawTextFallback(filename: string, content: string, warnings: string[]): ParsedGate {
  const urls = findUrls(content);
  const siteUrl = findSiteUrl(urls);
  const publicKey = findStripeKey(content);
  const action = findAjaxAction(content);
  const paymentMode = findPaymentMode(content);
  const processor = detectProcessor(content);
  let { gateType, subType } = subTypeFromAction(action, paymentMode, !!publicKey);
  if (processor !== "unknown" && gateType === "unknown") gateType = processor;
  if (processor === "paypal") { gateType = "paypal"; subType = "standard"; }

  const settings: Record<string, any> = { siteUrl, autoDetected: true, importedFrom: filename };
  if (publicKey) settings.publicKey = publicKey;
  const amount = findAmount(content);
  if (amount) settings.chargeAmount = amount;
  if (action) settings.ajaxAction = action;

  let confidence = 0;
  if (siteUrl) confidence += 0.4;
  if (gateType !== "unknown") confidence += 0.3;
  if (publicKey) confidence += 0.2;

  return {
    name: siteUrl ? `${gateType.toUpperCase()}-${hostname(siteUrl).replace(/^www\./, "").toUpperCase()}` : "IMPORTED-GATE",
    gateType, subType, url: siteUrl || "", settings,
    source: "json", confidence: Math.min(1, confidence), warnings,
  };
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Parse an uploaded artifact into a gate preview.
 * @param filename used only for type detection (.py vs .json/.har) and naming.
 * @param content  the file's text content.
 */
export function parseGateSource(filename: string, content: string): ParsedGate {
  const lower = (filename || "").toLowerCase();
  if (!content || !content.trim()) {
    return {
      name: "IMPORTED-GATE", gateType: "unknown", subType: "standard", url: "",
      settings: {}, source: "python", confidence: 0,
      warnings: ["File is empty."],
    };
  }
  if (lower.endsWith(".json") || lower.endsWith(".har")) {
    return parseNetworkCapture(filename, content);
  }
  if (lower.endsWith(".py")) {
    return parsePython(filename, content);
  }
  // Unknown extension — sniff content: JSON-ish → capture, else python.
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseNetworkCapture(filename || "capture.json", content);
  }
  return parsePython(filename || "gate.py", content);
}
