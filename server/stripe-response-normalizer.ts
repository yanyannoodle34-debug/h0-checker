/**
 * Stripe response normalizer.
 *
 * Stripe-backed gates respond in at least 11 different wrapper shapes
 * depending on the integration (Stripe direct, WC checkout, WC Store API,
 * WP admin-ajax, GiveWP v2/v3, Charitable, Gravity Forms, WCPay, plus raw
 * HTML and edge-firewall pages). The downstream classifier in stripe-checker
 * was originally written against the native Stripe JSON shape and falls
 * through to keyword matching for everything else — which works most of the
 * time but mislabels nested-error responses.
 *
 * This module reduces all known shapes to a single canonical form so the
 * classifier only needs to think about one structure. Each wrapper has a
 * lightweight detector function that returns a normalized record (or null
 * if the shape doesn't match). The first non-null detector wins.
 *
 * Adding a new shape: write a detector, append it to DETECTORS. Each
 * detector is pure and side-effect-free so they're safe to reorder, though
 * earlier entries take precedence on ambiguous payloads.
 */

export type NormalizedSource =
  | "stripe-native"     // raw Stripe API response (PI, SI, error envelope)
  | "wc-checkout"       // WooCommerce classic checkout (?wc-ajax=checkout)
  | "wc-store-api"      // WC Blocks Store API (/wp-json/wc/store/v1/...)
  | "wc-order-rest"     // WooCommerce REST API order object (/wp-json/wc/v3/orders)
  | "wp-admin-ajax"     // WordPress admin-ajax envelope {success, data}
  | "wp-rest-donation"  // WordPress REST custom donation plugin response
  | "givewp-v2"         // GiveWP classic (give_process_donation)
  | "givewp-v3"         // GiveWP REST (/give-api/v2/donations)
  | "charitable"        // WordPress Charitable plugin
  | "gravity-forms"     // Gravity Forms Stripe addon
  | "wcpay"             // WooPayments / WCPay endpoint
  | "paypal"            // PayPal Capture / Orders API response
  | "custom-api"        // Custom WooCommerce donation/payment API wrapper
  | "html"              // raw HTML page (success redirect, captcha, etc.)
  | "unknown";          // didn't match any detector — caller falls back

export type NormalizedStatus =
  | "succeeded"         // payment completed, money moved
  | "requires_action"   // 3DS / OTP needed
  | "failed"            // declined or errored
  | "unknown";          // shape parsed but status not determinable

export interface NormalizedStripeResponse {
  /** Which wrapper format we detected — useful for logging + targeted fixes. */
  source: NormalizedSource;
  /** Coarse outcome. Maps to the existing classifier's three branches. */
  status: NormalizedStatus;
  /** Stripe-style decline_code if extractable (e.g. "insufficient_funds"). */
  code?: string;
  /** Human-readable error/success message. Plain text, HTML tags stripped. */
  message?: string;
  /** PaymentIntent / SetupIntent id when present (pi_... / seti_...). */
  intentId?: string;
  /** Charge id when payment completed (ch_...). */
  chargeId?: string;
  /** Stripe's next_action object verbatim — needed for 3DS rendering. */
  nextAction?: any;
  /** CVC check result if surfaced in the response. */
  cvcCheck?: "pass" | "fail" | "unchecked" | undefined;
  /** Original body for the keyword classifier + raw debug output. */
  raw: any;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function asString(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function findIntentId(s: string): string | undefined {
  const m = s.match(/\b(pi|seti)_[a-zA-Z0-9_]+/);
  return m?.[0];
}
function findChargeId(s: string): string | undefined {
  const m = s.match(/\bch_[a-zA-Z0-9]+/);
  return m?.[0];
}

/** Walk a nested object looking for the first leaf string that mentions a
 *  decline_code or message field name. Used as a last-ditch extraction when
 *  the wrapper shape is one we haven't catalogued. */
function deepFindMessage(obj: any, depth = 0): string | undefined {
  if (depth > 5 || obj == null) return undefined;
  if (typeof obj === "string") return obj.length > 1 && obj.length < 500 ? obj : undefined;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = deepFindMessage(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof obj !== "object") return undefined;
  // Prefer fields that are conventionally error text
  const priorityKeys = ["message", "detail", "error", "errorMessage", "userMessage", "description"];
  for (const k of priorityKeys) {
    const v = (obj as any)[k];
    if (typeof v === "string" && v.length > 1 && v.length < 500) return v;
  }
  for (const v of Object.values(obj)) {
    const found = deepFindMessage(v, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function deepFindCode(obj: any, depth = 0): string | undefined {
  if (depth > 5 || obj == null || typeof obj !== "object") return undefined;
  const direct = (obj as any).decline_code || (obj as any).declineCode || (obj as any).code;
  if (typeof direct === "string" && /^[a-z_]+$/.test(direct)) return direct;
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = deepFindCode(v, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

// ─── Detectors ───────────────────────────────────────────────────────────────
// Each detector returns a NormalizedStripeResponse if it recognizes the shape,
// or null otherwise. Order matters — most specific shapes first.

function detectStripeNative(body: any): NormalizedStripeResponse | null {
  if (!body || typeof body !== "object") return null;

  // PaymentIntent / SetupIntent — `status` field + pi_/seti_ id
  if (typeof body.status === "string" && typeof body.id === "string" && /^(pi|seti)_/.test(body.id)) {
    let status: NormalizedStatus = "unknown";
    if (body.status === "succeeded") status = "succeeded";
    else if (body.status === "requires_action" || body.status === "requires_source_action") status = "requires_action";
    else if (body.status === "requires_payment_method" || body.status === "canceled") status = "failed";

    const lastErr = body.last_payment_error || body.last_setup_error;
    const code = lastErr?.decline_code || lastErr?.code;
    const message = lastErr?.message;
    const cvcCheck =
      body.payment_method?.card?.checks?.cvc_check
      || body.latest_charge?.payment_method_details?.card?.checks?.cvc_check
      || lastErr?.payment_method?.card?.checks?.cvc_check;

    const chargeId =
      (typeof body.latest_charge === "string" && body.latest_charge.startsWith("ch_")) ? body.latest_charge :
      (body.latest_charge?.id && String(body.latest_charge.id).startsWith("ch_")) ? body.latest_charge.id :
      undefined;

    return {
      source: "stripe-native",
      status, code, message,
      intentId: body.id, chargeId,
      nextAction: body.next_action,
      cvcCheck,
      raw: body,
    };
  }

  // Bare Stripe error envelope: { error: { code, decline_code, message, type } }
  if (body.error && typeof body.error === "object" && (body.error.code || body.error.type)) {
    const e = body.error;
    return {
      source: "stripe-native",
      status: "failed",
      code: e.decline_code || e.code,
      message: e.message,
      cvcCheck: e.payment_method?.card?.checks?.cvc_check,
      raw: body,
    };
  }
  return null;
}

function detectWCStoreApi(body: any): NormalizedStripeResponse | null {
  // Shape: { code: "...", message: "...", data: { status: 4xx } }
  if (
    body && typeof body === "object"
    && typeof body.code === "string"
    && typeof body.message === "string"
    && body.data && typeof body.data.status === "number"
  ) {
    return {
      source: "wc-store-api",
      status: body.data.status >= 200 && body.data.status < 300 ? "succeeded" : "failed",
      code: body.code,
      message: stripHtml(body.message),
      raw: body,
    };
  }
  return null;
}

function detectWCCheckout(body: any): NormalizedStripeResponse | null {
  // Shape: { result: "failure"|"success", messages?: html, redirect?: url }
  if (body && typeof body === "object" && (body.result === "failure" || body.result === "success")) {
    const status: NormalizedStatus = body.result === "success" ? "succeeded" : "failed";
    const rawMsg = body.messages || body.message || body.error || "";
    const message = stripHtml(asString(rawMsg));
    const code = deepFindCode(body);
    return {
      source: "wc-checkout",
      status, code, message,
      raw: body,
    };
  }
  return null;
}

function detectWCPay(body: any): NormalizedStripeResponse | null {
  // WooPayments wraps stripe errors in: { data: { errors: { code: ["msg"] } } }
  if (body?.data?.errors && typeof body.data.errors === "object" && !Array.isArray(body.data.errors)) {
    const errors = body.data.errors;
    const firstKey = Object.keys(errors)[0];
    if (firstKey) {
      const firstVal = errors[firstKey];
      const message = Array.isArray(firstVal) ? stripHtml(asString(firstVal[0])) : stripHtml(asString(firstVal));
      return {
        source: "wcpay",
        status: "failed",
        code: firstKey,
        message,
        raw: body,
      };
    }
  }
  return null;
}

function detectGiveWPv3(body: any): NormalizedStripeResponse | null {
  // GiveWP v3 REST: { data: object|null, errors: [{ source?, detail, status?, code? }] }
  if (body && typeof body === "object" && Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    if (first && (first.detail || first.source)) {
      const message = stripHtml(asString(first.detail || first.title || ""));
      const code = first.code || deepFindCode(body);
      return {
        source: "givewp-v3",
        status: "failed",
        code,
        message,
        raw: body,
      };
    }
  }
  // Success: { data: { ... }, errors: null|[] } with data.status === "complete"
  if (body?.data?.status === "complete" || body?.data?.gateway_response === "succeeded") {
    return {
      source: "givewp-v3",
      status: "succeeded",
      message: "Donation complete",
      raw: body,
    };
  }
  return null;
}

function detectGiveWPv2(body: any): NormalizedStripeResponse | null {
  // GiveWP classic admin-ajax: { success: false, data: { errors: [{message}] | message } }
  if (body && typeof body === "object" && typeof body.success === "boolean") {
    // Must look like a GiveWP shape, not a plain WP admin-ajax (handled separately)
    const looksLikeGive =
      body.data?.errors
      || body.data?.give_errors
      || (typeof body.data === "object" && (body.data?.message?.match?.(/give|donat/i) || body.data?.donation_id));
    if (!looksLikeGive) return null;

    if (body.success === true) {
      return {
        source: "givewp-v2",
        status: "succeeded",
        message: stripHtml(asString(body.data?.message || "Donation complete")),
        raw: body,
      };
    }
    const errs = body.data?.errors || body.data?.give_errors;
    const message = Array.isArray(errs)
      ? stripHtml(asString(errs[0]?.message || errs[0]))
      : stripHtml(asString(errs || body.data?.message || body.data));
    const code = deepFindCode(body);
    return {
      source: "givewp-v2",
      status: "failed",
      code,
      message,
      raw: body,
    };
  }
  return null;
}

function detectCharitable(body: any): NormalizedStripeResponse | null {
  // Charitable: { valid: bool, errors: ["..."] | string } or {success, errors}
  if (body && typeof body === "object" && (typeof body.valid === "boolean" || body.charitable_action)) {
    if (body.valid === true || body.donation_id || body.success === true) {
      return { source: "charitable", status: "succeeded", message: "Donation accepted", raw: body };
    }
    const errs = body.errors;
    const message = Array.isArray(errs) ? stripHtml(asString(errs[0])) : stripHtml(asString(errs || ""));
    return {
      source: "charitable",
      status: "failed",
      code: deepFindCode(body),
      message,
      raw: body,
    };
  }
  return null;
}

function detectGravityForms(body: any): NormalizedStripeResponse | null {
  // Gravity Forms typically returns { is_valid: bool, confirmation_message?: html,
  //                                   validation_messages?: { fieldId: "..." } }
  if (body && typeof body === "object" && (typeof body.is_valid === "boolean" || body.confirmation_message)) {
    if (body.is_valid === true || body.confirmation_message) {
      const confirmText = stripHtml(asString(body.confirmation_message || ""));
      return { source: "gravity-forms", status: confirmText ? "succeeded" : "unknown", message: confirmText, raw: body };
    }
    const msgs = body.validation_messages;
    const message = msgs && typeof msgs === "object"
      ? Object.values(msgs).map(v => stripHtml(asString(v))).filter(Boolean).join(" · ")
      : stripHtml(asString(body.message || ""));
    return {
      source: "gravity-forms",
      status: "failed",
      code: deepFindCode(body),
      message,
      raw: body,
    };
  }
  return null;
}

function detectWPAdminAjax(body: any): NormalizedStripeResponse | null {
  // Generic WP admin-ajax envelope: { success: bool, data: any }
  // Catches plugins that don't fit other detectors. Lower priority than
  // GiveWP/Charitable/GF because those are admin-ajax variants we want to
  // tag specifically.
  if (body && typeof body === "object" && typeof body.success === "boolean") {
    if (body.success === true) {
      return {
        source: "wp-admin-ajax",
        status: "succeeded",
        message: stripHtml(asString(body.data?.message || body.data?.redirect || "")) || undefined,
        raw: body,
      };
    }
    const message = stripHtml(asString(body.data?.message || body.data?.error || body.data || ""));
    return {
      source: "wp-admin-ajax",
      status: "failed",
      code: deepFindCode(body),
      message,
      raw: body,
    };
  }
  return null;
}

function detectWCOrderRest(body: any): NormalizedStripeResponse | null {
  // WooCommerce REST API order object: numeric id, string status ("processing",
  // "completed", "failed" …), payment_method string, total string, billing obj.
  if (
    body && typeof body === "object"
    && typeof body.id === "number"
    && typeof body.status === "string"
    && typeof body.payment_method === "string"
    && typeof body.total === "string"
  ) {
    const wcStatus = body.status as string;
    let status: NormalizedStatus = "unknown";
    if (wcStatus === "completed" || wcStatus === "processing") status = "succeeded";
    else if (wcStatus === "failed" || wcStatus === "cancelled" || wcStatus === "refunded") status = "failed";
    else if (wcStatus === "on-hold") status = "requires_action";

    // transaction_id may hold a pi_ / ch_ reference
    const txnId: string = typeof body.transaction_id === "string" ? body.transaction_id : "";
    const intentId = findIntentId(txnId) || findIntentId(String(body.id));
    const chargeId = findChargeId(txnId);

    return {
      source: "wc-order-rest",
      status,
      code: wcStatus !== "completed" && wcStatus !== "processing" ? wcStatus : undefined,
      message: body.customer_note || body.payment_method_title || undefined,
      intentId, chargeId,
      raw: body,
    };
  }
  return null;
}

function detectPayPal(body: any): NormalizedStripeResponse | null {
  // PayPal Orders/Capture API: uppercase COMPLETED/APPROVED status, intent field,
  // purchase_units array, payer object. The id is a PayPal-style alphanumeric string.
  if (
    body && typeof body === "object"
    && typeof body.id === "string"
    && (body.intent === "CAPTURE" || body.intent === "AUTHORIZE" || body.intent === "ORDER")
    && Array.isArray(body.purchase_units)
  ) {
    const ppStatus = (body.status as string || "").toUpperCase();
    let status: NormalizedStatus = "unknown";
    if (ppStatus === "COMPLETED") status = "succeeded";
    else if (ppStatus === "APPROVED" || ppStatus === "PAYER_ACTION_REQUIRED") status = "requires_action";
    else if (ppStatus === "VOIDED" || ppStatus === "FAILED") status = "failed";

    const unit = body.purchase_units?.[0];
    const amount = unit?.amount ? `${unit.amount.value} ${unit.amount.currency_code}` : undefined;
    const email = body.payer?.email_address;

    return {
      source: "paypal",
      status,
      code: ppStatus !== "COMPLETED" ? ppStatus.toLowerCase() : undefined,
      message: amount ? `PayPal ${ppStatus} — ${amount}${email ? ` · ${email}` : ""}` : undefined,
      raw: body,
    };
  }
  return null;
}

function detectWPRestDonation(body: any): NormalizedStripeResponse | null {
  // WordPress REST custom donation plugin: { success, donation_id, amount, status,
  // donor: { name, email }, message }. Discriminator: numeric donation_id + donor obj.
  if (
    body && typeof body === "object"
    && typeof body.donation_id === "number"
    && body.donor && typeof body.donor === "object"
  ) {
    const donStatus = (body.status as string || "").toLowerCase();
    let status: NormalizedStatus = "unknown";
    if (donStatus === "completed" || donStatus === "success" || body.success === true) status = "succeeded";
    else if (donStatus === "failed" || donStatus === "error" || body.success === false) status = "failed";

    return {
      source: "wp-rest-donation",
      status,
      message: stripHtml(asString(body.message || body.status || "")),
      raw: body,
    };
  }
  return null;
}

function detectCustomApi(body: any): NormalizedStripeResponse | null {
  // Custom WooCommerce donation/payment API: { success, type, gateway,
  // transaction_id, order_id, amount, status, customer: { name, email } }.
  // Discriminator: must have both gateway AND (customer obj OR order_id).
  if (
    body && typeof body === "object"
    && typeof body.gateway === "string"
    && (typeof body.order_id === "number" || (body.customer && typeof body.customer === "object"))
  ) {
    const apiStatus = (body.status as string || "").toLowerCase();
    let status: NormalizedStatus = "unknown";
    if (apiStatus === "completed" || apiStatus === "success" || body.success === true) status = "succeeded";
    else if (apiStatus === "failed" || apiStatus === "error" || body.success === false) status = "failed";

    // Extract pi_ / ch_ from transaction_id if it's stripe-format
    const txn = typeof body.transaction_id === "string" ? body.transaction_id : "";
    const intentId = findIntentId(txn);
    const chargeId = findChargeId(txn);

    return {
      source: "custom-api",
      status,
      code: txn && !intentId ? txn : undefined,  // non-Stripe txn_id as code
      message: body.message || undefined,
      intentId, chargeId,
      raw: body,
    };
  }
  return null;
}

function detectHtml(body: any): NormalizedStripeResponse | null {
  // String body that's clearly HTML — let downstream keyword classifier handle
  // success-page / captcha / generic-text matching.
  if (typeof body === "string" && /<\/?(html|head|body|div|form|input)/i.test(body)) {
    const intentId = findIntentId(body);
    const chargeId = findChargeId(body);
    let status: NormalizedStatus = "unknown";
    const low = body.toLowerCase();
    if (low.includes("thank you") || low.includes("payment success") || low.includes("order received")) status = "succeeded";
    else if (low.includes("requires_action") || low.includes("3d secure") || low.includes("3ds")) status = "requires_action";
    else if (low.includes("declined") || low.includes("error") || low.includes("could not be processed")) status = "failed";
    return {
      source: "html",
      status,
      intentId, chargeId,
      message: undefined,           // keep raw for keyword classifier
      raw: body,
    };
  }
  return null;
}

const DETECTORS: Array<(body: any) => NormalizedStripeResponse | null> = [
  // Most specific shapes first — Stripe native is the only one with a pi_/seti_ id
  detectStripeNative,
  // WC REST API order: numeric id + payment_method + total (before WC checkout which is vaguer)
  detectWCOrderRest,
  // PayPal: intent field + purchase_units array
  detectPayPal,
  // WC Store API has a unique 3-field shape
  detectWCStoreApi,
  // WC classic has unique result:"success|failure"
  detectWCCheckout,
  // WCPay has nested data.errors object
  detectWCPay,
  // GiveWP v3 has top-level errors array with detail field
  detectGiveWPv3,
  // GiveWP v2 has admin-ajax shape with give-specific markers
  detectGiveWPv2,
  // Charitable has valid + errors fields
  detectCharitable,
  // Gravity Forms has is_valid + confirmation_message
  detectGravityForms,
  // Custom donation API: gateway + customer/order_id (before generic WP admin-ajax)
  detectCustomApi,
  // WP REST custom donation: donation_id + donor obj (before generic WP admin-ajax)
  detectWPRestDonation,
  // Generic WP admin-ajax catches anything else with {success, data}
  detectWPAdminAjax,
  // Raw HTML
  detectHtml,
];

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Normalize a Stripe-backed response into the canonical shape. Returns a
 * NormalizedStripeResponse with source="unknown" if no detector matches —
 * the classifier's keyword fallback path then handles it as before.
 *
 * Inputs:
 *   body         — parsed JSON object, raw string, or null
 *   contentType  — optional, used as a tiebreaker for ambiguous JSON-ish strings
 */
export function normalizeStripeResponse(body: any, _contentType?: string): NormalizedStripeResponse {
  // String that's likely JSON — try parsing once before the detectors run
  if (typeof body === "string") {
    const trimmed = body.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        for (const d of DETECTORS) {
          const hit = d(parsed);
          if (hit) return hit;
        }
      } catch { /* fall through to string detectors */ }
    }
  }

  for (const d of DETECTORS) {
    const hit = d(body);
    if (hit) return hit;
  }

  // Unknown shape — best-effort extraction via deep walk, so the classifier
  // at least has a code/message to feed the keyword path.
  const message = typeof body === "string" ? body.slice(0, 500) : deepFindMessage(body);
  const code = typeof body === "object" ? deepFindCode(body) : undefined;
  const text = typeof body === "string" ? body : asString(body);
  return {
    source: "unknown",
    status: "unknown",
    code, message,
    intentId: findIntentId(text),
    chargeId: findChargeId(text),
    raw: body,
  };
}
