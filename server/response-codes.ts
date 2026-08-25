export type ClassificationStatus = "live" | "dead" | "error";

export interface ClassifiedResponse {
  status: ClassificationStatus;
  response: string;
  code: string;
}

// ─── Decline categories (shared by browser-hitter, stripe-hitter, checker) ────

export type DeclineCategory = "hard" | "soft" | "none";

/** Hard declines — card is dead, no point retrying */
export const HARD_DECLINE_CODES = new Set([
  "expired_card", "incorrect_number", "invalid_number", "lost_card",
  "stolen_card", "fraudulent", "pickup_card", "restricted_card",
  "security_violation", "service_not_allowed", "transaction_not_allowed",
  "card_not_supported", "invalid_account", "new_account_information_available",
]);

/** Soft declines — card may be valid, worth retrying or routing differently */
export const SOFT_DECLINE_CODES = new Set([
  "insufficient_funds", "do_not_honor", "call_issuer", "generic_decline",
  "try_again_later", "not_permitted", "card_velocity_exceeded",
  "incorrect_cvc", "invalid_cvc", "authentication_required",
  "approve_with_id", "issuer_not_available", "processing_error",
  "reenter_transaction", "no_action_taken",
]);

/** Errors that are transient and worth retrying immediately */
export const RETRYABLE_ERRORS = new Set([
  "generic_decline", "try_again_later", "processing_error",
  "issuer_not_available", "reenter_transaction", "no_action_taken",
]);

/** Session/nonce errors that require page refresh and retry — NOT a card decline */
export const SESSION_ERRORS = new Set([
  "unable to recognize your session",
  "refresh the screen to try again",
  "refresh the page",
  "refresh and try again",
  "session expired",
  "session has expired",
  "nonce verification failed",
  "give_error_donation_form_nonce",
  "nonce error",
  "invalid nonce",
  "stale nonce",
  "csrf token",
  "csrf verification",
  "token expired",
  "form expired",
]);

/** Check if response indicates a session/nonce error (not a card decline) */
export function isSessionError(response: string): boolean {
  const lc = response.toLowerCase();
  for (const err of SESSION_ERRORS) {
    if (lc.includes(err.toLowerCase())) return true;
  }
  return false;
}

/** Classify a Stripe decline code into hard/soft/none */
export function classifyDecline(code: string): DeclineCategory {
  if (HARD_DECLINE_CODES.has(code)) return "hard";
  if (SOFT_DECLINE_CODES.has(code)) return "soft";
  return "none";
}

/** Check if a HitResult is worth retrying */
export function isRetryableError(status: string, response: string): boolean {
  if (status === "error" && response.includes("rate_limit")) return true;
  if (status === "approved" && response.includes("captcha session")) return false;
  if (status === "error" && response.includes("An error has occurred")) return true;
  if (isSessionError(response)) return true; // Session/nonce errors are always retryable
  if (status === "declined") {
    for (const code of RETRYABLE_ERRORS) {
      if (response.includes(code)) return true;
    }
  }
  return false;
}

// ─── Stripe ───────────────────────────────────────────────────────────────────

/** Stripe decline codes that indicate the card is LIVE (valid, just can't charge now) */
const STRIPE_LIVE_CODES = new Set([
  "insufficient_funds",
  "do_not_honor",
  "generic_decline",
  "call_issuer",
  "try_again_later",
  "not_permitted",
  "service_not_allowed",
  "transaction_not_allowed",
  "card_velocity_exceeded",
  "withdrawal_count_limit_exceeded",
  "online_or_offline_pin_required",
  "approve_with_id",
  "issuer_not_available",
  "reenter_transaction",
  "new_account_information_available",
]);

/** Stripe codes that mean the card is definitively dead / unusable */
const STRIPE_DEAD_CODES = new Set([
  "expired_card",
  "incorrect_number",
  "invalid_number",
  "invalid_expiry_month",
  "invalid_expiry_year",
  "invalid_cvc",
  "incorrect_cvc",
  "lost_card",
  "stolen_card",
  "pickup_card",
  "restricted_card",
  "fraudulent",
  "merchant_blacklist",
  "security_violation",
  "invalid_account",
  "testmode_decline",
  "card_not_supported",
  "currency_not_supported",
  "no_action_taken",
  "revocation_of_authorization",
  "revocation_of_all_authorizations",
]);

// ─── Braintree ────────────────────────────────────────────────────────────────

const BRAINTREE_LIVE_CODES = new Set(["1000", "1001", "1002", "1003"]);

// Full Braintree processor response table from reference braintree_gate.py.
// "live" = card is valid, just couldn't charge (insufficient funds, CVV/AVS mismatch, etc.)
// Everything else (including unlisted 2xxx codes) defaults to "dead".
const BRAINTREE_LIVE_RESPONSE_CODES = new Set([
  "2001", // Insufficient Funds
  "2002", // Limit Exceeded
  "2003", // Cardholder Activity Limit Exceeded
  "2010", // CVV Mismatch
  "2061", // AVS Mismatch
  "2069", // PayPal Pending Payment
  "2079", // PayPal Needs Consent
  "2090", // AVS Address Required
]);

const BRAINTREE_DEAD_RESPONSE_CODES = new Set([
  // 2000–2068 (declined buckets excluding live ones above)
  "2000","2004","2005","2006","2007","2008","2009","2011","2012","2013","2014","2015",
  "2016","2017","2018","2019","2020","2021","2022","2023","2024","2025","2026","2027",
  "2028","2029","2030","2031","2032","2033","2034","2035","2036","2037","2038","2039",
  "2040","2041","2042","2043","2044","2045","2046","2047","2048","2049","2050","2051",
  "2053","2054","2055","2056","2057","2058","2059","2060","2062","2063","2064","2065",
  "2066","2067","2068",
  // 2070–2093 PayPal / late codes
  "2070","2071","2072","2073","2074","2075","2076","2077","2078","2080","2081","2082",
  "2083","2084","2085","2086","2087","2088","2089","2091","2092","2093",
  // Validation errors (Braintree client API)
  "81706","81707","81709","81710","81714","81725",
]);

// Human-readable labels for the most common codes — used to format detail strings.
const BRAINTREE_CODE_LABELS: Record<string, string> = {
  "2000": "Do Not Honor",
  "2001": "Insufficient Funds (Live)",
  "2002": "Limit Exceeded (Live)",
  "2003": "Activity Limit (Live)",
  "2004": "Expired Card",
  "2005": "Invalid Card Number",
  "2006": "Invalid Expiry",
  "2009": "No Such Issuer",
  "2010": "CVV Mismatch (Live)",
  "2015": "Transaction Not Allowed",
  "2019": "Invalid Transaction",
  "2024": "Card Type Not Enabled",
  "2046": "Declined",
  "2047": "Call Issuer",
  "2053": "Card Reported Stolen",
  "2054": "Card Reported Lost",
  "2057": "Issuer/Cardholder Declined",
  "2059": "Suspected Fraud",
  "2061": "AVS Mismatch (Live)",
  "2065": "Withdrawal Limit Exceeded",
  "2067": "Hard Decline - No Retry",
  "2069": "PayPal Pending (Live)",
  "2079": "PayPal Needs Consent (Live)",
  "2090": "AVS Address Required (Live)",
  "81706": "Invalid CVV",
  "81707": "CVV Required",
  "81709": "Invalid Expiry Month",
  "81710": "Invalid Expiry Year",
  "81714": "Card Already Expired",
  "81725": "Invalid Card Number",
};

export function braintreeCodeLabel(code: string): string | undefined {
  return BRAINTREE_CODE_LABELS[code];
}

// ─── PayPal ───────────────────────────────────────────────────────────────────

const PAYPAL_LIVE_KEYWORDS = [
  "completed", "pending", "created", "approved", "payer_action_required",
  "paypal_requires_action", "VERIFIED",
];

const PAYPAL_DEAD_KEYWORDS = [
  "declined_by_paypal_risk", "transaction_refused_by_paypal_risk",
  "credit_card_refused", "expired_credit_card", "invalid_csc",
  "card_type_not_supported", "declined", "refused", "failed",
  "instrument_declined", "insufficient_funds",
  "PAYMENT_NOT_APPROVED_FOR_EXECUTION", "invalid_cvv2",
];

// ─── Square ───────────────────────────────────────────────────────────────────

const SQUARE_LIVE_KEYWORDS = [
  "APPROVED", "COMPLETED", "AUTHORIZED",
];

const SQUARE_LIVE_CODES = new Set([
  "OK", "PAYMENT_BRAND_NOT_SUPPORTED", // soft decline (card valid)
]);

const SQUARE_DEAD_KEYWORDS = [
  "INSUFFICIENT_FUNDS", "CARD_NOT_SUPPORTED", "CARD_DECLINED",
  "CARD_EXPIRED", "INVALID_CVC", "ADDRESS_VERIFICATION_FAILURE",
  "INVALID_ACCOUNT", "VOICE_FAILURE", "INVALID_POSTAL_CODE",
  "CVV_FAILURE", "BANNED_CARD",
];

// ─── Authorize.net ────────────────────────────────────────────────────────────

// Authorize.net response codes: 1=approved, 2=declined, 3=error, 4=held
const AUTHORIZE_NET_LIVE_REASON_CODES = new Set([
  "1",   // Approved
  "4",   // Held for Review (card is valid)
  "252", // The transaction was accepted but is being held for merchant review
  "253", // approved but held
]);

const AUTHORIZE_NET_LIVE_TEXT = [
  "this transaction has been approved",
  "held for review",
  "approved",
];

const AUTHORIZE_NET_DEAD_TEXT = [
  "this transaction has been declined",
  "the credit card number is invalid",
  "the credit card has expired",
  "the card code is invalid",
  "stolen/lost card",
  "do not honor",
  "insufficient funds",
];

// ─── Adyen ────────────────────────────────────────────────────────────────────

const ADYEN_LIVE_CODES = new Set([
  "Authorised", "ChallengeShopper", "IdentifyShopper",
  "PresentToShopper", "Pending", "Received",
]);

const ADYEN_DEAD_CODES = new Set([
  "Refused", "Cancelled", "Blocked", "Error",
]);

// Adyen refusal reason codes — live means card is valid
const ADYEN_LIVE_REFUSAL = new Set([
  "Declined", "Issuer Unavailable", "Insufficient Funds",
  "Not enough balance", "Acquirer Fraud", "Request Blocked",
  "Not Submitted", "Shopper Cancelled",
]);

// ─── Worldpay ────────────────────────────────────────────────────────────────

const WORLDPAY_LIVE_CODES = new Set([
  "AUTHORISED", "SENT_FOR_AUTHORISATION",
  "AWAITING_AUTHORISATION", "CAPTURED",
]);

const WORLDPAY_DEAD_CODES = new Set([
  "REFUSED", "CANCELLED", "FAILED", "ERROR", "EXPIRED",
  "SETTLED_BY_MERCHANT", // edge case
]);

const WORLDPAY_LIVE_REASON = [
  "do not honour", "insufficient funds", "unable to go online",
  "not sufficient funds", "exceeds withdrawal frequency limit",
];

// ─── Checkout.com ─────────────────────────────────────────────────────────────

const CHECKOUT_LIVE_STATUS = new Set([
  "Authorized", "Pending", "Card Verified",
]);

const CHECKOUT_DEAD_STATUS = new Set([
  "Declined", "Expired", "Blocked", "Cancelled", "Voided",
]);

const CHECKOUT_LIVE_RESPONSE = new Set([
  "10000", // Approved
  "10100", // Flagged
  "10200", // Pending
]);

// ─── Klarna ───────────────────────────────────────────────────────────────────

const KLARNA_LIVE = ["ACCEPTED", "PENDING", "AUTHORIZED", "approved"];
const KLARNA_DEAD = ["REJECTED", "CANCELLED", "CLOSED", "declined", "failed"];

// ─── 2Checkout ────────────────────────────────────────────────────────────────

const TWOCHECKOUT_LIVE = ["approved", "pending", "PAYMENT_APPROVED", "COMPLETE"];
const TWOCHECKOUT_DEAD = ["declined", "failed", "PAYMENT_DECLINED", "NOT_AUTHORIZED"];

// ─── Generic keyword matching ─────────────────────────────────────────────────

const GENERIC_LIVE_KEYWORDS = [
  "approved", "success", "succeeded", "authorized", "authorised",
  "captured", "charged", "accepted", "completed", "valid",
  "cvv match", "cvv live", "ccn live", "live",
];

const GENERIC_DEAD_KEYWORDS = [
  "declined", "refused", "rejected", "invalid", "expired",
  "stolen", "lost", "blocked", "failed", "error", "dead",
  "do not honor", "do not honour", "insufficient", "not permitted",
];

// ─── Main classifier ─────────────────────────────────────────────────────────

export function classifyResponse(
  gateType: string,
  rawResponse: string,
): ClassifiedResponse {
  const gate = gateType.toLowerCase().replace(/[_\s-]/g, "");
  const resp = rawResponse.toLowerCase();

  // ── Stripe ──
  if (gate === "stripe") {
    // Explicit success signals
    if (resp.includes("succeeded") || resp.includes("approved") ||
        resp.includes("cvv match") || resp.includes("cvv live") ||
        resp.includes("ccn live") || resp.includes("tokenized") ||
        resp.includes("auth ok") || resp.includes("setup ok")) {
      return { status: "live", response: rawResponse, code: "succeeded" };
    }
    // Check live decline codes
    for (const code of STRIPE_LIVE_CODES) {
      if (resp.includes(code.replace(/_/g, " ")) || resp.includes(code)) {
        return { status: "live", response: rawResponse, code };
      }
    }
    // Check dead codes
    for (const code of STRIPE_DEAD_CODES) {
      if (resp.includes(code.replace(/_/g, " ")) || resp.includes(code)) {
        return { status: "dead", response: rawResponse, code };
      }
    }
    if (resp.includes("processing_error") || resp.includes("processing error")) {
      return { status: "error", response: rawResponse, code: "processing_error" };
    }
    return { status: "dead", response: rawResponse, code: "unknown_decline" };
  }

  // ── Braintree ──
  if (gate === "braintree") {
    // Try 5-digit Braintree validation codes first (81706–81725) then 4-digit processor codes.
    const code5 = rawResponse.match(/\b(81\d{3})\b/)?.[1];
    const code4 = rawResponse.match(/\b(\d{4})\b/)?.[1];
    for (const code of [code5, code4].filter(Boolean) as string[]) {
      if (BRAINTREE_LIVE_CODES.has(code) || BRAINTREE_LIVE_RESPONSE_CODES.has(code)) {
        return { status: "live", response: rawResponse, code };
      }
      if (BRAINTREE_DEAD_RESPONSE_CODES.has(code)) {
        return { status: "dead", response: rawResponse, code };
      }
    }
    if (resp.includes("approved") || resp.includes("authorized") || resp.includes("authorised")) {
      return { status: "live", response: rawResponse, code: "1000" };
    }
    if (resp.includes("processor_declined") || resp.includes("settlement_declined")) {
      return { status: "dead", response: rawResponse, code: "2000" };
    }
    if (resp.includes("gateway_rejected") || resp.includes("failed")) {
      return { status: "error", response: rawResponse, code: "gateway_rejected" };
    }
    return { status: "dead", response: rawResponse, code: "declined" };
  }

  // ── PayPal ──
  if (gate === "paypal") {
    for (const kw of PAYPAL_LIVE_KEYWORDS) {
      if (resp.includes(kw.toLowerCase())) {
        return { status: "live", response: rawResponse, code: kw };
      }
    }
    for (const kw of PAYPAL_DEAD_KEYWORDS) {
      if (resp.includes(kw.toLowerCase())) {
        return { status: "dead", response: rawResponse, code: kw };
      }
    }
    if (resp.includes("error") || resp.includes("exception")) {
      return { status: "error", response: rawResponse, code: "paypal_error" };
    }
    return { status: "dead", response: rawResponse, code: "unknown_decline" };
  }

  // ── Square ──
  if (gate === "square") {
    for (const kw of SQUARE_LIVE_KEYWORDS) {
      if (resp.includes(kw.toLowerCase())) {
        return { status: "live", response: rawResponse, code: kw };
      }
    }
    for (const kw of SQUARE_DEAD_KEYWORDS) {
      if (resp.includes(kw.toLowerCase())) {
        return { status: "dead", response: rawResponse, code: kw };
      }
    }
    if (resp.includes("rate_limited") || resp.includes("internal_server_error")) {
      return { status: "error", response: rawResponse, code: "square_error" };
    }
    return { status: "dead", response: rawResponse, code: "unknown_decline" };
  }

  // ── Authorize.net ──
  if (gate === "authorizenet" || gate === "authorize.net" || gate === "authnet") {
    // Check response text
    for (const t of AUTHORIZE_NET_LIVE_TEXT) {
      if (resp.includes(t)) {
        return { status: "live", response: rawResponse, code: "approved" };
      }
    }
    for (const t of AUTHORIZE_NET_DEAD_TEXT) {
      if (resp.includes(t)) {
        return { status: "dead", response: rawResponse, code: "declined" };
      }
    }
    // Check reason codes
    const reasonMatch = rawResponse.match(/\b(reason[_\s]?code[:\s]+|response[_\s]?code[:\s]+)(\d+)/i);
    if (reasonMatch) {
      const code = reasonMatch[2];
      if (AUTHORIZE_NET_LIVE_REASON_CODES.has(code)) {
        return { status: "live", response: rawResponse, code };
      }
      if (code === "3") return { status: "error", response: rawResponse, code: "3" };
      return { status: "dead", response: rawResponse, code };
    }
    return { status: "dead", response: rawResponse, code: "unknown" };
  }

  // ── Adyen ──
  if (gate === "adyen") {
    for (const code of ADYEN_LIVE_CODES) {
      if (rawResponse.includes(code) || resp.includes(code.toLowerCase())) {
        return { status: "live", response: rawResponse, code };
      }
    }
    // Live soft-decline refusal reasons
    for (const reason of ADYEN_LIVE_REFUSAL) {
      if (resp.includes(reason.toLowerCase())) {
        return { status: "live", response: rawResponse, code: "soft_decline" };
      }
    }
    for (const code of ADYEN_DEAD_CODES) {
      if (rawResponse.includes(code) || resp.includes(code.toLowerCase())) {
        if (code === "Error") return { status: "error", response: rawResponse, code: "adyen_error" };
        return { status: "dead", response: rawResponse, code };
      }
    }
    return { status: "dead", response: rawResponse, code: "unknown" };
  }

  // ── Worldpay ──
  if (gate === "worldpay") {
    for (const code of WORLDPAY_LIVE_CODES) {
      if (rawResponse.includes(code) || resp.includes(code.toLowerCase())) {
        return { status: "live", response: rawResponse, code };
      }
    }
    for (const reason of WORLDPAY_LIVE_REASON) {
      if (resp.includes(reason)) {
        return { status: "live", response: rawResponse, code: "soft_decline" };
      }
    }
    for (const code of WORLDPAY_DEAD_CODES) {
      if (rawResponse.includes(code) || resp.includes(code.toLowerCase())) {
        if (code === "ERROR") return { status: "error", response: rawResponse, code: "worldpay_error" };
        return { status: "dead", response: rawResponse, code };
      }
    }
    return { status: "dead", response: rawResponse, code: "unknown" };
  }

  // ── Checkout.com ──
  if (gate === "checkoutcom" || gate === "checkout.com" || gate === "checkout_com") {
    for (const status of CHECKOUT_LIVE_STATUS) {
      if (rawResponse.includes(status) || resp.includes(status.toLowerCase())) {
        return { status: "live", response: rawResponse, code: status };
      }
    }
    for (const code of CHECKOUT_LIVE_RESPONSE) {
      if (rawResponse.includes(code)) {
        return { status: "live", response: rawResponse, code };
      }
    }
    for (const status of CHECKOUT_DEAD_STATUS) {
      if (rawResponse.includes(status) || resp.includes(status.toLowerCase())) {
        return { status: "dead", response: rawResponse, code: status };
      }
    }
    return { status: "dead", response: rawResponse, code: "unknown" };
  }

  // ── Klarna ──
  if (gate === "klarna") {
    for (const kw of KLARNA_LIVE) {
      if (resp.includes(kw.toLowerCase())) {
        return { status: "live", response: rawResponse, code: kw };
      }
    }
    for (const kw of KLARNA_DEAD) {
      if (resp.includes(kw.toLowerCase())) {
        return { status: "dead", response: rawResponse, code: kw };
      }
    }
    return { status: "dead", response: rawResponse, code: "unknown" };
  }

  // ── 2Checkout ──
  if (gate === "2checkout" || gate === "twocheckout") {
    for (const kw of TWOCHECKOUT_LIVE) {
      if (resp.includes(kw.toLowerCase())) {
        return { status: "live", response: rawResponse, code: kw };
      }
    }
    for (const kw of TWOCHECKOUT_DEAD) {
      if (resp.includes(kw.toLowerCase())) {
        return { status: "dead", response: rawResponse, code: kw };
      }
    }
    return { status: "dead", response: rawResponse, code: "unknown" };
  }

  // ── Generic fallback (handles any unknown gate type) ──
  for (const kw of GENERIC_LIVE_KEYWORDS) {
    if (resp.includes(kw)) {
      return { status: "live", response: rawResponse, code: kw };
    }
  }
  for (const kw of GENERIC_DEAD_KEYWORDS) {
    if (resp.includes(kw)) {
      return { status: "dead", response: rawResponse, code: kw };
    }
  }
  if (resp.includes("error") || resp.includes("exception") || resp.includes("timeout")) {
    return { status: "error", response: rawResponse, code: "unknown_error" };
  }

  return { status: "dead", response: rawResponse, code: "unknown" };
}
